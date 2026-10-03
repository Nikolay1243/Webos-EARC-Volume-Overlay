#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' app/appinfo.json | head -n 1)
[ -n "$VERSION" ] || { echo "Could not read app version" >&2; exit 1; }

mkdir -p build
rm -f build/com.github.nikolay1243.earcvolume_*_all.ipk
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT INT TERM
cp -R app/. "$STAGE/"
mkdir -p "$STAGE/runtime"
cp runtime/watcher.js runtime/91-earc-volume-overlay "$STAGE/runtime/"
npx ares-package "$STAGE" --no-minify -o build

IPK="build/com.github.nikolay1243.earcvolume_${VERSION}_all.ipk"
[ -f "$IPK" ] || { echo "Expected package was not created: $IPK" >&2; exit 1; }
echo "Packaged $IPK"

# The settings window must be a normal card so webOS exposes its launcher icon.
mkdir -p "$STAGE/settings"
cp -R settings/. "$STAGE/settings/"
cp app/index.html app/root-exec.js "$STAGE/settings/"
npx ares-package "$STAGE/settings" --no-minify -o build
