# holomap-clusterer

**Deterministic reduce→cluster, all Rust.** `holomap` UMAP → HDBSCAN, same input and seed, same assignments.

This crate is a pipeline, not an algorithm. It composes two deterministic pieces into one that stays deterministic, and it ships two front doors onto that pipeline: a JSON-lines binary for out-of-process callers, and a WebAssembly binding for in-process ones.

## The contract

> **Same input + same params + same seed → identical assignments.**

Neither stage is allowed to leak entropy. `holomap` takes `seed: u64` as a required constructor argument and draws all pipeline randomness from one PCG64 stream. `hdbscan` is graph-based — Prim's MST plus single-linkage condensation — and uses no RNG at all. There is no thread pool in either path (see below). So the composition has exactly one source of variability, and it is the seed you passed.

`tests/fixture_regression.rs` pins this against a real corpus rather than asserting it.

## Technology choices, and why

### Reduction: `holomap` 0.2 — not PCA, not Python

The first attempt at this pipeline used PCA via nalgebra's SVD, because it was the only viable reduction in the Rust ecosystem. It doesn't work for the job: PCA is a linear transform and cannot preserve the local neighbourhood density of 1024-d cosine-normalised text embeddings. HDBSCAN is a *density* algorithm, so a reduction that flattens density hands it nothing to find.

UMAP is the right reduction. But as of 2026-06 no UMAP-class Rust crate exposes a seed — `annembed` draws from `rand::rng()` (OS entropy) throughout its gradient loop, and `umap-rs`, `fast-umap` and `petal-decomposition` have no seed in their public APIs at all. That's why [`holomap`](../..) exists: it was written to fill this gap, for this pipeline. Determinism was not a nice-to-have here — a clustering you cannot reproduce is a clustering you cannot regression-test, bisect, or attribute a quality change to.

The alternative was a Python sidecar around `umap-learn` + `sklearn`, which is what the original prototype did. That works and it is fast, but it makes every consumer install and manage a Python environment. For a library whose two intended consumers are a TypeScript runtime and a Rust binary, that is a heavy tax to pay forever.

### Clustering: `hdbscan` 0.12, `serial` feature only

```toml
hdbscan = { version = "0.12", default-features = false, features = ["serial"] }
```

The `parallel` feature (rayon) is **deliberately off**. Parallel MST construction admits thread-scheduling non-determinism, and determinism is the product. This is not a performance oversight to fix later — turning rayon on would break the contract this crate exists to provide.

HDBSCAN rather than k-means because the number of concepts in a corpus is not known in advance and is exactly the thing you want the algorithm to tell you, and because "this point belongs to nothing" (label `-1`) is a real and useful answer that k-means cannot give.

### Metric: cosine into the reduction, Euclidean into the clusterer

Corpus embeddings are L2-normalised text vectors, so `Metric::Cosine` is the natural distance for the kNN stage and matches the Python baseline's `metric='cosine'`. On the unit sphere cosine and squared-Euclidean are equivalent, but the cosine path accumulates its dot product in f64 and gives numerically cleaner distances.

HDBSCAN then runs on the *reduced* coordinates with `DistanceMetric::Euclidean`, which is correct — the reduction's output is an ordinary low-dimensional embedding, not a normalised one.

## Three parameter choices that are load-bearing

Each of these looks wrong at a glance and is right. All three are guarded by `tests/fixture_regression.rs`; changing any of them silently halves the cluster yield.

**`min_samples` is never set.** The `hdbscan` crate then defaults it to `min_cluster_size`, matching sklearn's `HDBSCAN(min_cluster_size=5)` behaviour when `min_samples=None`. Setting it to `n_neighbors` collapsed the reference corpus from **36 clusters to 8**.

**`min_dist` stays at holomap's default 0.1 — never 0.0.** The Python baseline calls `UMAP(min_dist=0.0)`, so matching it looks like the obviously correct consistency fix. It regresses the corpus to **13 clusters / 45.2% noise**: holomap's SGD schedule handles the zero-min-dist edge case differently from umap-learn's. This is the trap in the crate.

**`spread` (1.0) and `n_epochs` (auto) are left at holomap's defaults**, which already match umap-learn's. Only `n_components`, `n_neighbors`, `metric` and `seed` are overridden from the protocol params.

## Reference figures — read the attribution

On the 723-row filtered reference corpus at `n_components=10, n_neighbors=15, min_cluster_size=5, seed=42`:

| Pipeline | Clusters | Noise |
|---|---|---|
| holomap reduction → **sklearn** HDBSCAN | 36 | 27.2% |
| holomap reduction → **Rust `hdbscan` 0.12** (this crate) | 36 | 30.0% |

**The widely-quoted "36 / 27.2%" validated the *reduction*, using a Python clusterer** (coda's `holomap_gate.py` imports `sklearn.cluster.HDBSCAN`). This crate's own all-Rust baseline is **36 / 30.0%** — same cluster count, ~3 points more noise. Quoting 27.2% as this pipeline's number is a misattribution. Both sit inside the 30–60 clusters / 10–35% noise envelope the consumer's design requires.

That baseline is measured on **raw** corpus floats. Read the next section before comparing anything against it.

## Deterministic is not the same as numerically stable

The determinism contract holds: same input, same params, same seed, same assignments, every time. It is verified, it is the product, and nothing below weakens it.

It does not imply the neighbouring property, and the difference matters in practice. *Near*-identical input does not give near-identical output. HDBSCAN is a density algorithm, so a perturbation far below any meaningful precision moves points across cluster boundaries, and the effect compounds through the reduction ahead of it.

Measured on the 723-row corpus at the pinned params. All three inputs are the same vectors to within float32 rounding, and since `run_pipeline` L2-normalises internally as step 1, pre-normalising is **mathematically a no-op**:

| input | clusters | noise |
|---|---|---|
| raw | 36 | 30.0% (217 rows) |
| normalised, norm accumulated in f32 | 37 | 29.2% (211 rows) |
| normalised, norm accumulated in f64 | 34 | 27.2% (197 rows) |

A spread of 3 clusters and 20 noise rows, produced entirely by how a division was rounded. A fourth path — coda's `EmbeddingsGateway`, normalising its own way — reported 33 / 25.4%, which neither variant here reproduces.

### It also does not survive a change of machine

Same commit, same `rustc` 1.97.1, byte-identical `Cargo.lock`, same corpus verified by sha256. Only the CPU differs:

| Input regime | i5-3470S (Ivy Bridge) | i7-6820HQ (Skylake) |
|---|---|---|
| raw | 36 / 30.0% | 36 / 31.4% |
| normalised, f32 | 37 / 29.2% | 36 / 28.9% |
| normalised, f64 | 34 / 27.2% | 33 / 27.7% |

The Ivy Bridge baseline was re-run as a control immediately afterwards, unchanged — reproducible, not drift. All values stay inside the 30–60 / 10–35% envelope; the bands hold, the exact figures do not.

This is **not** compile-time instruction selection. Rebuilding on the Skylake host with `-C target-cpu=ivybridge` (42 crates recompiled, verified) still produced the Skylake numbers. That is consistent with **runtime CPU-feature dispatch** in a dependency — `matrixmultiply` via `nalgebra` does this and is the obvious suspect, but it is unconfirmed and is not asserted here.

Notably, the **WebAssembly build of this same pipeline does not diverge**: identical output on both hosts. wasm's floating-point arithmetic is IEEE-754 correctly-rounded and deterministic by specification, with no runtime feature detection and no fused multiply-add to contract differently. That makes the wasm binding the reproducible way to run this crate across machines — a property discovered rather than designed. See the npm package's README.

Two consequences worth taking seriously:

- **Do not treat any single figure as *the* result for a corpus.** It is the result for that corpus *as you fed it*. A consumer that L2-normalises at its boundary — which every TypeScript consumer does, since raw bge-m3 is not unit length — is in a different regime from this crate's published baseline and should expect different numbers. coda's integration nearly reported a false regression on exactly this.
- **"Structurally identical cross-platform" is a weaker guarantee than it sounds.** Any cross-platform float difference is amplified the same way. That is why `tests/fixture_regression.rs` gates the MVD's *band* across every regime rather than pinning an exact count in one of them — an equality assertion would pin one arbitrary point of a sensitive function and call it a contract.

The 27.2% in the f64 row is a **coincidence**. sklearn's figure for this corpus is also 27.2%, by a completely different route. They are unrelated numbers that happen to collide; reading it as the two pipelines converging would be wrong.

## The honest envelope

holomap's kNN is exact brute force — O(N²·d) — so the ceiling is **~50k rows**. That is a deliberate trade: exactness is what makes the kNN stage deterministic by construction rather than by seeding an approximation. Seeded ANN for larger N is a future direction, not a promise.

The wasm binding enforces this as a hard `MAX_ROWS = 50_000` guard. The native binary does not — see the npm package's README for why the ceiling is wasm-specific.

## Using it

### As a library

```rust
use holomap_clusterer::pipeline::run_pipeline;
use holomap_clusterer::protocol::{Params, Request, PROTOCOL_VERSION};

let response = run_pipeline(&Request {
    protocol_version: PROTOCOL_VERSION,
    vectors,                       // Vec<Vec<f32>>, any dimensionality
    params: Params {
        n_components: 10,          // 0 = skip reduction, cluster the input directly
        n_neighbors: 15,
        min_cluster_size: 5,
        seed: 42,
    },
});
// response.assignments: Vec<i32>, one label per input row; -1 = noise.
```

Errors are returned **in band** as `response.error`, never as a panic or a process abort. That is deliberate: the binary below is a long-lived per-line server, and one bad request must not take down the batch behind it.

### As a JSON-lines peripheral

```sh
cargo build --release -p holomap-clusterer
echo '{"protocol_version":1,"vectors":[[…]],"params":{…}}' | ./target/release/holomap-clusterer
```

One JSON request per stdin line, one JSON response per stdout line. This is what `SubprocessClusterer` in the npm package speaks.

### As WebAssembly

```sh
bash scripts/build-wasm.sh     # from the repo root
```

Behind the `wasm` feature, so the native crate and binary are untouched by it. `wasm-pack` 0.15.0 is broken against cargo 1.95.0 (it invokes the removed `cargo build --out-dir`), so use the script — it also derives the `wasm-bindgen-cli` version from `Cargo.lock`, which must match the `wasm-bindgen` crate version exactly.

## `probabilities` is always `None`

`hdbscan` 0.12's `.cluster()` returns labels only — there is no membership-probability API to expose. The field exists in the protocol for forward compatibility and is never populated by this crate. Don't build a consumer that expects it.

## What this crate does not do

- **No clustering policy.** It proposes assignments. Deciding whether a proposed cluster becomes a durable concept — and what happens to identity when a later run disagrees — belongs to the consumer.
- **No hygiene filtering.** Callers filter their corpus before calling. Synthetic fixtures out-dense lived experience and will dominate a clustering that includes them.
- **No generality pushed into `holomap`.** That crate's identity is small, auditable and deterministic; this one composes it rather than growing it.

## License

MIT OR Apache-2.0, at your option.
