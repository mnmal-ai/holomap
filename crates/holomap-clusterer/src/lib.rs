//! Deterministic reduce→cluster: [`holomap`] UMAP → HDBSCAN.
//!
//! ```no_run
//! use holomap_clusterer::pipeline::run_pipeline;
//! use holomap_clusterer::protocol::{Params, Request, PROTOCOL_VERSION};
//!
//! let response = run_pipeline(&Request {
//!     protocol_version: PROTOCOL_VERSION,
//!     vectors: vec![vec![0.0; 128]; 500],
//!     params: Params {
//!         n_components: 10,   // 0 skips reduction
//!         n_neighbors: 15,
//!         min_cluster_size: 5,
//!         seed: 42,
//!     },
//! });
//! // response.assignments: one label per row, -1 = noise.
//! ```
//!
//! # The contract, and its limit
//!
//! Same input + same params + same seed → identical assignments. Neither
//! stage leaks entropy: holomap takes a required `seed: u64` and draws all
//! randomness from one PCG64 stream, and `hdbscan` is graph-based with no RNG
//! at all. rayon is disabled deliberately — parallel MST construction would
//! admit thread-scheduling non-determinism, and determinism is the product.
//!
//! **Deterministic is not numerically stable.** Identical input reproduces
//! identical output; *near*-identical input does not produce near-identical
//! output. HDBSCAN is a density algorithm, so perturbations far below any
//! meaningful precision move points across cluster boundaries. On the
//! reference corpus, merely L2-normalising the input before calling —
//! mathematically a no-op, since [`pipeline`] normalises internally — shifts
//! the result by up to 3 clusters, and the shift depends on whether the norm
//! was accumulated in f32 or f64. [`pipeline`] carries the measured table.
//!
//! Two consequences worth taking seriously: pin your preprocessing as
//! carefully as you pin your seed, and never quote a figure for this pipeline
//! without naming the input regime that produced it.
//!
//! # Scale
//!
//! holomap's kNN is exact brute force, O(N²·d), so the honest ceiling is
//! ~50k rows. That is the trade for a kNN that is deterministic by
//! construction rather than by seeding an approximation.
//!
//! # Front doors
//!
//! - [`pipeline::run_pipeline`] — the library entry point.
//! - `holomap-clusterer` (binary) — a JSON-lines stdin/stdout server speaking
//!   [`protocol`]. Errors are per-line responses, never process aborts.
//! - [`wasm`] — a WebAssembly binding behind the `wasm` feature, used by the
//!   `@mnmal-ai/holomap-clusterer` npm package.

pub mod pipeline;
pub mod protocol;
pub mod wasm;
