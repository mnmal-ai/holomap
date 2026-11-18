//! Fuzzy simplicial set — Stage 2's local membership strengths fused into a
//! global graph by the probabilistic t-conorm.
//!
//! Mirrors umap-learn 0.5.12 `compute_membership_strengths` + the
//! `set_op_mix_ratio = 1.0` set operation in `fuzzy_simplicial_set`:
//! self-edges are dropped, `w_ij = exp(-(d_ij - rho_i) / sigma_i)` (1.0 when
//! `d <= rho` or `sigma = 0`), then `W = A + Aᵀ − A ∘ Aᵀ` with float32
//! arithmetic. Output is COO sorted by `(row, col)` — the deterministic edge
//! ordering every later stage iterates in. Explicit zeros are eliminated,
//! matching scipy's `eliminate_zeros()`.

use crate::fmath::HostInvariant;
use crate::knn::Knn;
use crate::smooth_knn::SmoothKnn;

/// Sparse symmetric graph in COO form, entries sorted by `(row, col)`.
pub struct FuzzyGraph {
    pub n: usize,
    pub rows: Vec<u32>,
    pub cols: Vec<u32>,
    pub vals: Vec<f32>,
}

/// Fuse per-point membership strengths into the symmetrized fuzzy graph.
pub fn fuzzy_simplicial_set(knn: &Knn, calib: &SmoothKnn) -> FuzzyGraph {
    let k = knn.k;
    let n = knn.indices.len() / k;

    // directed membership strengths A, sorted by (row, col); self-edges and
    // underflowed-to-zero weights dropped (scipy eliminate_zeros)
    let mut directed: Vec<(u32, u32, f32)> = Vec::with_capacity(n * k);
    for i in 0..n {
        for j in 0..k {
            let col = knn.indices[i * k + j];
            if col as usize == i {
                continue;
            }
            let d = knn.dists[i * k + j] - calib.rhos[i];
            let val = if d <= 0.0 || calib.sigmas[i] == 0.0 {
                1.0
            } else {
                (-(d / calib.sigmas[i])).hi_exp()
            };
            if val != 0.0 {
                directed.push((i as u32, col, val));
            }
        }
    }
    directed.sort_unstable_by_key(|&(r, c, _)| (r, c));

    let lookup = |r: u32, c: u32| -> f32 {
        directed
            .binary_search_by_key(&(r, c), |&(rr, cc, _)| (rr, cc))
            .map(|pos| directed[pos].2)
            .unwrap_or(0.0)
    };

    // union of A and Aᵀ coordinates, deduped — the t-conorm support.
    // directed is sorted by (row, col), but a reverse edge (c,r) gets pushed into
    // row_buckets[r'] out of ascending-col order relative to forward edges. Sort
    // each bucket before concatenating so the global output is (row,col)-sorted.
    // Dedup is still needed: an edge may exist in BOTH A and Aᵀ as separate directed
    // entries, which would otherwise produce a duplicate pair in coords.
    let mut row_buckets: Vec<Vec<(u32, u32)>> = vec![Vec::with_capacity(4); n];
    for &(r, c, _) in &directed {
        row_buckets[r as usize].push((r, c));
        if r != c {
            row_buckets[c as usize].push((c, r));
        }
    }
    for bucket in &mut row_buckets {
        bucket.sort_unstable();
    }
    let mut coords: Vec<(u32, u32)> = Vec::with_capacity(directed.len() * 2);
    for bucket in &row_buckets {
        coords.extend_from_slice(bucket);
    }
    coords.dedup();

    let mut rows = Vec::with_capacity(coords.len());
    let mut cols = Vec::with_capacity(coords.len());
    let mut vals = Vec::with_capacity(coords.len());
    for (r, c) in coords {
        let v = lookup(r, c);
        let vt = lookup(c, r);
        let w = (v + vt) - v * vt; // float32, scipy's operand order
        if w != 0.0 {
            rows.push(r);
            cols.push(c);
            vals.push(w);
        }
    }
    FuzzyGraph {
        n,
        rows,
        cols,
        vals,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 3 line points (0, 1, 3), k=3 — kNN and rho/sigma as verified in the
    /// smooth_knn oracle test. Directed strengths: each point's nearest
    /// non-identical neighbour gets 1.0 (d == rho), the far edge gets
    /// exp(-(d-rho)/sigma). Hand-derived t-conorm fusion below. Sigma
    /// literals are exact decimal expansions of the reference's float32
    /// values — full precision is the point.
    #[allow(clippy::excessive_precision)]
    fn line_fixture() -> (Knn, SmoothKnn) {
        let knn = Knn {
            k: 3,
            indices: vec![0, 1, 2, 1, 0, 2, 2, 1, 0],
            dists: vec![0.0, 1.0, 3.0, 0.0, 1.0, 2.0, 0.0, 2.0, 3.0],
        };
        let calib = SmoothKnn {
            sigmas: vec![3.72998046875, 1.864990234375, 1.864990234375],
            rhos: vec![1.0, 1.0, 2.0],
        };
        (knn, calib)
    }

    #[test]
    #[allow(clippy::excessive_precision)] // sigma0's exact f32 expansion
    fn symmetrizes_with_t_conorm_sorted_no_self_edges() {
        let (knn, calib) = line_fixture();
        let g = fuzzy_simplicial_set(&knn, &calib);

        // exp(-2/sigma0) == exp(-1/sigma1) == exp(-1/sigma2) by construction
        let w = (-2.0_f32 / 3.72998046875).hi_exp();
        let fused = (w + w) - w * w; // t-conorm of equal directed weights

        assert_eq!(g.n, 3);
        assert_eq!(g.rows, vec![0, 0, 1, 1, 2, 2]);
        assert_eq!(g.cols, vec![1, 2, 0, 2, 0, 1]);
        let expected = [1.0, fused, 1.0, 1.0, fused, 1.0];
        for (i, (&a, &e)) in g.vals.iter().zip(&expected).enumerate() {
            assert!((a - e).abs() < 1e-6, "entry {i}: {a} vs {e}");
        }
    }

    /// A directed edge present in only ONE direction must still produce both
    /// symmetric entries: union with the absent reverse edge is w + 0 − 0 = w.
    #[test]
    fn one_directional_edge_becomes_symmetric() {
        // Line points 0.0, 1.0, 1.1 with k=2 (self + 1): point 0's list is
        // {0, 1}, but points 1 and 2 pick each other — edge (0,1) is directed
        // only. rho0 = 0.5, sigma0 = 1.0 makes its weight exp(-0.5) ≠ 1.
        let knn = Knn {
            k: 2,
            indices: vec![0, 1, 1, 2, 2, 1],
            dists: vec![0.0, 1.0, 0.0, 0.1, 0.0, 0.1],
        };
        let calib = SmoothKnn {
            sigmas: vec![1.0, 1.0, 1.0],
            rhos: vec![0.5, 0.1, 0.1],
        };
        let g = fuzzy_simplicial_set(&knn, &calib);

        let w = (-0.5_f32).hi_exp();
        assert_eq!(g.rows, vec![0, 1, 1, 2]);
        assert_eq!(g.cols, vec![1, 0, 2, 1]);
        // (0,1)/(1,0): one-directional w survives unchanged and mirrors;
        // (1,2)/(2,1): both directions are 1.0 (d == rho) → fused 1.0
        assert_eq!(g.vals, vec![w, w, 1.0, 1.0]);
    }
    /// Dedup-exercising case: three points on a line where BOTH (0,2) and (2,0)
    /// exist as separate directed entries. The flat_map of A ∪ Aᵀ would produce
    /// duplicate coords pairs; this validates the bucket build + dedup produces the
    /// same 6 unique pairs (not 8) with correct values.
    #[test]
    fn dedups_overlapping_directed_entries() {
        // Points at 0.0, 2.0, 4.0 with k=3:
        //   Point 0's neighbours: self(0), p1 (d=2), p2 (d=4)
        //   Point 1's neighbours: p0 (d=2), self(1), p2 (d=2)
        //   Point 2's neighbours: p0 (d=4), p1 (d=2), self(2)
        // Both directed (0→2) and (2→0) exist → coords had duplicate pairs before dedup.
        let knn = Knn {
            k: 3,
            indices: vec![0, 1, 2, 0, 1, 2, 0, 1, 2],
            dists: vec![0.0, 2.0, 4.0, 2.0, 0.0, 2.0, 4.0, 2.0, 0.0],
        };
        let calib = SmoothKnn {
            sigmas: vec![1.0_f32; 3],
            rhos: vec![2.0_f32; 3],
        };
        let g = fuzzy_simplicial_set(&knn, &calib);

        // (0,1) and (1,2): d == rho in both directions → w=1.0 each way → t-conorm(1,1)=1.0
        // (0,2)/(2,0): the dedup case.
        //   Point 0→2: d=4, rho=2, sigma=1 → val = exp(-(4-2)/1) = e^{-2}
        //   t-conorm(e^{-2}, e^{-2}) = (e^{-2} + e^{-2}) - e^{-2} * e^{-2}
        let w_far = (-2.0_f32).hi_exp();
        let w_fused = (w_far + w_far) - w_far * w_far;

        assert_eq!(g.n, 3);
        // Exactly 6 unique pairs sorted by (row,col): (0,1)(0,2)(1,0)(1,2)(2,0)(2,1).
        // A missing/incorrect dedup would produce 8 entries.
        assert_eq!(g.vals.len(), 6);
        assert_eq!(g.rows, vec![0, 0, 1, 1, 2, 2]);
        assert_eq!(g.cols, vec![1, 2, 0, 2, 0, 1]);
        let expected = [1.0_f32, w_fused, 1.0_f32, 1.0_f32, w_fused, 1.0_f32];
        for (i, (&a, &e)) in g.vals.iter().zip(&expected).enumerate() {
            assert!((a - e).abs() < 1e-6, "entry {i}: {a} vs {e}");
        }
    }
}
