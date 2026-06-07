//! M3 exit gate — embedding quality and the determinism contract, exercised
//! through the public API only.
//!
//! Quality bar: trustworthiness(k=15) within 0.05 of umap-learn 0.5.12 on
//! the same data (fixture carries the reference value). Seed sensitivity:
//! different seeds must both clear the bar while producing different
//! embeddings (structure is stable, layout is not).

use holomap::Holomap;
use serde_json::Value;

struct Fixture {
    name: String,
    n_features: usize,
    k_trust: usize,
    umap_t: f64,
    data: Vec<f32>,
}

fn load(name: &str) -> Fixture {
    let path = format!(
        "{}/tests/fixtures/quality_{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    Fixture {
        name: name.to_string(),
        n_features: v["n_features"].as_u64().unwrap() as usize,
        k_trust: v["k_trust"].as_u64().unwrap() as usize,
        umap_t: v["umap_trustworthiness"].as_f64().unwrap(),
        data: v["data"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|row| row.as_array().unwrap().iter())
            .map(|x| x.as_f64().unwrap() as f32)
            .collect(),
    }
}

/// sklearn-equivalent trustworthiness: penalise embedding-neighbours that
/// are far in data space. Ranks use (distance, index) ordering — sklearn's
/// stable argsort tie-break.
fn trustworthiness(data: &[f32], nf: usize, emb: &[f32], dim: usize, k: usize) -> f64 {
    let n = data.len() / nf;
    let dist2 = |a: &[f32], b: &[f32]| -> f64 {
        a.iter()
            .zip(b)
            .map(|(&x, &y)| (f64::from(x) - f64::from(y)).powi(2))
            .sum()
    };

    let mut penalty = 0.0_f64;
    for i in 0..n {
        // data-space ranks of every j ≠ i (1-based)
        let di = &data[i * nf..(i + 1) * nf];
        let mut by_data: Vec<(f64, usize)> = (0..n)
            .filter(|&j| j != i)
            .map(|j| (dist2(di, &data[j * nf..(j + 1) * nf]), j))
            .collect();
        by_data.sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        let mut rank = vec![0_usize; n];
        for (r, &(_, j)) in by_data.iter().enumerate() {
            rank[j] = r + 1;
        }

        // k nearest in the embedding
        let ei = &emb[i * dim..(i + 1) * dim];
        let mut by_emb: Vec<(f64, usize)> = (0..n)
            .filter(|&j| j != i)
            .map(|j| (dist2(ei, &emb[j * dim..(j + 1) * dim]), j))
            .collect();
        by_emb.sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        for &(_, j) in by_emb.iter().take(k) {
            penalty += (rank[j] as f64 - k as f64).max(0.0);
        }
    }
    let n = n as f64;
    let k = k as f64;
    1.0 - 2.0 / (n * k * (2.0 * n - 3.0 * k - 1.0)) * penalty
}

fn run_gate(fixture: &Fixture, seed: u64) -> (Vec<f32>, f64) {
    let emb = Holomap::builder(seed)
        .fit_transform(&fixture.data, fixture.n_features)
        .unwrap();
    let t = trustworthiness(&fixture.data, fixture.n_features, &emb, 2, fixture.k_trust);
    (emb, t)
}

fn quality_gate(name: &str) {
    let fixture = load(name);
    let bar = fixture.umap_t - 0.05;

    let (emb_a, t_a) = run_gate(&fixture, 42);
    println!(
        "{}: holomap t={t_a:.4} vs umap {:.4}",
        fixture.name, fixture.umap_t
    );
    assert!(
        t_a >= bar,
        "{name}: trustworthiness {t_a:.4} below bar {bar:.4} (umap: {:.4})",
        fixture.umap_t
    );

    // seed sensitivity: a different seed also clears the bar but produces a
    // different layout
    let (emb_b, t_b) = run_gate(&fixture, 7);
    assert!(
        t_b >= bar,
        "{name}: seed 7 trustworthiness {t_b:.4} below bar {bar:.4}"
    );
    assert_ne!(emb_a, emb_b, "{name}: different seeds must differ");
}

#[test]
fn quality_gate_blobs() {
    quality_gate("blobs");
}

#[test]
fn quality_gate_swiss_roll() {
    quality_gate("swiss_roll");
}

/// The headline CI determinism gate: full fit_transform double-run,
/// byte-compared, through the public API.
#[test]
fn determinism_gate_double_run() {
    let fixture = load("blobs");
    let run = || {
        Holomap::builder(2026)
            .fit_transform(&fixture.data, fixture.n_features)
            .unwrap()
    };
    let a = run();
    let b = run();
    assert_eq!(a, b, "fit_transform must be bit-identical across runs");
    // byte-level comparison, exactly what the contract promises
    let bytes = |v: &[f32]| -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() };
    assert_eq!(bytes(&a), bytes(&b));
}
