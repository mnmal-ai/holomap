# holomap

**Deterministic UMAP in Rust.** *The bulk, on the boundary.*

The holographic principle says the information of an N-dimensional volume can be encoded on its (N−1)-dimensional surface. `holomap` does that for your data: UMAP-class dimensionality reduction whose defining feature is not speed — it's the contract.

## The contract

> **Same input + same params + same seed → bit-identical embedding.**

On the same platform/toolchain, two runs produce byte-equal output, verified in CI by running twice and comparing raw bytes. Cross-platform, embeddings are structurally identical (floats may differ at ULP level). There is **no unseeded constructor** — `seed: u64` is a required builder argument, by design, forever.

## Why

Every UMAP-class crate in the Rust ecosystem draws from OS entropy with no seed in its public API (verified source-level across `annembed`, `umap-rs`, `fast-umap`, 2026-06). Python's `umap-learn` has had `random_state` from the start, because anyone building **replayable, testable pipelines** on embeddings — eval harnesses, regression gates, reproducible research — needs identical output on identical input. That's table stakes, and it was missing here.

## Status: pre-M1

The scaffold is real; the algorithm is landing in milestones:

| | Milestone | Exit test |
|---|---|---|
| M1 | exact kNN + fuzzy simplicial set | stage intermediates match `umap-learn` on fixtures |
| M2 | spectral (Lanczos) initialization | eigenvector parity vs scipy; deterministic double-run |
| M3 | seeded SGD + end-to-end `fit_transform` | trustworthiness vs `umap-learn` on blobs/swiss-roll; bit-identity CI gate |
| M4 | API polish, docs, crates.io publish | |

## Scope (v1)

- `fit_transform` via a builder: `n_components`, `n_neighbors`, `min_dist`, `spread`, `metric` (euclidean | cosine), `n_epochs`, `init` (spectral | random), `seed` (required)
- Exact brute-force kNN — deterministic by construction; honest envelope is ≤ ~50k points
- Serial seeded SGD (single PCG64 stream — *all* pipeline randomness lives in one place)
- Dependencies: `rand` + `rand_pcg`, optional `serde`. No BLAS, no LAPACK, no C.

Deliberately out of scope: GPU, parametric/supervised UMAP, densMAP, plotting, unseeded code paths. The crate's identity is **small, auditable, deterministic** — generality is resisted on purpose.

## License

MIT OR Apache-2.0, at your option.
