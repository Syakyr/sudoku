Android wrapper for the PWA, built with [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) as a Trusted Web Activity.

**This is a wrapper, not a port.** The app itself is the same web app at https://syakyr.github.io/sudoku/ — the APK launches it full-screen with no browser UI and provides an app icon, a share target and an update channel. All puzzle generation, solving and storage stay in the web layer.

## Installing from here (Obtainium)

Add this repository in Obtainium and it will track the latest release's `sudoku-twa-*.apk` asset. Sideloading unknown sources must be permitted for Obtainium.

If the app opens with a browser URL bar showing instead of full-screen, the domain has not been verified — see `ANDROID-TWA.md` in the repo.
