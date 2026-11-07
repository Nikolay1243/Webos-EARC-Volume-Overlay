#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' app/appinfo.json | head -n 1)
[ -n "$VERSION" ] || { echo "Could not read app version" >&2; exit 1; }

mkdir -p build
rm -f build/com.github.nikolay1243.earcvolume*_all.ipk
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT INT TERM
cp -R app/. "$STAGE/"
mkdir -p "$STAGE/runtime"
cp runtime/watcher.js runtime/91-earc-volume-overlay "$STAGE/runtime/"
for ARCH in armv7 aarch64; do
	[ -f "build/native/earc-watcher-$ARCH" ] || { echo "Missing native watcher; run scripts/build-watcher.sh" >&2; exit 1; }
	cp "build/native/earc-watcher-$ARCH" "$STAGE/runtime/"
	chmod 755 "$STAGE/runtime/earc-watcher-$ARCH"
done
chmod 755 "$STAGE/runtime/91-earc-volume-overlay"
npx ares-package "$STAGE" --no-minify -o build

IPK="build/com.github.nikolay1243.earcvolume_${VERSION}_all.ipk"
[ -f "$IPK" ] || { echo "Expected package was not created: $IPK" >&2; exit 1; }
echo "Packaged $IPK"
