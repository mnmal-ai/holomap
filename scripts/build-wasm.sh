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

# Preflight. Both of these fail deep inside cargo with messages that do not
# name the fix, and both cost a first-time consumer real time (reported from
# coda's integration, 2026-08-05).

if ! cargo_err=$(cargo --version 2>&1); then
  # Print the real error first. An earlier version of this check replaced it
  # with advice, which hid the one line that actually said what was wrong.
  echo "error: \`cargo\` is not runnable here. It said:" >&2
  printf '%s\n' "$cargo_err" | sed 's/^/  /' >&2
  cat >&2 <<'EOF'

If that says "No version is set for shim: cargo", cargo is a mise shim and
this repo deliberately does not pin a toolchain (see below). Either set one
for your shell -- `mise use -g rust@stable` -- or run this with an explicit
version: MISE_RUST_VERSION=stable bash scripts/build-wasm.sh

Why no pin: a repo-level mise.toml was tried and reverted. It made mise take
over rust here, and on a box where rustup already provides a working
toolchain mise failed to install its own and left cargo unusable -- strictly
worse than the confusing message this text replaces. A rustup-native
rust-toolchain.toml is the likely right answer and has not been validated
yet.

No mise? Install Rust from https://rustup.rs.
EOF
  exit 1
fi

if ! rustc --print target-list >/dev/null 2>&1 || \
   ! rustup target list --installed 2>/dev/null | grep -qx wasm32-unknown-unknown; then
  cat >&2 <<'EOF'
error: the wasm32-unknown-unknown target is not installed.

  rustup target add wasm32-unknown-unknown
EOF
  exit 1
fi

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
