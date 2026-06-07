//! Distance metrics. Accumulation in `f64`, result in `f32` — mirrors the
//! reference pipeline (umap-learn computes pairwise distances in float64 and
//! casts to float32 before Stage 2).

/// Distance metric for the kNN stage.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Metric {
    Euclidean,
    Cosine,
}

/// Euclidean distance between two equal-length vectors.
pub fn euclidean(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let sq: f64 = a
        .iter()
        .zip(b)
        .map(|(&x, &y)| {
            let d = f64::from(x) - f64::from(y);
            d * d
        })
        .sum();
    sq.sqrt() as f32
}

/// Cosine distance `1 − cos(a, b)`. Magnitude-invariant; matches
/// scikit-learn / umap-learn's `metric="cosine"` values, which Stage 2
/// consumes directly.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let (mut dot, mut na, mut nb) = (0.0_f64, 0.0_f64, 0.0_f64);
    for (&x, &y) in a.iter().zip(b) {
        let (x, y) = (f64::from(x), f64::from(y));
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    (1.0 - dot / (na.sqrt() * nb.sqrt())) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn euclidean_distance_known_values() {
        assert_eq!(euclidean(&[0.0, 0.0], &[3.0, 4.0]), 5.0);
        assert_eq!(euclidean(&[1.0, 2.0, 3.0], &[1.0, 2.0, 3.0]), 0.0);
    }

    #[test]
    fn cosine_distance_known_values() {
        assert_eq!(cosine(&[1.0, 0.0], &[0.0, 1.0]), 1.0); // orthogonal
        assert_eq!(cosine(&[1.0, 0.0], &[2.0, 0.0]), 0.0); // parallel, scale-free
        assert_eq!(cosine(&[1.0, 0.0], &[-3.0, 0.0]), 2.0); // antiparallel
    }
}
