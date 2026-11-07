#!/bin/sh
# Builds the native watcher as static binaries for 32- and 64-bit ARM.
# Needs Rust (rustup) and cargo-zigbuild:  pip install ziglang cargo-zigbuild
set -eu
cd "$(dirname "$0")/.."

OUT=build/native
mkdir -p "$OUT"
for PAIR in armv7:armv7-unknown-linux-musleabihf aarch64:aarch64-unknown-linux-musl; do
	NAME=${PAIR%%:*}
	TARGET=${PAIR#*:}
	rustup target add "$TARGET" >/dev/null 2>&1 || true
	cargo zigbuild --release --manifest-path watcher-rs/Cargo.toml --target "$TARGET"
	cp "watcher-rs/target/$TARGET/release/earc-watcher" "$OUT/earc-watcher-$NAME"
	chmod 755 "$OUT/earc-watcher-$NAME"
done
ls -l "$OUT"
