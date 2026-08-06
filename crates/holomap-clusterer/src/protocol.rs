//! The JSON-lines wire protocol.
//!
//! One [`Request`] per stdin line, one [`Response`] per stdout line. The
//! wasm binding uses the same types without the serialisation.
//!
//! Field names are snake_case on the wire and are part of the contract — the
//! TypeScript client in `npm/` maps its camelCase surface onto them.

use serde::{Deserialize, Serialize};

/// Wire format version, sent and checked on every request.
///
/// [`run_pipeline`](crate::pipeline::run_pipeline) rejects any other value
/// rather than attempting a best-effort parse: a mismatch means the caller
/// and the binary disagree about the shape of the data, and guessing there
/// produces a clustering nobody can account for.
pub const PROTOCOL_VERSION: u32 = 1;

/// Pipeline parameters.
///
/// Three values that are NOT here are deliberate. `min_samples` is never set,
/// so `hdbscan` defaults it to `min_cluster_size`; `min_dist` stays at
/// holomap's 0.1 default; `spread` and `n_epochs` stay at holomap's defaults
/// too. Each of those was measured, and changing them degrades the reference
/// corpus badly — see [`crate::pipeline`] for the figures before touching any
/// of them.
#[derive(Debug, Deserialize)]
pub struct Params {
    /// Output dimensionality of the reduction stage. 0 = skip reduction
    /// (cluster the input vectors directly — used for low-d inputs/tests).
    pub n_components: usize,
    /// Neighbourhood size for holomap's kNN stage. Ignored when
    /// `n_components` is 0, since no reduction runs.
    pub n_neighbors: usize,
    /// Smallest group HDBSCAN will call a cluster. Also becomes its
    /// `min_samples`, by omission — see the type-level note.
    ///
    /// The `hdbscan` crate clamps values below 2 up to 2, then panics if the
    /// row count is under that effective minimum. Callers are expected to
    /// hold `rows >= max(min_cluster_size, 2)`; the wasm binding and the
    /// TypeScript client both reject below it rather than let the panic
    /// surface as an opaque trap.
    pub min_cluster_size: usize,
    /// Seed for every stochastic component. Same input + same seed must
    /// produce byte-identical output (the determinism contract).
    ///
    /// Determinism is not the same as numerical stability: identical input
    /// reproduces identical output, but *near*-identical input does not
    /// produce near-identical output. See [`crate::pipeline`].
    pub seed: u64,
}

/// One clustering request.
#[derive(Debug, Deserialize)]
pub struct Request {
    /// Must equal [`PROTOCOL_VERSION`]; anything else is refused.
    pub protocol_version: u32,
    /// Row-major input vectors. Every row must have the same non-zero
    /// length. Normalisation is *not* required — the pipeline L2-normalises
    /// internally — but note that pre-normalising still changes the result,
    /// because it changes the float rounding. See [`crate::pipeline`].
    pub vectors: Vec<Vec<f32>>,
    /// Pipeline parameters for this request.
    pub params: Params,
}

/// One clustering result, or an error.
///
/// Errors are returned **in band** rather than as a panic or a non-zero exit,
/// because the binary is a long-lived per-line server: one malformed request
/// must not take down the batch queued behind it. The wasm binding converts
/// `error` into a thrown `JsError` instead, since a resolved object carrying
/// an error field invites callers to ignore it.
#[derive(Debug, Serialize)]
pub struct Response {
    /// Always [`PROTOCOL_VERSION`].
    pub protocol_version: u32,
    /// Cluster label per input vector; -1 = noise (HDBSCAN convention).
    ///
    /// Empty when `error` is set. Labels are not stable identities across
    /// runs with different input — a consumer that needs durable concept
    /// identity must accrete rather than re-derive it from a fresh
    /// clustering.
    pub assignments: Vec<i32>,
    /// **Never populated.** `hdbscan` 0.12's `.cluster()` returns labels
    /// only, with no membership-probability API to expose. The field exists
    /// for protocol forward-compatibility; do not build against it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probabilities: Option<Vec<f32>>,
    /// Set when the request could not be served. Mutually exclusive with a
    /// populated `assignments`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
