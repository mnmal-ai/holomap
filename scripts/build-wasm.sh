#!/usr/bin/env bash
set -euo pipefail

# wasm-pack is NOT used: wasm-pack 0.15.0 invokes `cargo build --out-dir`
# internally, and cargo 1.95.0 renamed that unstable flag to --artifact-dir,
# so every wasm-pack build fails. Reproduced independently 2026-08-05.
#
# The direct route is also strictly better: wasm-bindgen-cli MUST match the
# wasm-bindgen crate version exactly, and a mismatch fails in confusing ways.
# wasm-pack hid that coupling; here it is explicit and derived from Cargo.lock.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

WB_VERSION=$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | grep '^version' | cut -d'"' -f2)
echo "matching wasm-bindgen-cli to crate version $WB_VERSION"
cargo install wasm-bindgen-cli --version "$WB_VERSION" --locked

RUSTFLAGS="-C target-feature=+simd128" \
  cargo build --release --target wasm32-unknown-unknown -p holomap-clusterer --features wasm

wasm-bindgen --target nodejs --out-dir npm/wasm \
  target/wasm32-unknown-unknown/release/holomap_clusterer.wasm

# wasm-bindgen's --target nodejs glue is CommonJS (`exports.foo = ...`), but
# npm/package.json declares "type": "module" for the rest of the package.
# Without this marker Node resolves npm/wasm/*.js as ESM by nearest-
# package.json lookup and `exports is not defined` at load time. This file
# scopes CommonJS back to just the wasm output directory.
cat > npm/wasm/package.json <<'EOF'
{
  "type": "commonjs"
}
EOF

ls -la npm/wasm/
