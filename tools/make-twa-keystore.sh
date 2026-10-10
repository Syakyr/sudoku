#!/usr/bin/env bash
# Generate the signing keystore for the Sudoku TWA, once, and print the values
# that go into GitHub repo secrets.
#
# Needs a JDK 17+ on PATH (keytool). Run it somewhere you can keep the output
# safe -- this is a signing key, not a build artifact.
#
#   ./tools/make-twa-keystore.sh [output-file]
#
# NEVER commit the keystore. The repo's pre-commit secret scan will not catch a
# base64 blob that happens to be a key, so keep it outside the working tree.
set -euo pipefail

OUT="${1:-$HOME/sudoku-twa.keystore}"
ALIAS="sudoku-twa"
VALIDITY_DAYS=10000   # ~27 years: the key must outlive the app, not the reverse.

if ! command -v keytool >/dev/null 2>&1; then
  echo "keytool not found -- install a JDK 17+ first." >&2
  exit 1
fi

if [ -e "$OUT" ]; then
  echo "$OUT already exists. Refusing to overwrite: replacing the signing key" >&2
  echo "makes every future release uninstallable over installed copies." >&2
  exit 1
fi

# Random passwords, printed once. You can substitute your own if you would
# rather type them; they just have to match the secrets.
STOREPASS="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
KEYPASS="$STOREPASS"   # same password for both keeps bubblewrap's env simple

echo "Generating $OUT (alias: $ALIAS)"
keytool -genkeypair \
  -keystore "$OUT" \
  -alias "$ALIAS" \
  -keyalg RSA -keysize 2048 \
  -validity "$VALIDITY_DAYS" \
  -storepass "$STOREPASS" \
  -keypass "$KEYPASS" \
  -dname "CN=Sudoku TWA, O=syakyr, C=US"

chmod 600 "$OUT"

echo
echo "Store the following as GitHub repo secrets (Settings -> Secrets and"
echo "variables -> Actions -> Repository secrets):"
echo
echo "  TWA_KEYSTORE_BASE64   = $(base64 -w0 "$OUT")"
echo "  TWA_KEYSTORE_PASSWORD = $STOREPASS"
echo "  TWA_KEY_PASSWORD      = $KEYPASS"
echo
echo "And this fingerprint goes in .well-known/assetlinks.json on the ORIGIN ROOT"
echo "(https://syakyr.github.io/.well-known/assetlinks.json, not /sudoku/):"
echo
keytool -list -rfc -keystore "$OUT" -storepass "$STOREPASS" 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256 | sed 's/^.*=//'
echo
echo "Write these down somewhere durable. Losing the keystore means you can never"
echo "ship an update that installs over existing copies -- every user would have"
echo "to uninstall and reinstall."
