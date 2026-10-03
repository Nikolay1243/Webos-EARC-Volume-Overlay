#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
node scripts/release-metadata.mjs
mkdir -p release
cp build/release/*.manifest.json release/
