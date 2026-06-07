//! Generic example: reduce a TSV of float vectors with Holomap.
//!
//! Input: one row per line, tab-separated float values (all rows must have the
//! same number of columns = n_features).
//!
//! Usage:
//!   reduce_tsv <input.tsv> [output.tsv] [options]
//!
//! Options (all optional, parsed as --key value pairs):
//!   --n-components  <usize>   output dimensionality     (default: 2)
//!   --n-neighbors   <usize>   kNN neighbourhood size    (default: 15)
//!   --seed          <u64>     RNG seed                   (default: 42)
//!   --metric        <str>     "euclidean" | "cosine"     (default: euclidean)
//!   --timing                  emit a machine-readable timing line on stderr:
//!                             `timing fit_transform_seconds=<secs>`
//!
//! If output.tsv is omitted or "-", the embedding is written to stdout.
//! Each output row has n_components tab-separated f32 values.

use holomap::{Holomap, Metric};
use std::io::{BufRead, Write};

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // --- positional args (input, optional output) ----------------------------
    let positional: Vec<&str> = args[1..]
        .iter()
        .filter(|a| !a.starts_with("--"))
        .map(String::as_str)
        .collect();

    if positional.is_empty() {
        eprintln!(
            "usage: reduce_tsv <input.tsv> [output.tsv] [--n-components N] [--n-neighbors N] [--seed S] [--metric euclidean|cosine]"
        );
        std::process::exit(1);
    }
    let input_path = positional[0];
    let output_path = positional.get(1).copied();

    // --- keyword args --------------------------------------------------------
    let kw = parse_kw(&args[1..]);
    let n_components: usize = kw
        .get("n-components")
        .and_then(|v| v.parse().ok())
        .unwrap_or(2);
    let n_neighbors: usize = kw
        .get("n-neighbors")
        .and_then(|v| v.parse().ok())
        .unwrap_or(15);
    let seed: u64 = kw.get("seed").and_then(|v| v.parse().ok()).unwrap_or(42);
    let metric: Metric = kw
        .get("metric")
        .map(|s| {
            s.parse().unwrap_or_else(|e| {
                eprintln!("{e}");
                std::process::exit(1);
            })
        })
        .unwrap_or(Metric::Euclidean);
    let timing = args.iter().any(|a| a == "--timing");

    // --- read input ----------------------------------------------------------
    let file = std::fs::File::open(input_path).unwrap_or_else(|e| {
        eprintln!("cannot open {input_path}: {e}");
        std::process::exit(1)
    });
    let reader = std::io::BufReader::new(file);

    let mut data: Vec<f32> = Vec::new();
    let mut n_features: Option<usize> = None;
    let mut n_rows = 0usize;

    for (lineno, line) in reader.lines().enumerate() {
        let line = line.unwrap_or_else(|e| {
            eprintln!("read error at line {lineno}: {e}");
            std::process::exit(1);
        });
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let vals: Vec<f32> = line
            .split('\t')
            .map(|s| {
                s.trim().parse::<f32>().unwrap_or_else(|e| {
                    eprintln!("parse error at line {lineno}, value {s:?}: {e}");
                    std::process::exit(1);
                })
            })
            .collect();

        match n_features {
            None => n_features = Some(vals.len()),
            Some(f) if f != vals.len() => {
                eprintln!("line {lineno}: expected {f} columns, got {}", vals.len());
                std::process::exit(1);
            }
            _ => {}
        }
        data.extend_from_slice(&vals);
        n_rows += 1;
    }

    let n_features = n_features.unwrap_or_else(|| {
        eprintln!("input file is empty");
        std::process::exit(1);
    });

    eprintln!(
        "holomap: {n_rows} rows × {n_features} features → {n_components} components \
         (n_neighbors={n_neighbors}, metric={metric}, seed={seed})"
    );

    // --- reduce --------------------------------------------------------------
    let t0 = std::time::Instant::now();
    let embedding = Holomap::builder(seed)
        .n_components(n_components)
        .n_neighbors(n_neighbors)
        .metric(metric)
        .build()
        .fit_transform(&data, n_features)
        .unwrap_or_else(|e| {
            eprintln!("holomap error: {e}");
            std::process::exit(1);
        });
    let elapsed = t0.elapsed().as_secs_f64();
    eprintln!("holomap: done in {elapsed:.2}s");
    if timing {
        eprintln!("timing fit_transform_seconds={elapsed:.6}");
    }

    // --- write output --------------------------------------------------------
    let mut out: Box<dyn Write> = match output_path {
        Some(p) if p != "-" => Box::new(std::io::BufWriter::new(
            std::fs::File::create(p).unwrap_or_else(|e| {
                eprintln!("cannot create {p}: {e}");
                std::process::exit(1);
            }),
        )),
        _ => Box::new(std::io::BufWriter::new(std::io::stdout())),
    };

    for row in embedding.chunks(n_components) {
        let parts: Vec<String> = row.iter().map(|v| format!("{v}")).collect();
        writeln!(out, "{}", parts.join("\t")).unwrap_or_else(|e| {
            eprintln!("write error: {e}");
            std::process::exit(1);
        });
    }
}

/// Parse `--key value` pairs from an arg slice. Keys are lowercased,
/// leading `--` stripped. Adjacent positional values are ignored.
fn parse_kw(args: &[String]) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let mut i = 0;
    while i < args.len() {
        if let Some(key) = args[i].strip_prefix("--") {
            if i + 1 < args.len() && !args[i + 1].starts_with("--") {
                map.insert(key.to_lowercase(), args[i + 1].clone());
                i += 2;
                continue;
            }
        }
        i += 1;
    }
    map
}
