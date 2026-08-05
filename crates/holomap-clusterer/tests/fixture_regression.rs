//! Reference-corpus regression gate.
//!
//! The unit suite proves the code is wired correctly. This proves the
//! PIPELINE still behaves: 36 clusters / 27.2% noise on the real 723-row
//! corpus, the result the standalone holomap gate established 2026-06-07.
//!
//! Env-gated because the fixture is 9.4 MB and lives outside this repo.
//! Unset HOLOMAP_CLUSTERER_FIXTURE and this skips, exactly like hydra's
//! POSTGRES_URL-gated suites.
//!
//!   HOLOMAP_CLUSTERER_FIXTURE=/mnt/data/Develop/coda-fixtures/2026-06-05-claude-corpus-799.tsv \
//!     cargo test -p holomap-clusterer --test fixture_regression -- --nocapture
//!
//! Fixture format: 6 tab-separated columns; col 5 is the text (used to
//! exclude synthetic rows), col 6 is a JSON array of 1024 floats.

use holomap_clusterer::pipeline::run_pipeline;
use holomap_clusterer::protocol::{Params, Request, PROTOCOL_VERSION};

/// Load the corpus, excluding the 76 synthetic perf fixtures. Coda's MVD §5
/// found those near-duplicates form the densest regions in the whole corpus
/// and dominate naive clustering — they must go before the clusterer sees
/// the data, not after.
fn load_fixture(path: &str) -> Vec<Vec<f32>> {
    let raw = std::fs::read_to_string(path).expect("fixture readable");
    raw.lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split('\t').collect();
            if cols.len() < 6 {
                return None;
            }
            if cols[4].starts_with("Seed session ") || cols[4].starts_with("perf-seed-memory-") {
                return None;
            }
            let vec: Vec<f32> = cols[5]
                .trim_matches(['[', ']'].as_ref())
                .split(',')
                .map(|x| x.trim().parse::<f32>().expect("float"))
                .collect();
            Some(vec)
        })
        .collect()
}

#[test]
fn reference_corpus_reproduces_the_established_result() {
    let Ok(path) = std::env::var("HOLOMAP_CLUSTERER_FIXTURE") else {
        eprintln!("skipping: HOLOMAP_CLUSTERER_FIXTURE unset");
        return;
    };

    let vectors = load_fixture(&path);
    assert_eq!(vectors.len(), 723, "expected 799 rows minus 76 synthetic");
    assert_eq!(vectors[0].len(), 1024, "bge-m3 dimensionality");

    let resp = run_pipeline(&Request {
        protocol_version: PROTOCOL_VERSION,
        vectors,
        params: Params {
            n_components: 10,
            n_neighbors: 15,
            min_cluster_size: 5,
            seed: 42,
        },
    });
    assert!(resp.error.is_none(), "pipeline errored: {:?}", resp.error);

    let mut labels = resp.assignments.clone();
    labels.sort_unstable();
    labels.dedup();
    let clusters = labels.iter().filter(|&&l| l >= 0).count();
    let noise = resp.assignments.iter().filter(|&&l| l == -1).count();
    let noise_pct = 100.0 * noise as f64 / resp.assignments.len() as f64;

    eprintln!("clusters={clusters} noise={noise_pct:.1}%");

    // The MVD's established envelope. Deliberately a band, not an equality:
    // a dependency patch may shift the exact count without breaking the
    // pipeline, but leaving this band means something real changed.
    assert!(
        (30..=60).contains(&clusters),
        "cluster count {clusters} outside the 30-60 gate"
    );
    assert!(
        (10.0..=35.0).contains(&noise_pct),
        "noise {noise_pct:.1}% outside the 10-35% gate"
    );
}
