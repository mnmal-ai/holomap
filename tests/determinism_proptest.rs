//! Property test of the headline contract: across arbitrary seeds, shapes,
//! parameters, and (finite) data, `fit_transform` is byte-for-byte identical
//! run to run. The fixed-fixture tests prove specific cases; this proves the
//! invariant over the input space.

use holomap::{Holomap, Init, Metric};
use proptest::prelude::*;

/// Generate a valid problem: `n_neighbors` first, then `n_points` with the
/// required headroom, then finite data, plus seed/metric/init/dim knobs.
fn problem() -> impl Strategy<Value = (Vec<f32>, usize, usize, usize, u64, Metric, Init)> {
    (2usize..=8, 2usize..=10) // n_features, n_neighbors
        .prop_flat_map(|(nf, k)| {
            let n_points = (k + 1)..=(k + 40);
            (
                Just(nf),
                Just(k),
                n_points,
                any::<u64>(),
                prop_oneof![Just(Metric::Euclidean), Just(Metric::Cosine)],
                prop_oneof![Just(Init::Spectral), Just(Init::Random)],
            )
        })
        .prop_flat_map(|(nf, k, n, seed, metric, init)| {
            // finite values only — a bounded f32 range never yields NaN/inf
            let data = prop::collection::vec(-100.0f32..100.0, n * nf);
            (data, Just(nf), Just(k), Just(n), Just(seed), Just(metric), Just(init))
        })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 64, ..ProptestConfig::default() })]

    #[test]
    fn fit_transform_is_bit_identical_run_to_run(
        (data, nf, k, _n, seed, metric, init) in problem()
    ) {
        let run = || {
            Holomap::builder(seed)
                .n_neighbors(k)
                .metric(metric)
                .init(init)
                .n_epochs(30) // determinism is epoch-count-independent; keep it fast
                .fit_transform(&data, nf)
                .expect("constructed inputs are valid")
        };
        let a = run();
        let b = run();
        // byte-level equality — exactly what "bit-identical" promises
        let bytes = |v: &[f32]| -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() };
        prop_assert_eq!(bytes(&a), bytes(&b));
    }
}
