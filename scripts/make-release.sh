#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
npm run package

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' app/appinfo.json | head -n 1)
STAGE="release/earc-volume-overlay-v$VERSION"
ARCHIVE="release/earc-volume-overlay-v$VERSION.tar.gz"

rm -rf "$STAGE"
mkdir -p "$STAGE/app" "$STAGE/build" "$STAGE/runtime" "$STAGE/scripts"
cp build/com.github.nikolay1243.earcvolume_${VERSION}_all.ipk "$STAGE/build/"
cp app/appinfo.json app/index.html app/icon.png app/largeIcon.png "$STAGE/app/"
cp runtime/watcher.js runtime/91-earc-volume-overlay "$STAGE/runtime/"
cp scripts/package.sh scripts/install.sh scripts/uninstall.sh "$STAGE/scripts/"
cp README.md LICENSE package.json package-lock.json icon.svg "$STAGE/"

tar -czf "$ARCHIVE" -C release "earc-volume-overlay-v$VERSION"
echo "Created $ARCHIVE"
