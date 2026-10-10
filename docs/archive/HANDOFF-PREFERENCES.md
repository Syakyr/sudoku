# HANDOFF — `@capacitor/preferences` migration

> **COMPLETED 2026-10-10 in v0.2.3.** Kept as a record of the reasoning and
> the measured scope. Implemented as recommended here: load-at-boot /
> write-through, `store.js` unchanged, all 24 `app.js` call sites untouched.
>
> One deviation worth knowing: the plan assumed importing the JS package. This
> project has no bundler, so the JS reaches the plugin through the Capacitor
> global bridge instead (`cap.nativePromise` + `cap.PluginHeaders`), verified
> against `@capacitor/core`'s bridge source. The npm package is used only by
> `cap sync` to install the Android side.
>
> Shipped as: `js/native-storage.js`, wired in `js/app.js`, 17 tests in
> `tests/native-storage.test.js`. Verified in the released APK:
> `com/capacitorjs/plugins/preferences/PreferencesPlugin` present in
> classes.dex, `versionCode 2003`.

---

Written 2026-10-10, after v0.2.2 shipped. Deliberately deferred to a fresh
session: it is a real refactor, not a one-liner, and it was the cheaper
mitigation (`navigator.storage.persist()`) that got done instead.

---

## TL;DR

The puzzle library lives in **one `localStorage` document**
(`sudoku.library.v1`). In a Capacitor WebView that storage is **explicitly
transient** — the OS reclaims it under space pressure. v0.2.2 added
`navigator.storage.persist()`, which is the cheap signal but **heuristic, not
a guarantee**. Migrating to `@capacitor/preferences` puts the data in a
native key/value store that is not subject to WebView eviction.

**The cost is synchronous → asynchronous.** That is the whole job.

---

## 1. Why this is still worth doing

Capacitor's own storage guide, verbatim:

> *"Local Storage can be used for small amounts of temporary data, such as a
> user id, but **must be considered transient**, meaning your app needs to
> expect that the data will be lost eventually. This is because the OS will
> reclaim local storage from Web Views if a device is running low on space."*

Our whole library is that document. Reclaim = a user's puzzles vanish with no
warning and no way back except a backup they may not have taken.

**What v0.2.2 already bought** (`requestPersistentStorage()` in `js/app.js`):
`navigator.storage.persist()` opts the origin out of eviction on Android. It
is granted heuristically and varies by device/OEM. The function surfaces the
result and `console.warn`s when the library is still reclaimable — so you can
tell from the console whether the current device is covered.

**Quota is NOT the problem.** Measured, not estimated:

```
bytes/puzzle record : 792
fits in 5 MiB      : ~6,600 puzzles
```

Nobody is going to hit quota. Eviction is the failure mode.

---

## 2. Scope — measured, so you can size it before starting

| Surface | Count |
|---|---|
| `store.*` call sites in `js/app.js` | **24** |
| Distinct store methods used by app.js | 15 |
| Methods `store.js` exposes | ~16 + `save` / `reload` |

Methods in use: `abandon`, `addPuzzle`, `allPuzzles`, `byStatus`, `clearAll`,
`complete`, `doc`, `exportAll`, `findDuplicate`, `getPuzzle`, `importAll`,
`inMemory`, `remove`, `setMeta`, `updateProgress`.

### The two genuinely awkward ones

- **`store.doc`** — synchronous property access to the whole document. Under
  an async backend this cannot stay a property. Either preload the doc into
  memory at boot and treat writes as write-through, or convert every reader.
- **`store.inMemory`** — a sync flag checked at `app.js:81` to warn the user
  that nothing is being persisted. Survives fine, but its meaning widens:
  "native store unavailable, fell back to memory".

### The approach that probably works

**Load-at-boot, write-through.** Keep `store.js`'s synchronous API intact by
loading the whole document into memory once at startup (it's small — 792 B per
puzzle), and make `save()` fire an async write to Preferences that the caller
does not await. Reads stay synchronous; writes become durable-but-eventual.

That means:
- **No changes to the 24 call sites.** Big win.
- `save()` returns nothing and kicks off `Preferences.set(...)` in the
  background.
- Risk to design for: a crash between the in-memory mutation and the native
  write loses one operation, not the library. Decide whether to await on
  critical paths (import, complete) and not on high-frequency ones
  (`updateProgress` fires on every keystroke-ish).
- Boot must `await Preferences.get(...)` before the app renders. That is a
  one-time async boundary at startup, not a refactor of every caller.

This is the shape to argue with first before doing a full async conversion.

---

## 3. Decisions to make before writing code

1. **Migrate existing data, or start clean?** A user with data in
   `localStorage` must be copied into Preferences on first launch, or they
   lose it. Recommended: read localStorage first; if present and Preferences
   is empty, copy, then **keep reading localStorage as a fallback for one
   release** before dropping it. Do not just switch over.
2. **Keep the PWA path working.** `localStorage` is still correct for the
   browser. `@capacitor/preferences` falls back to `localStorage` when
   running as a PWA, which makes the same code path work in both — verify
   that fallback rather than trusting it.
3. **Do we need encryption?** Preferences is not encrypted. If the library
   ever holds anything sensitive it does not, so probably no — but say so
   explicitly rather than by omission.
4. **Does `persist()` stay?** Yes — it costs nothing and covers the browser
   path. Keep it regardless.

---

## 4. Gotchas already paid for (do not re-derive)

- **`store.js` takes an injectable `storage` object** (`createStore({ storage,
  canonMode, now })`), and falls back to an in-memory Map if unavailable.
  That is the seam to use — do not fork the store for native.
- **`SCHEMA_VERSION` + `migrate()` already exist** and are tested. `migrate()`
  normalises junk records rather than throwing. If the Preferences migration
  bumps the schema, extend `migrate()` rather than adding a second path.
- **`sw.js` CACHE must be bumped whenever `js/` or `css/` changes**, or a
  returning PWA visitor gets the old shell on the first load and the new one
  only on the second. Currently `sudoku-shell-v5`.
- **The service worker must NOT register in the packaged app** — Capacitor
  serves from a local `https://localhost`, so the old protocol-only guard let
  it through. Enforced by `tests/native-sw-suppressed.test.js`. Do not
  "simplify" that guard.
- **Tests are split by process on purpose.** `native-sw-suppressed` and
  `pwa-sw-registers` are separate files because they assert import-time side
  effects and must not share a process. Follow that pattern if adding
  boot-time assertions.
- **`tools/build-dist.mjs` uses an allowlist** for what goes into the bundle,
  and fails the build on forbidden paths (`sw.js`, `node_modules`, `tests`,
  …). If the migration adds a runtime file, add it to `BUNDLE` or it will
  not ship.

---

## 5. Current state when this was written

| | |
|---|---|
| Latest release | **v0.2.2** (bundled Capacitor APK) |
| Package | `com.syakyr.sudoku` |
| Signing | unchanged `sudoku-twa` key, `9A:C3:E1:86:...:28:4B:DB` |
| Toolchain | Node 26.11.1 · JDK 21 · Capacitor 8.5.3 |
| Tests | 84 pass / 0 fail |
| minSdk | 24 (Android 7.0) |
| versionCode ladder | v0.2.2 = 2002. Next: v0.2.3 = 2003, v0.3.0 = 3000 |

Recent releases and what they were:

- **v0.2.0** — first bundled Capacitor APK (was a Bubblewrap TWA)
- **v0.2.1** — fixed the app drawing under the status bar
  (`android:fitsSystemWindows="true"`)
- **v0.2.2** — `navigator.storage.persist()` so the library is not evictable

Docs: `README.md` has the two-channel model (rolling PWA vs tagged bundled
APK). `docs/archive/ANDROID-TWA.md` is the superseded TWA guide, kept
because it records measured Bubblewrap behaviour.

---

## 6. Suggested first move

Do **not** start by installing the plugin. Start by writing the failing test
for the thing that actually matters: *"a user with data in localStorage still
has it after the migration, in both the PWA and the packaged app."* Then
build the load-at-boot / write-through shim to satisfy it. The store already
takes an injected backend, so the test is cheap and the seam already exists.
