#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' app/appinfo.json | head -n 1)
IPK="build/com.github.nikolay1243.earcvolume_${VERSION}_all.ipk"
[ -f "$IPK" ] || npm run package
SHA=$(shasum -a 256 "$IPK" | awk '{print $1}')
SIZE=$(wc -c < "$IPK" | tr -d ' ')
mkdir -p release

sed \
	-e "s/@VERSION@/$VERSION/g" \
	-e "s/@SHA256@/$SHA/g" \
	-e "s/@SIZE@/$SIZE/g" \
	manifest.template.json > release/com.github.nikolay1243.earcvolume.manifest.json
echo "Created release/com.github.nikolay1243.earcvolume.manifest.json"
