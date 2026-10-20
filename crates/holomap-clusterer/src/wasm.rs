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
        flat.len().is_multiple_of(n_features),
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
        if !vectors.len().is_multiple_of(n_features) {
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
