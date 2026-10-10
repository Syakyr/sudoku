# Development, building and releasing

Extracted from the README.

## Local development

```bash
npm install     # jsdom, dev-only (the shipped app has zero runtime dependencies)
npm test        # node --test tests/
npm run serve   # python3 -m http.server 8080  → http://localhost:8080
```

ES modules need `http://`, not `file://` — use `npm run serve` locally.

## Visual check

`tools/pw-check.mjs` drives real Chromium across desktop / mobile / landscape and
asserts no overflow, working drawer, rendered text and a clean console:

```bash
LD_LIBRARY_PATH=/home/linuxbrew/.linuxbrew/lib \
FONTCONFIG_PATH=/home/linuxbrew/.linuxbrew/etc/fonts \
node tools/pw-check.mjs http://localhost:8080 ~/shots
```

Both env vars are mandatory on this host: without `LD_LIBRARY_PATH` Chromium
cannot load its shared libs, and without `FONTCONFIG_PATH` it finds no fonts and
renders **every glyph blank** — a screenshot that looks structurally fine but has
no text. Exit code is non-zero if any check fails.

## Deploying the PWA to GitHub Pages

`.github/workflows/ci.yml` runs the test suite on every push and PR, and on
pushes to `main` publishes the repo root as a Pages site (no build step — the
artifact is just the static files). Enable **Settings → Pages → Source: GitHub
Actions** once, then push.

---

## The Android APK

Capacitor wraps the same static bundle — the APK contains the app, it is not a
bookmark. Toolchain: **Node 26.11.1 · JDK 21 · Capacitor 8.5.3 ·
@capacitor/preferences 7.0.4**, minSdk 24 (Android 7.0).

### Cutting a release

```bash
git tag -a v0.2.3 -m "..."
git push origin v0.2.3
```

`.github/workflows/android-apk.yml` then runs the test suite, builds, signs and
publishes the GitHub Release. Nothing else needs doing.

- **`versionCode` is derived from the tag**: `major*1e6 + minor*1e3 + patch`
  (v0.2.3 → 2003). Verified monotonic across the awkward boundaries
  (0.9.9 → 9009, 0.10.0 → 10000, 1.0.0 → 1000000).
- **Do not ship a pre-release suffix** (`v1.0.0-rc`). The derivation ignores it,
  so `v1.0.0-rc` and `v1.0.0` collide on the same versionCode.
- **`js/version.js` is overwritten from the tag** during the build, so a packaged
  app can never display a version that disagrees with what shipped.
- Secrets: `TWA_KEYSTORE_BASE64`, `TWA_KEYSTORE_PASSWORD`, `TWA_KEY_PASSWORD`.
  The keystore is canonical and unchanged since the TWA era — rotating it breaks
  upgrade-in-place for every installed copy.

### Verifying a release actually shipped what you think

Worth doing every time; the checks have caught real things:

```bash
gh release view v0.2.3 --json assets
gh run view <id> --log | grep -E 'versionCode +[0-9]'   # stamped value, not the echo
unzip -l sudoku.apk | grep assets/public/               # bundle contents
unzip -l sudoku.apk | grep -c 'assets/public/sw.js'     # must be 0
strings classes*.dex | grep preferences                 # native plugin compiled in
```

### Gotchas already paid for

- **`sw.js` must never be in the APK.** The service worker is the PWA's rolling
  update mechanism; inside a frozen bundle it caches files that are already local
  and cannot change. Enforced by `tests/native-sw-suppressed.test.js`.
- **`tools/build-dist.mjs` assembles the bundle from an explicit allowlist** and
  fails the build on forbidden paths. A new runtime file that is not under a
  allowlisted directory will simply not ship.
- **`sw.js` `CACHE` must be bumped whenever `js/` or `css/` changes**, or a
  returning PWA visitor gets the old shell on the first load and the new one
  only on the second.
- **`env(safe-area-inset-*)` resolves to 0 in Android WebView.** The status-bar
  inset is handled natively (`android:fitsSystemWindows="true"`), not in CSS.
- **No bundler.** The app ships raw ES modules, so a bare
  `import '@capacitor/...'` cannot resolve at runtime. Native plugins are reached
  through the `window.Capacitor` bridge instead.
- **`bubblewrap init` in Docker writes root-owned files into the repo.** Only
  relevant if the native project is ever regenerated that way.

---

## Test layout

Tests are split by process deliberately. Several assert **import-time side
effects** of `js/app.js`, and Node caches modules per specifier — putting two
conflicting boots in one file produced double `load` events and a wedged event
loop. Use `tests/helpers/app-env.mjs` and one file per boot shape.
