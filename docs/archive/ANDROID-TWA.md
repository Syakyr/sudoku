# SUPERSEDED — do not follow this document

**The TWA approach was dropped on 2026-10-10 in favour of a bundled Capacitor
APK.** Kept for the record because it documents real, measured Bubblewrap
behaviour that is expensive to re-derive.

Why it was replaced: a TWA contains none of the app. It is a chrome-less
Chrome window pointed at `https://syakyr.github.io/sudoku/`, so GitHub Pages
being reachable is a hard runtime dependency for the first load, and the tag
never actually froze anything — the code the wrapper showed was whatever was
deployed, not the code at the tag. The Capacitor build packs the app into the
APK, so a tag is a real snapshot and the app works with no network at all.
Rolling updates are now the PWA's job, installed from the browser.

What still carries over to `android-apk.yml`: the runner SDK facts, the
`setup-android@v3` breakage, the pinned signing key alias, and the
"never let CI mint a fresh key" rule.

---

# Android TWA (the APK)

The APK is a **Trusted Web Activity**: a thin Android shell that launches the
existing PWA full-screen with no browser UI. It is not a port — generation,
solving and storage all stay in the web layer. Built with
[Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap), published as a
GitHub Release asset so [Obtainium](https://github.com/ImranR98/Obtainium)
can track it.

```
tag v*  ──► .github/workflows/android-twa.yml
              ├─ JDK 17 + Android SDK + @bubblewrap/cli
              ├─ keystore restored from secrets (never committed)
              ├─ bubblewrap update  (bump versionCode from the tag)
              ├─ bubblewrap build   (signed APK + AAB)
              └─ gh release create  ──► sudoku-twa-v1.0.0.apk  ◄── Obtainium
```

## Two things block a first build. Both are outside the workflow.

### 1. The signing key must be pre-generated and kept forever

CI must **not** generate a key per build. Android refuses to install an update
whose signing certificate differs from the installed app, so a rotating key
means every release is clean-install-only and Obtainium updates break
silently.

```bash
./tools/make-twa-keystore.sh          # needs a JDK 17+ on PATH
```

It prints three values for **Settings → Secrets and variables → Actions**:

| Secret | What |
|---|---|
| `TWA_KEYSTORE_BASE64` | the keystore, base64-encoded |
| `TWA_KEYSTORE_PASSWORD` | store password |
| `TWA_KEY_PASSWORD` | key password |

Back the keystore up off-machine. Losing it is unrecoverable: you would have to
change the package name and every user reinstalls from scratch.

### 2. Digital Asset Links must live at the ORIGIN ROOT — this is the real blocker

Without verification the APK still installs and runs, but Chrome falls back to
a **Custom Tab with a URL bar** instead of a trusted full-screen app. The
spec requires the delegation file at the origin root:

```
https://syakyr.github.io/.well-known/assetlinks.json      ← required
https://syakyr.github.io/sudoku/.well-known/...          ← does NOT work
```

Measured today: `https://syakyr.github.io/` is **404** — there is no user
site, and the `/sudoku/` project page cannot serve the origin root. So this
needs one of:

**(a) A user-site repo** — create `Syakyr.github.io` containing:

```
.nojekyll                      ← stops Jekyll processing; without it dotfiles
                                 get skipped or mangled (the standard fix for
                                 assetlinks on Pages)
.well-known/assetlinks.json
```

with:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.syakyr.sudoku.twa",
    "sha256_cert_fingerprints": ["AA:BB:CC:..."]
  }
}]
```

`package_name` is whatever you give `bubblewrap init`. The fingerprint is
printed in the build log (and by the keystore script).

**(b) A custom domain** pointed at the site, which makes the origin root
yours and avoids the user-site dance entirely.

Verify with:

```bash
curl -i https://syakyr.github.io/.well-known/assetlinks.json
# want: 200 + Content-Type: application/json
```

## One-time: generate the Android project

`bubblewrap init` is **interactive** (it confirms app name, package id, host,
signing details), so it cannot run in CI. Run it once, anywhere with Node 18+
and the Android toolchain — or via the prebuilt container, which has the CLI
and its dependencies already installed:

```bash
docker run --rm -it -v "$PWD:/pwa" -w /pwa \
  ghcr.io/googlechromelabs/bubblewrap:latest \
  bubblewrap init --manifest https://syakyr.github.io/sudoku/manifest.webmanifest
```

Then **commit the generated `android/` directory**. The workflow builds from
it and fails with a clear message if it is missing. Re-run
`bubblewrap update` (which CI does) rather than hand-editing the project —
update regenerates it and will clobber manual edits.

## Release

```bash
git tag v1.0.0 && git push origin v1.0.0
```

Watch it: `gh run watch`. Then in Obtainium: add
`Syakyr/sudoku`, and it picks up `sudoku-twa-*.apk`.

## Verification status — read this before trusting the workflow

Written against the Bubblewrap CLI docs (`build` reads
`BUBBLEWRAP_KEYSTORE_PASSWORD` / `BUBBLEWRAP_KEY_PASSWORD` from env, which
is what makes CI possible) but **not executed**: this host has no JDK, no
Android SDK and no Docker, and the secrets do not exist yet. Expect to fix
small things on the first run — most likely candidates:

- the exact output filenames Bubblewrap drops (`app-release-signed.apk` /
  `app-release-bundle.aab`) and where they land relative to `--manifest`
- whether `bubblewrap update --manifest=android` wants a directory or a file
  path in this version
- `android-actions/setup-android@v3` version vs the build-tools Bubblewrap
  pins

Run it once with a throwaway tag (`v0.0.1-test`) before cutting a real one,
so a real version number is never burned on a broken pipeline.

Also note `--skipPwaValidation` is set: the quality-criteria check calls the
live site and fails on things this repo cannot control. Run
`bubblewrap validate --url=https://syakyr.github.io/sudoku/` by hand if you
want that signal.
