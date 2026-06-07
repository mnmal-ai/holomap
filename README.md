# holomap

[![crates.io](https://img.shields.io/crates/v/holomap.svg)](https://crates.io/crates/holomap)
[![docs.rs](https://docs.rs/holomap/badge.svg)](https://docs.rs/holomap)
[![CI](https://github.com/mnmal-ai/holomap/actions/workflows/ci.yml/badge.svg)](https://github.com/mnmal-ai/holomap/actions/workflows/ci.yml)

**Deterministic UMAP in Rust.** *The bulk, on the boundary.*

The holographic principle says the information of an N-dimensional volume can be encoded on its (N−1)-dimensional surface. `holomap` does that for your data: UMAP-class dimensionality reduction whose defining feature is not speed — it's the contract.

## The contract

> **Same input + same params + same seed → bit-identical embedding.**

On the same platform/toolchain, two runs produce byte-equal output, verified in CI by running twice and comparing raw bytes. Cross-platform, embeddings are structurally identical (floats may differ at ULP level). There is **no unseeded constructor** — `seed: u64` is a required builder argument, by design, forever.

## Why: every UMAP crate in Rust is non-deterministic

This isn't a gap we guessed at — we read the source. As of 2026-06, no UMAP-class Rust crate exposes a seed:

| Crate | Version | Why it can't be reproduced |
|---|---|---|
| `annembed` | 0.1.6 | `EmbedderParams` has no seed field; the embedder draws from `rand::rng()` (OS-entropy thread-local) at init and throughout the gradient loop; the `hnsw_rs` kNN backend seeds from OS entropy too |
| `umap-rs` | 0.4 | no seed in the public API |
| `fast-umap` | 1.6 | no seed in the public API |
| `petal-decomposition` | 0.7 | PCA only (and needs system LAPACK) — not UMAP-class |

Python's `umap-learn` has had `random_state` since the start. The Rust ecosystem never did.

### What that costs you

Non-determinism is invisible until it isn't:

- **You can't regression-test an embedding.** "Did my refactor change the output?" is unanswerable when every run differs anyway.
- **You can't reproduce research.** A paper, a notebook, a result that says "embed with these params" doesn't replay.
- **Eval harnesses flake.** Anything downstream of the embedding — clustering counts, neighbourhood metrics, a golden-row suite — inherits the noise and starts failing intermittently.
- **Debugging is a guessing game.** You can't bisect a quality regression when the baseline moves under you.

The usual workaround — run it many times and average, or pin a process and never touch it — is a tax you pay forever. A seed removes the tax.

### How holomap makes the contract hold

Determinism here is structural, not bolted on:

- **One PRNG, one place.** *All* pipeline randomness — SGD negative sampling, optional random init, the spectral init's noise — comes from a single seeded PCG64 stream in a fixed draw order. There is no second source of entropy to forget about.
- **No unseeded path exists.** `seed: u64` is a required builder argument. You cannot construct a run that draws from the OS, because the type system doesn't offer one.
- **Deterministic by construction where it can be.** Exact brute-force kNN (ties broken by index); a fixed Lanczos start vector for the spectral init (no RNG in the eigensolve at all); edge iteration over sorted CSR structure, never hash-map order.

The result is checked, not asserted: CI runs `fit_transform` twice and compares raw bytes, and a property test asserts byte-identity across 64 randomized seeds/shapes/params each run.

### The honest envelope

The trade for exactness is scale: brute-force kNN is O(N²·d), so the honest ceiling is **≤ ~50k points**. Same-platform output is byte-identical; cross-platform it's *structurally* identical — and in practice the staged intermediates match the `umap-learn`/`scipy` references to within 1e-5 on Linux, macOS, and Windows alike (the parity suite runs on all three). Seeded approximate-NN for larger N is a future direction, not a v1 promise.

holomap exists because we hit this wall building a concept-formation clusterer and needed the contract immediately. We filled the gap rather than working around it.

## Install

```sh
cargo add holomap
```

```rust
use holomap::Holomap;

let embedding = Holomap::builder(42)   // the seed is a required argument
    .n_neighbors(15)
    .min_dist(0.1)
    .fit_transform(&data, n_features)?;
```

## Status: v0.1.0 — all milestones shipped

| | Milestone | Exit test | |
|---|---|---|---|
| M1 | exact kNN + fuzzy simplicial set | stage intermediates match `umap-learn` 0.5.12 on fixtures | ✅ |
| M2 | spectral (Lanczos) initialization | eigenvector parity vs scipy; deterministic double-run | ✅ |
| M3 | seeded SGD + end-to-end `fit_transform` | trustworthiness vs `umap-learn` on blobs/swiss-roll; bit-identity CI gate | ✅ |
| M4 | API polish, docs, crates.io publish | | ✅ |

Measured (k=15 trustworthiness, same data, same params): blobs 0.954 vs
umap-learn's 0.955; swiss roll 0.991 vs 0.990. Wall-clock at 1k×50-d points:
~3 s release-mode vs umap-learn's ~28 s on the same machine; at 10k×50-d, ~26 s vs ~69 s (`cargo run --release --example bench -- 10000`).

## Scope (v1)

- `fit_transform` via a builder: `n_components`, `n_neighbors`, `min_dist`, `spread`, `metric` (euclidean | cosine), `n_epochs`, `init` (spectral | random), `seed` (required)
- Exact brute-force kNN — deterministic by construction; honest envelope is ≤ ~50k points
- Serial seeded SGD (single PCG64 stream — *all* pipeline randomness lives in one place)
- Dependencies: `rand` + `rand_pcg`, `nalgebra` (pure-Rust eigensolves for the spectral init; Lanczos itself is in-crate). No BLAS, no LAPACK, no C.
- Optional features: `serde` (serialize the config, seed included — a stored config replays bit-identically); `ndarray` (`fit_transform_array` taking `ArrayView2<f32>` → `Array2<f32>`).

Deliberately out of scope: GPU, parametric/supervised UMAP, densMAP, plotting, unseeded code paths. The crate's identity is **small, auditable, deterministic** — generality is resisted on purpose.

## License

MIT OR Apache-2.0, at your option.
