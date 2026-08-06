### Task 3: wasm binding

Expose `run_pipeline` to JS behind a `wasm` feature, leaving the native crate and binary untouched.

**Files:**
- Modify: `crates/holomap-clusterer/Cargo.toml`
- Modify: `crates/holomap-clusterer/src/lib.rs`
- Create: `crates/holomap-clusterer/src/wasm.rs`

**Interfaces:**
- Produces: wasm export `reduce_and_cluster(vectors: Float32Array, n_rows: u32, n_features: u32, n_components: u32, n_neighbors: u32, min_cluster_size: u32, seed: f64) -> Int32Array`. Throws a JS `Error` on failure. `seed` is `f64` because JS numbers are doubles; the binding casts to `u64`.

- [ ] **Step 1: Add the feature and dependency**

In `crates/holomap-clusterer/Cargo.toml`, append:

```toml
[features]
default = []
wasm = ["dep:wasm-bindgen"]

[dependencies.wasm-bindgen]
version = "0.2"
optional = true

[lib]
crate-type = ["cdylib", "rlib"]
```

`rlib` keeps the native binary and integration tests working; `cdylib` is what `wasm-pack` needs.

- [ ] **Step 2: Write the failing test**

Append to `crates/holomap-clusterer/tests/protocol.rs`:

```rust
/// The wasm binding flattens a row-major input into the Vec<Vec<f32>> that
/// run_pipeline takes. That reshape is the only logic the binding adds, so
/// it is the only part worth testing on the native side — the wasm-specific
/// behaviour is covered by the JS suite.
#[test]
fn flatten_reshapes_row_major_input() {
    let flat = vec![1.0f32, 2.0, 3.0, 4.0, 5.0, 6.0];
    let rows = holomap_clusterer::wasm::reshape(&flat, 3);
    assert_eq!(rows, vec![vec![1.0, 2.0, 3.0], vec![4.0, 5.0, 6.0]]);
}

#[test]
fn flatten_rejects_ragged_input() {
    let flat = vec![1.0f32, 2.0, 3.0, 4.0, 5.0];
    assert!(std::panic::catch_unwind(|| holomap_clusterer::wasm::reshape(&flat, 3)).is_err());
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cargo test -p holomap-clusterer`
Expected: FAIL — `could not find 'wasm' in 'holomap_clusterer'`.

- [ ] **Step 4: Write the binding**

`crates/holomap-clusterer/src/wasm.rs`:

```rust
//! WebAssembly binding.
//!
//! Wraps `run_pipeline` unchanged. The only logic here is marshalling: a
//! flat row-major Float32Array in, an Int32Array of labels out.
//!
//! `run_pipeline` is deliberately NOT refactored to take a flat slice. One
//! Vec allocation per row is 723 on the reference corpus and 50k at the
//! ceiling — nothing beside an O(N²·d) kNN — and changing tested production
//! code for a micro-optimisation is the wrong trade.

/// holomap's honest envelope, set by its exact O(N²·d) kNN.
///
/// A constant rather than a parameter: a configurable ceiling lets a caller
/// opt into an unbounded run with no way to know what they asked for. The
/// guard is wasm-only — a blocked worker thread is a wasm-specific hazard,
/// and the subprocess path is unaffected.
pub const MAX_ROWS: usize = 50_000;

/// Reshape a flat row-major buffer into rows. Panics on a ragged length;
/// the caller checks divisibility first and returns a JS error.
pub fn reshape(flat: &[f32], n_features: usize) -> Vec<Vec<f32>> {
    assert!(n_features > 0, "n_features must be positive");
    assert!(
        flat.len() % n_features == 0,
        "buffer length {} is not divisible by n_features {}",
        flat.len(),
        n_features
    );
    flat.chunks_exact(n_features).map(<[f32]>::to_vec).collect()
}

#[cfg(feature = "wasm")]
mod bindings {
    use super::{reshape, MAX_ROWS};
    use crate::pipeline::run_pipeline;
    use crate::protocol::{Params, Request, PROTOCOL_VERSION};
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    pub fn reduce_and_cluster(
        vectors: &[f32],
        n_features: usize,
        n_components: usize,
        n_neighbors: usize,
        min_cluster_size: usize,
        seed: f64,
    ) -> Result<Vec<i32>, JsError> {
        if n_features == 0 {
            return Err(JsError::new("n_features must be positive"));
        }
        if vectors.len() % n_features != 0 {
            return Err(JsError::new(&format!(
                "buffer length {} is not divisible by n_features {n_features}",
                vectors.len()
            )));
        }
        let n_rows = vectors.len() / n_features;
        if n_rows > MAX_ROWS {
            return Err(JsError::new(&format!(
                "{n_rows} rows exceeds MAX_ROWS {MAX_ROWS} — holomap's exact kNN is O(N^2*d); \
                 use the subprocess backend for corpora this size"
            )));
        }

        let resp = run_pipeline(&Request {
            protocol_version: PROTOCOL_VERSION,
            vectors: reshape(vectors, n_features),
            params: Params {
                n_components,
                n_neighbors,
                min_cluster_size,
                seed: seed as u64,
            },
        });

        // The Rust side reports errors in-band for the sidecar's per-line
        // contract. JS gets a throw instead: a resolved object carrying an
        // error field invites callers to ignore it.
        match resp.error {
            Some(e) => Err(JsError::new(&e)),
            None => Ok(resp.assignments),
        }
    }
}
```

Add to `crates/holomap-clusterer/src/lib.rs`:

```rust
pub mod pipeline;
pub mod protocol;
pub mod wasm;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p holomap-clusterer`
Expected: **8 passed** (6 original + 2 new), exit 0.

- [ ] **Step 6: Build the wasm artifact**

```bash
cargo install wasm-pack --locked   # if absent
cd crates/holomap-clusterer
RUSTFLAGS="-C target-feature=+simd128" \
  wasm-pack build --release --target nodejs --features wasm --out-dir pkg
ls -la pkg/
```

Expected: `pkg/holomap_clusterer_bg.wasm`, `pkg/holomap_clusterer.js`, `pkg/holomap_clusterer.d.ts`.

`+simd128` matters: holomap's hot path is plain scalar Rust, so the usual wasm cliffs (missing intrinsics, missing threads) do not apply — but native LLVM auto-vectorises `exact_knn`'s distance loop to AVX and wasm will not without this flag.

- [ ] **Step 7: Gitignore the build output**

Append to `.gitignore`:

```
crates/holomap-clusterer/pkg/
```

- [ ] **Step 8: Commit**

```bash
git add crates/holomap-clusterer/Cargo.toml crates/holomap-clusterer/src/wasm.rs \
        crates/holomap-clusterer/src/lib.rs crates/holomap-clusterer/tests/protocol.rs .gitignore
git commit -m "feat: wasm binding for the clusterer, behind a \`wasm\` feature

Marshalling only — flat Float32Array in, Int32Array of labels out — wrapping
run_pipeline unchanged. Native crate and binary are untouched: the feature is
off by default and crate-type gains cdylib alongside rlib.

Errors throw rather than resolving in-band. In-band is right for the sidecar's
per-line contract, but a JS call resolving to an object carrying an error field
invites callers to ignore it.

MAX_ROWS is a constant, not a parameter — a configurable ceiling lets a caller
opt into an unbounded run with no way to know what they asked for.

Written by [mnmal-ai-claude](https://github.com/mnmal-ai-claude) with [Claude Code](https://claude.com/claude-code)"
```

---

