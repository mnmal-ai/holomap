//! # holomap — deterministic UMAP
//!
//! *The bulk, on the boundary.* The holographic principle says the
//! information of an N-dimensional volume can be encoded on its
//! (N−1)-dimensional surface. `holomap` does that for your data:
//! UMAP-class dimensionality reduction with one non-negotiable contract —
//!
//! **Same input + same params + same seed → bit-identical embedding**
//! (on the same platform/toolchain; cross-platform runs are structurally
//! identical, with floats differing at ULP level).
//!
//! There is no unseeded constructor. By design, none will ever exist.
//!
//! ## Status
//!
//! Pre-M1 scaffold. The implementation lands in four milestones:
//! exact kNN + fuzzy simplicial set → spectral (Lanczos) initialization →
//! seeded SGD optimization → publish. Until then this crate is a
//! determinism contract looking for its algorithm.

mod fuzzy;
mod knn;
mod metric;
mod smooth_knn;

/// Pinned so the determinism contract in the crate docs is testable from
/// commit one: the CI determinism gate (run twice, compare raw bytes) will
/// replace this with a real `fit_transform` double-run as soon as M3 lands.
pub const DETERMINISM_CONTRACT: &str =
    "same input + same params + same seed => bit-identical embedding";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_is_stated() {
        assert!(DETERMINISM_CONTRACT.contains("bit-identical"));
    }
}
