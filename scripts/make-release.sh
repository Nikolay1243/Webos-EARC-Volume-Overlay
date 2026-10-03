#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
npm run package
node scripts/release-metadata.mjs
printf '%s\n' 'Release assets ready in build/ and build/release/. Publish using the GitHub Publish release workflow.'
