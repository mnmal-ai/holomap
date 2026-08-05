//! Reduce→cluster pipeline.
//!
//! # Crate choices
//!
//! ## HDBSCAN: `hdbscan` 0.12 (serial feature only)
//!
//! Pure-Rust implementation using Prim's MST and single-linkage condensation —
//! zero RNG, fully deterministic given fixed input order.  The "parallel"
//! feature (rayon) is disabled to prevent any thread-scheduling non-determinism
//! from creeping in via parallel MST construction.  Returns `Vec<i32>` with -1
//! for noise; no membership-probability API is exposed by this crate.
//!
//! ## Reduction: `holomap` — seedable deterministic UMAP (git → crates.io on publish)
//!
//! Replaces the PCA (nalgebra SVD) stage that was the only viable Rust
//! reduction in Phase-0: PCA is a linear transform and cannot preserve the
//! local neighbourhood density of 1024-d cosine-normalised text embeddings —
//! see coda's `docs/2026-06-06-phase0-clusterer-spike-findings.md` for the root-cause
//! analysis and the FALLBACK-Python verdict.
//!
//! holomap (rev 71810a1) is the project's own seedable UMAP-class Rust crate.
//! The standalone gate (2026-06-07) produced 36 clusters / 27.2% noise / 7-8
//! coherent qualitative samples / byte-identical determinism / 2.46 s — all
//! hard gates green.  That result reopens the GO-Rust path.
//!
//! ## Pipeline metric
//!
//! Corpus embeddings are bge-m3 / 1024-d, L2-normalised.  The pipeline
//! preserves the normalisation (see `l2_normalise`) and then passes
//! `Metric::Cosine` to holomap so the kNN stage uses cosine distance — the
//! natural choice for magnitude-normalised text embeddings and matching the
//! Python UMAP baseline (`metric='cosine'`).  On the unit sphere cosine
//! distance is equivalent to squared Euclidean, but the cosine path gives
//! numerically cleaner distances because the dot-product accumulates in f64.
//!
//! ## umap-learn parameter correspondence
//!
//! The Python baseline uses:
//!   `UMAP(n_components=10, n_neighbors=15, min_dist=0.0, metric='cosine')`
//! holomap defaults: n_components=2, n_neighbors=15, min_dist=0.1, metric=Euclidean.
//! We override n_components, n_neighbors, metric, and seed from the protocol params.
//! min_dist is left at holomap's default (0.1) — NOT 0.0 — because the
//! standalone gate confirmed 0.1 passes the hard gates (36/27.2%) while 0.0
//! regresses (13/45.2%).  holomap's SGD schedule handles the zero-min-dist
//! edge case differently from umap-learn's.  spread (1.0) and n_epochs (auto)
//! match umap-learn's defaults and are left at holomap's defaults.
//!
//! ## Determinism contract
//!
//! `hdbscan` serial: deterministic by algorithm (graph-based MST, no RNG).
//! `holomap`: seeded PCG RNG, seed supplied from the protocol `seed` field.
//! Thread pool: neither crate uses rayon in the paths we call.
//! Result: same input + same seed → byte-identical assignments, always.

use crate::protocol::{Request, Response, PROTOCOL_VERSION};
use hdbscan::{DistanceMetric, Hdbscan, HdbscanHyperParams};
use holomap::{Holomap, Metric};

pub fn run_pipeline(req: &Request) -> Response {
    if req.protocol_version != PROTOCOL_VERSION {
        return error_response(format!(
            "unsupported protocol_version {}",
            req.protocol_version
        ));
    }
    if req.vectors.is_empty() {
        return error_response("empty input".to_string());
    }
    let dims: Vec<usize> = req.vectors.iter().map(|v| v.len()).collect();
    if dims.windows(2).any(|w| w[0] != w[1]) {
        return error_response("vector dimensions inconsistent".to_string());
    }
    let dim = dims[0];
    if dim == 0 {
        return error_response("zero-dimensional vectors".to_string());
    }

    // Step 1 — L2-normalise (cosine ~ euclidean on unit sphere; holomap's
    // Metric::Cosine handles the general case, but normalisation here matches
    // the Python baseline and is numerically cheap).
    let normed = l2_normalise(&req.vectors);

    // Step 2 — optional holomap UMAP reduction.
    let to_cluster: Vec<Vec<f32>> = if req.params.n_components == 0 {
        // No reduction: cluster the normalised vectors directly.
        normed
    } else {
        match holomap_reduce(&normed, req.params.n_components, req.params.n_neighbors, req.params.seed) {
            Ok(v) => v,
            Err(e) => return error_response(format!("holomap reduction failed: {e}")),
        }
    };

    // Step 3 — HDBSCAN (serial, no rayon, fully deterministic).
    // min_samples is intentionally NOT set — the `hdbscan` crate defaults it to
    // min_cluster_size, which matches sklearn's `HDBSCAN(min_cluster_size=5)`
    // default (min_samples=None → min_cluster_size).  Setting it to n_neighbors
    // (15) degrades cluster count drastically (8 vs 36 on the reference corpus).
    // NOTE this also applies to the n_components=0 direct-HDBSCAN path (used by
    // dynamics split detection): the previous min_samples=n_neighbors wiring was
    // the cross-binding INCONSISTENCY — clusterer.py never set min_samples, so
    // sklearn already defaulted it to min_cluster_size there.  Leaving it unset
    // here makes both bindings agree; the change is deliberate.
    let hp = HdbscanHyperParams::builder()
        .min_cluster_size(req.params.min_cluster_size)
        .dist_metric(DistanceMetric::Euclidean)
        .build();

    let clusterer = Hdbscan::new(&to_cluster, hp);
    match clusterer.cluster() {
        Ok(labels) => Response {
            protocol_version: PROTOCOL_VERSION,
            assignments: labels,
            // The `hdbscan` crate (0.12) does not expose membership
            // probabilities — only the label vec is returned by .cluster().
            probabilities: None,
            error: None,
        },
        Err(e) => error_response(format!("HDBSCAN failed: {e:?}")),
    }
}

/// L2-normalise every vector. Zero vectors are left as-is (all-zeros — they
/// will be noise outliers in HDBSCAN, which is appropriate).
fn l2_normalise(vecs: &[Vec<f32>]) -> Vec<Vec<f32>> {
    vecs.iter()
        .map(|v| {
            let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            if norm == 0.0 {
                v.clone()
            } else {
                v.iter().map(|x| x / norm).collect()
            }
        })
        .collect()
}

/// Reduce via holomap (seedable UMAP-class).
///
/// Parameter choices:
/// - metric = Cosine: corpus embeddings are bge-m3 / L2-normalised; cosine is
///   the natural distance for text embeddings and matches the Python baseline.
/// - min_dist = 0.1 (holomap default): the standalone holomap gate
///   (holomap_gate.py, 2026-06-07) confirmed that min_dist=0.1 produces
///   36 clusters / 27.2% noise (all hard gates green). Setting min_dist=0.0
///   to match the Python baseline's umap-learn call degrades to 13 / 45.2%
///   — holomap's SGD schedule and the Python umap-learn schedule differ in
///   how they handle the zero-min-dist edge case, so the holomap default is
///   the correct setting here (not 0.0).
/// - spread = 1.0 (holomap default): matches umap-learn default.
/// - n_epochs = None (holomap auto: 500 ≤ 10k pts, 200 above): matches the
///   auto-epoch logic in umap-learn's reference implementation.
/// - n_components, n_neighbors, seed: from the protocol params.
///
/// Output is a flat embedding reshaped into Vec<Vec<f32>> (n_samples × k).
fn holomap_reduce(
    vecs: &[Vec<f32>],
    n_components: usize,
    n_neighbors: usize,
    seed: u64,
) -> Result<Vec<Vec<f32>>, Box<dyn std::error::Error>> {
    let n_features = vecs[0].len();

    // holomap takes a flat row-major slice.
    let flat: Vec<f32> = vecs.iter().flatten().copied().collect();

    let embedding = Holomap::builder(seed)
        .n_components(n_components)
        .n_neighbors(n_neighbors)
        .metric(Metric::Cosine)
        // min_dist: 0.1 (holomap default) — NOT 0.0.
        // See doc comment above for the full rationale.
        // spread defaults to 1.0, n_epochs defaults to auto — no overrides needed.
        .fit_transform(&flat, n_features)?;

    // Reshape flat output (n_samples * n_components) → Vec<Vec<f32>>.
    // chunks_exact on an n_samples*n_components slice yields exactly n_samples rows
    Ok(embedding.chunks_exact(n_components).map(|chunk| chunk.to_vec()).collect())
}

fn error_response(msg: String) -> Response {
    Response {
        protocol_version: PROTOCOL_VERSION,
        assignments: vec![],
        probabilities: None,
        error: Some(msg),
    }
}
