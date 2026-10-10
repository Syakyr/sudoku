# Changelog

Notable changes per release. Release tags are frozen snapshots of the bundled
Android APK; the PWA rolls from `main` continuously, so this is also the record
of what bundled users are and are not getting.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions are the tags themselves.

---

## [v0.3.0] — Material You

### Added
- **Material You dynamic color (Android 12+).** The app can now derive its whole
  palette from the wallpaper seed. Reached through a new native `DynamicTheme`
  plugin exposed over the Capacitor bridge — the WebView cannot read native colors.
- **MIT license.**

### Changed
- **The win screen names the seed, not the mistake count.**
  `Solved in 4:12 — 3 mistakes` → `0QG3XFW solved in 4:12`. Mistakes are still
  recorded on the puzzle for difficulty calibration (issue #1); they are just no
  longer displayed on the one screen that should be a win.
- **README restructured** — centered header with the logo, title and subtitle on
  separate lines, and a badge row. Deep content moved out to
  `docs/DIFFICULTY.md` and `docs/DEVELOPMENT.md` rather than deleted.
- **Layout section is now a directory tree** with an engine / persistence /
  presentation layer table, replacing a flat list whose column padding had drifted.

### Fixed
- **The "Filled" chip could never read full.** The numerator counted only
  user-entered cells while the denominator was a hardcoded `81`, so a solved
  board topped out at `(81 − clues)/81`. Both sides now use the same quantity:
  blanks filled over blanks to fill.

### Notes on the Material You design
Only the **seed hue** is taken from the system. The app's four hand-tuned themes
are HSL with a consistent saturation/lightness recipe per mode, so regenerating
from the hue reuses a recipe whose contrast was chosen deliberately — importing
Material's raw ARGB values and tinting them would produce unreadable pencil
marks. A WCAG contrast guard is applied on top, and the option is **opt-in**: a
theme the user picked is never overridden by a wallpaper. The swatch only appears
where the plugin reports support.

**Unverified on hardware.** The JS derivation half is covered by 19 tests
including a 36-hue contrast sweep, but the native half has not been run on a real
Android 12+ device. If the `system_accent1_500` platform resource cannot be
resolved, the plugin reports unsupported and the swatch is never shown — a safe
failure, but it would mean the feature is inert rather than wrong.

The Material Components dependency was dropped in favour of the **platform**
Material You palette resources (`android.R.color.system_accent1_*`, API 31+),
looked up by name at runtime via `getIdentifier()`. Smaller APK, one less
versioned dependency, and a missing resource degrades gracefully instead of
failing the build.

---

## [v0.2.5] — the version stamp reaches the APK

### Fixed
- **A packaged app could display a version that was not the one it shipped.**
  The version-stamp step ran *after* `cap sync`, which is what copies the web
  bundle into the native project — so the stamped file never made it into the
  APK. v0.2.4 shipped `APP_VERSION '0.2.3'` while the CI log reported stamping
  0.2.4. The stamp now runs before assembly.
- **The stamp no longer fails when the committed value is already correct.** Both
  guards tested "did the text change?" instead of "does the pattern exist?", so a
  no-op replace was read as a missing field and failed the build.

### Added
- **Version and storage channel visible in Settings → About** —
  `Sudoku v0.2.5 · library stored on this device`. Neither was visible before,
  and both are the first things needed when a problem is reported.

---

## [v0.2.4] — WITHDRAWN

Published and then removed. Shipped with the version-display bug fixed in v0.2.5:
every installer would have seen "v0.2.3" in Settings → About. `versionCode` was
correct (2004) and the app worked; the release was pulled so nobody would pick it
up.

---

## [v0.2.3] — the library cannot be evicted

### Changed
- **The puzzle library moved from WebView `localStorage` to native
  `@capacitor/preferences`.** Capacitor's own guide classifies WebView storage as
  transient: *"the OS will reclaim local storage from Web Views if a device is
  running low on space."* The whole library is one document, so that reclaim is a
  user's data vanishing.
- Existing `localStorage` data is **migrated up on first launch** — an upgraded
  app keeps its library.
- Boot **converges on the newest document by `updatedAt`**, so a wiped or
  rolled-back native store cannot silently lose a fresher session.
- Writes are **mirrored to `localStorage` synchronously** as well. Not redundant:
  the mirror is durable immediately, which closes the write-behind gap if the
  process dies mid-write. Native is the eviction-proof copy; the mirror is the
  crash-proof one.
- The store keeps a **synchronous API**, so none of its 24 call sites changed —
  `openStorage()` hands back a `localStorage`-shaped backend.

### Notes
No bundler is involved. The plugin is reached through the `window.Capacitor`
global bridge rather than an `import`, verified against `@capacitor/core`'s bridge
source: native dispatch is driven by `cap.PluginHeaders`, which the native side
populates. The npm package is used only by `cap sync` to install the Android code.

---

## [v0.2.2] — first eviction mitigation

### Added
- **`navigator.storage.persist()`** requested at startup in both channels.
  Capacitor's guide is explicit that WebView storage is transient and the OS
  reclaims it under space pressure; nothing previously asked for persistence.
  Heuristic, not a guarantee — the result is surfaced rather than assumed.
  Superseded in substance by v0.2.3, but kept: it costs nothing and still covers
  the browser path.

### Fixed
- **The drift badge now recomputes on tag pushes**, so it stops reporting a stale
  release immediately after one is cut.

---

## [v0.2.1] — status bar overlap

### Fixed
- **The app drew under the Android status bar.** targetSdk 36 forces edge-to-edge
  rendering and Capacitor's `CapacitorWebView` imports `WindowInsetsCompat`
  without applying it. Fixed natively with `android:fitsSystemWindows="true"` on
  the root `CoordinatorLayout`.
- **`.bar` and `.foot` had no safe-area handling at all** — the reason the old TWA
  had to run `standalone` rather than fullscreen. Both now grow by the inset.
  No-ops where `env(safe-area-inset-*)` resolves to 0, which it does in Android
  WebView.

### Changed
- CI no longer runs on tag pushes, which had been duplicating the release's own
  test job.

---

## [v0.2.0] — TWA → bundled Capacitor APK

**The structural change of the project.** Package id changed from
`com.syakyr.sudoku.twa` (v0.1.0, per its tag message) to `com.syakyr.sudoku`.

### Changed
- **The APK now contains the app.** A Bubblewrap TWA ships zero app code — it is
  a signed shortcut that launches a URL, which made GitHub Pages a hard runtime
  dependency and meant a release tag froze nothing. Capacitor packs the web bundle
  into `assets/public/`, so a tag is a real snapshot and the app works offline
  after install.
- **Two channels, explicitly:** the PWA rolls from `main`; the APK moves only on
  a tag. A drift badge tracks how far apart they are.
- The service worker is **disabled inside the APK** — it would cache files that
  are already local and cannot change. Enforced by tests, not by a comment.
- The build is gated on the test suite inside the release workflow, so a failing
  suite cannot produce a release.
- Toolchain pinned: Node 26.11.1, JDK 21, Capacitor 8.5.3.
- Launcher icons and splash generated from the app's own art.

### Breaking
- **One-time data break.** The TWA stored its library in Chrome's profile under
  the `syakyr.github.io` origin. The Capacitor app is a different package with a
  different origin and its own data directory, so the library starts empty. The
  old data is not lost — it remains in the PWA and is recoverable via
  export/import.
- `assetlinks.json` was removed from the GitHub Pages site; digital asset links
  were a TWA mechanism and are meaningless now.

---

## [v0.1.0] — first Android release

A Bubblewrap Trusted Web Activity wrapping the deployed PWA. Superseded by v0.2.0.
See `docs/archive/ANDROID-TWA.md` for the measured Bubblewrap behaviour.
