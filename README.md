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

> **Same-CPU-family caveat, and how it was closed (v0.3.0).** Between 0.2.0 and 0.3.0, two `x86_64-unknown-linux-gnu` machines running the same binary from the same `Cargo.lock` and toolchain could produce different embeddings if their CPU features differed — measured between an Ivy Bridge host (no AVX2/FMA) and a Skylake one (both), reproducibly, and visible downstream as up to 1 cluster and 1.4 points of noise on a 723-row corpus.
>
> **Cause: glibc's libm dispatches through IFUNC at load time**, selecting AVX2/FMA implementations of `exp`/`log`/`pow` based on the CPU it lands on. Not compile-time codegen — rebuilding with `-C target-cpu=` matching the older host did not reproduce its output. Confirmed by masking the selection with `GLIBC_TUNABLES=glibc.cpu.hwcaps=-AVX2,-FMA` on the Skylake host, which reproduced the Ivy Bridge results exactly in all three input regimes, while Rust-side detection (`is_x86_feature_detected!`) was verified unchanged — ruling out `matrixmultiply`, the original suspect.
>
> **Fix: every transcendental now routes through the pure-Rust [`libm`](https://crates.io/crates/libm) crate** (`src/fmath.rs`), so there is no runtime selection left to make. This is what the wasm target had been doing all along — wasm has no system libm — which is exactly why wasm was reproducible when native was not. Native output now matches the wasm build's, rather than being merely self-consistent.
>
> Two consequences worth knowing before upgrading: **0.3.0 changes embeddings on every host**, including hosts the dispatch never affected — the figures from 0.2.0 do not carry over. And it costs throughput: ~1.35× slower on the shipped 1000×50-d bench, measured on the *non*-AVX2 host, so treat that as a lower bound.

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

## Status: v0.3.0 — shipped

| | Milestone | Exit test | |
|---|---|---|---|
| M1 | exact kNN + fuzzy simplicial set | stage intermediates match `umap-learn` 0.5.12 on fixtures | ✅ |
| M2 | spectral (Lanczos) initialization | eigenvector parity vs scipy; deterministic double-run | ✅ |
| M3 | seeded SGD + end-to-end `fit_transform` | trustworthiness vs `umap-learn` on blobs/swiss-roll; bit-identity CI gate | ✅ |
| M4 | API polish, docs, crates.io publish | | ✅ |

**v0.3.0** closes the cross-CPU divergence described above: transcendentals move to the pure-Rust `libm` crate, so output no longer depends on which SIMD kernels glibc's IFUNC resolver picks. **This changes embeddings on every host** — 0.2.0 figures do not carry over — and costs ~1.35× throughput. Native output now agrees with the wasm build's exactly.

**v0.2.0** added: non-finite input rejection, an optional `ndarray` front door (`fit_transform_array`), a property-tested determinism invariant, and a cross-platform CI matrix (Linux/macOS/Windows) backing the parity claim with evidence.

Measured (k=15 trustworthiness, same data, same params): blobs 0.954 vs
umap-learn's 0.955; swiss roll 0.991 vs 0.990. Wall-clock at 1k×50-d points:
~4.5 s release-mode vs umap-learn's ~28 s on the same machine (was ~3 s before 0.3.0; see the throughput note above).

## Scope (v1)

- `fit_transform` via a builder: `n_components`, `n_neighbors`, `min_dist`, `spread`, `metric` (euclidean | cosine), `n_epochs`, `init` (spectral | random), `seed` (required)
- Exact brute-force kNN — deterministic by construction; honest envelope is ≤ ~50k points
- Serial seeded SGD (single PCG64 stream — *all* pipeline randomness lives in one place)
- Dependencies: `rand` + `rand_pcg`, `nalgebra` (pure-Rust eigensolves for the spectral init; Lanczos itself is in-crate), `libm` (host-invariant transcendentals — see `src/fmath.rs`). No BLAS, no LAPACK, no C.
- Optional features: `serde` (serialize the config, seed included — a stored config replays bit-identically); `ndarray` (`fit_transform_array` taking `ArrayView2<f32>` → `Array2<f32>`).

Deliberately out of scope: GPU, parametric/supervised UMAP, densMAP, plotting, unseeded code paths. The crate's identity is **small, auditable, deterministic** — generality is resisted on purpose.

## License

MIT OR Apache-2.0, at your option.
