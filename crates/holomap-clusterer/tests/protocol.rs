use holomap_clusterer::protocol::{Params, Request, Response, PROTOCOL_VERSION};

#[test]
fn request_round_trips_from_json() {
    let json = r#"{
        "protocol_version": 1,
        "vectors": [[0.1, 0.2], [0.3, 0.4]],
        "params": {"n_components": 2, "n_neighbors": 15, "min_cluster_size": 5, "seed": 42}
    }"#;
    let req: Request = serde_json::from_str(json).expect("parse");
    assert_eq!(req.protocol_version, PROTOCOL_VERSION);
    assert_eq!(req.vectors.len(), 2);
    assert_eq!(req.params.seed, 42);
}

#[test]
fn response_serialises_with_version() {
    let resp = Response {
        protocol_version: PROTOCOL_VERSION,
        assignments: vec![0, 0, -1],
        probabilities: Some(vec![0.9, 0.8, 0.0]),
        error: None,
    };
    let out = serde_json::to_string(&resp).expect("serialise");
    assert!(out.contains("\"protocol_version\":1"));
    assert!(out.contains("-1")); // noise label
}

#[test]
fn error_response_omits_optional_fields() {
    let resp = Response {
        protocol_version: PROTOCOL_VERSION,
        assignments: vec![],
        probabilities: None,
        error: Some("vector dimensions inconsistent".to_string()),
    };
    let out = serde_json::to_string(&resp).expect("serialise");
    assert!(out.contains("inconsistent"));
    assert!(!out.contains("probabilities"));
}

#[test]
fn pipeline_rejects_inconsistent_dimensions() {
    let req = Request {
        protocol_version: PROTOCOL_VERSION,
        vectors: vec![vec![0.1, 0.2], vec![0.3]],
        params: holomap_clusterer::protocol::Params {
            n_components: 2,
            n_neighbors: 15,
            min_cluster_size: 5,
            seed: 42,
        },
    };
    let resp = holomap_clusterer::pipeline::run_pipeline(&req);
    assert!(resp.error.as_deref().unwrap_or("").contains("inconsistent"));
}

// ── Task 2 + 3 tests ─────────────────────────────────────────────────────────

/// Three well-separated Gaussian-ish blobs in 8-d must yield exactly 3
/// clusters with near-zero noise. Deterministic LCG — no rand dep.
fn blobs() -> Vec<Vec<f32>> {
    let mut state: u64 = 42;
    let mut next = move || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((state >> 33) as f32 / u32::MAX as f32) - 0.5
    };
    let mut vectors = Vec::new();
    for blob in 0..3 {
        for _ in 0..30 {
            let mut v = vec![0.0f32; 8];
            v[blob * 2] = 10.0;
            for x in v.iter_mut() {
                *x += next() * 0.5;
            }
            vectors.push(v);
        }
    }
    vectors
}

#[test]
fn hdbscan_separates_three_blobs() {
    let req = Request {
        protocol_version: 1,
        vectors: blobs(),
        params: Params {
            n_components: 0, // skip reduction
            n_neighbors: 15,
            min_cluster_size: 5,
            seed: 42,
        },
    };
    let resp = holomap_clusterer::pipeline::run_pipeline(&req);
    assert!(resp.error.is_none(), "pipeline errored: {:?}", resp.error);
    let mut labels: Vec<i32> = resp.assignments.clone();
    labels.sort_unstable();
    labels.dedup();
    let clusters = labels.iter().filter(|&&l| l >= 0).count();
    assert_eq!(clusters, 3);
    let noise = resp.assignments.iter().filter(|&&l| l == -1).count();
    assert!(noise <= 5, "too much noise: {noise}");
}

#[test]
fn reduced_pipeline_is_deterministic_for_fixed_seed() {
    let mut vectors = blobs();
    for v in vectors.iter_mut() {
        v.resize(32, 0.0);
    }
    let make_req = || Request {
        protocol_version: 1,
        vectors: vectors.clone(),
        params: Params {
            n_components: 5,
            n_neighbors: 15,
            min_cluster_size: 5,
            seed: 1234,
        },
    };
    let a = holomap_clusterer::pipeline::run_pipeline(&make_req());
    let b = holomap_clusterer::pipeline::run_pipeline(&make_req());
    assert!(a.error.is_none(), "{:?}", a.error);
    assert_eq!(a.assignments, b.assignments, "same seed must give identical labels");
    // and the structure should still be recoverable after reduction
    let clusters = {
        let mut l = a.assignments.clone();
        l.sort_unstable();
        l.dedup();
        l.iter().filter(|&&x| x >= 0).count()
    };
    assert_eq!(clusters, 3, "blob structure must survive reduction");
}

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
