# `holomap-cluster` — deterministic reduce→cluster as a wasm npm package

**Date:** 2026-08-05 · **Status:** design, pending Phase-0 spike · **Repo:** `mnmal-ai/holomap`

## Goal

Ship one deterministic `reduce_and_cluster` entry point — holomap for the reduction, `hdbscan` for the clustering — compiled to WebAssembly and published as an npm package, so a TypeScript consumer can run the whole pipeline in-process without Python, a native addon, or a sidecar process.

The first consumer is `hydra-recall`'s crystallisation route (project B, specced separately in the hydra repo). Nothing in this package knows that. It takes vectors and returns cluster assignments.

## Why this exists

Coda's 2026-06 clusterer spike (`coda/docs/2026-06-06-phase0-clusterer-spike-findings.md`) reached a **FALLBACK-Python** verdict: the Rust stack failed both hard gates because PCA is degenerate on text embeddings (3 clusters, 85.6% noise against a 30–60 / 10–35% bar) and no seedable UMAP-class Rust crate existed. holomap was built to close exactly that gap.

With holomap the reduction stage is available in Rust and deterministic by construction. The clustering stage already was — that spike selected `hdbscan` 0.12 on determinism grounds; only the reducer failed. So the pipeline is now fully Rust and fully deterministic, and the Python verdict is obsolete.

Measured 2026-08-05, both crates compile clean to `wasm32-unknown-unknown`:

| Crate | Result |
|---|---|
| `holomap` 0.2.0 | `cargo build --release --target wasm32-unknown-unknown --lib` → exit 0, 19s |
| `hdbscan` 0.12.0 | `cargo build --release --target wasm32-unknown-unknown --lib` → exit 0, 4.5s |

Neither pulls a C dependency, BLAS, LAPACK, or OS entropy. holomap's "no unseeded path exists" design is what makes the wasm target clean: there is no `getrandom` backend to satisfy.

## Non-goals

- **No clustering policy.** This package proposes cluster assignments. What a cluster *means*, when it is promoted, how it splits or merges, and what row it becomes are all consumer concerns. Coda's MVD §4 is the governing constraint: *"concept identity cannot be re-derived by re-running a global clustering."*
- **No persistence, no I/O, no network.** Pure function: vectors in, assignments out.
- **No hygiene filtering.** Coda's MVD §5 found synthetic fixtures out-dense lived experience and dominate naive clustering. Filtering is the consumer's job, applied before the vectors reach this package.
- **No generality in `holomap` itself.** holomap's stated identity is "small, auditable, deterministic — generality is resisted on purpose." Composing it with a clusterer belongs in a sibling crate, never inside it.
- **No GPU, no approximate kNN, no scale beyond holomap's envelope.** See *Scale ceiling*.

## Architecture

### Repo layout

holomap's root `Cargo.toml` is currently a single-package manifest with no `[workspace]` section. This adds one:

```
holomap/
  Cargo.toml            # gains [workspace] members
  src/                  # the holomap crate, unchanged
  crates/
    holomap-cluster/
      Cargo.toml        # holomap + hdbscan + wasm-bindgen
      src/lib.rs        # reduce_and_cluster
      pkg/              # wasm-pack output (gitignored)
  npm/
    package.json        # @mnmal-ai/holomap-cluster
```

The `holomap` crate's publish whitelist (`include = ["src/**", "examples/**", ...]`) already excludes sibling directories, so its crates.io artifact is unaffected.

**Licensing is clean for a public publish.** holomap is `MIT OR Apache-2.0`; `hdbscan` 0.12.0 is `MIT OR Apache-2.0`; its transitive `kdtree` 0.7.0 is `MIT OR Apache-2.0`. The npm package ships under the same dual license.

### Rust API

```rust
pub struct ClusterParams {
    // reduction — passed through to holomap's builder
    pub seed: u64,                    // required, no default
    pub n_components: usize,          // default 10
    pub n_neighbors: usize,           // default 15
    pub min_dist: f32,                // default 0.1
    pub metric: Metric,               // default Cosine (text embeddings)
    pub n_epochs: Option<usize>,      // None = holomap's own default

    // clustering — passed through to hdbscan
    pub min_cluster_size: usize,      // default 5
    pub min_samples: Option<usize>,   // None = hdbscan's default

    // output control
    pub return_reduced: bool,         // default false
}

pub struct ClusterOutput {
    pub assignments: Vec<i32>,        // one per input row; -1 = noise
    pub probabilities: Vec<f32>,      // hdbscan membership strength, one per row
    pub n_clusters: usize,
    pub n_noise: usize,
    pub reduced: Option<Vec<f32>>,    // row-major, n × n_components; only when return_reduced
}

pub fn reduce_and_cluster(
    data: &[f32],        // row-major, n × n_features
    n_features: usize,
    params: &ClusterParams,
) -> Result<ClusterOutput, ClusterError>;
```

`seed` is a required field with no default, mirroring holomap's decision to make an unseeded run unconstructible.

**Centroids are deliberately absent from the output.** A consumer attaching new rows to existing clusters must do so in the *original* embedding space — a centroid in 10-d reduced space cannot be searched against a 768-d HNSW index. Computing the mean of member vectors in original space is a two-line operation the consumer does itself, and returning a reduced-space centroid would actively invite the wrong thing.

### JavaScript surface

```ts
export interface ClusterParams { /* mirrors the Rust struct, camelCase */ }

export interface ClusterResult {
  assignments: Int32Array;
  probabilities: Float32Array;
  nClusters: number;
  nNoise: number;
  reduced?: Float32Array;
}

export function reduceAndCluster(
  vectors: Float32Array,   // row-major, n × nFeatures
  nFeatures: number,
  params: ClusterParams
): ClusterResult;
```

Built with `wasm-pack build --target nodejs`, wrapped in a thin ESM module so the package is importable from both ESM and CJS consumers. The package resolves its own `.wasm` asset relative to its own `dist/`, so consumers never handle asset paths.

**Considered and rejected: a hand-written loader with no `wasm-bindgen`.** The API is purely numeric, so manual `alloc`/`free` exports plus explicit linear-memory copies would work and would suit holomap's minimalism. Rejected because the memory management is the one part that can be silently wrong, and `wasm-bindgen`'s codegen is well-trodden for exactly this typed-array shape. Revisit only if the glue proves to be a problem under a consumer's bundler.

**No top-level side effects.** Module initialisation must be explicit or lazy so the package can be imported inside a `worker_threads` Worker without surprises. The first consumer runs it in a worker because the batch is CPU-bound for tens of seconds and must not block a Node event loop that is serving live traffic.

### Determinism contract

The package inherits and re-states holomap's contract:

> Same vectors + same `nFeatures` + same params (seed included) → identical `assignments` and `probabilities`.

Verified in CI the same way holomap verifies its own: run twice, compare raw bytes. holomap's `serde` feature serialises its config *with the seed*, so a stored config replays bit-identically — which means a consumer can record exactly how a clustering was produced and reproduce it later. That is the provenance story this package enables and it should be preserved in the JS surface: params are a plain serialisable object, no hidden state, no ambient defaults resolved at call time.

### Error handling

`ClusterError` covers, each surfaced as a JS `Error` with a stable `code`:

| Condition | Code |
|---|---|
| `data.len()` not divisible by `n_features` | `shape_mismatch` |
| non-finite value in input | `non_finite_input` (holomap 0.2.0 already rejects these) |
| `n < n_neighbors + 1` — too few rows to build the kNN graph | `too_few_rows` |
| `n_components >= n_features` | `invalid_params` |
| `n` above the supported ceiling | `too_many_rows` |

No silent degradation, no clamping of out-of-range params to something workable. A caller that asks for something impossible gets told.

### Scale ceiling

holomap's exact brute-force kNN is O(N²·d); its stated honest envelope is **≤ ~50k points**. wasm32's 4 GiB address space is not the binding constraint at that size (50k × 768 × 4 B ≈ 153 MB of input), but the quadratic kNN is. The package returns `too_many_rows` above a hard constant `MAX_ROWS = 50_000` rather than grinding for an unbounded time.

The ceiling is a constant, not a parameter. Making it configurable would let a caller opt into an unbounded run without any way to know what they were asking for; a consumer that genuinely needs more rows needs a different kNN strategy, not a raised limit.

For context, Coda measured its real corpus at 723 rows ≈ 3 weeks of heavy agent use, and estimated 10k vectors ≈ roughly one year of accumulation. The ceiling is not near.

## Phase-0 spike — the gate

This design is **not approved for implementation until the spike passes**. It mirrors how Coda gated its dynamics package on a clusterer spike, and for the same reason: the last time this stack was assumed to work from reading crate documentation, it failed both hard gates.

### Fixture

`/mnt/data/Develop/coda-fixtures/2026-06-05-claude-corpus-799.tsv` — 799 rows of real accumulated Hydra data, 1024-d bge-m3 embeddings, L2-normalised. sha256 `d65077b8c3f62fa2a873507cacc8a7afb8f46ad9ad7e7b959bc23591f9620c4b`, verified against its sidecar file 2026-08-05.

This fixture is chosen because **the expected answer is already known**: Coda's Python pipeline produced 46 clusters at 21.2% noise with `mcs=5` / 10-d reduction, and 8 of 8 sampled clusters read as coherent operational domains. 76 of the 799 rows are synthetic perf fixtures that Coda's hygiene filter excluded before clustering; the spike must apply the same exclusion.

### Gates

| # | Gate | Bar | Kind |
|---|---|---|---|
| 1 | **wasm self-determinism** | Two runs in wasm, same input and params → byte-identical `assignments` and `probabilities` | hard |
| 2 | **Pipeline quality** | On the filtered fixture at `mcs=5`, `n_components=10`, cosine: cluster count 30–60, noise 10–35%, ≥5 of 8 largest sampled clusters semantically coherent | hard |
| 3 | **Node ESM + worker load** | Package imports and runs to completion inside a `worker_threads` Worker under Node ESM, with no top-level side effects | hard |
| 4 | **Wall clock and peak RSS** | Measured at 1k and 10k rows. Fails only if 10k exceeds 300 s — roughly 10× holomap's native ~26 s — which would make the batch impractical | hard |
| 5 | **Native/wasm divergence** | Max absolute difference in reduced coordinates, and ARI between native and wasm cluster assignments, both reported | informational |

Gate 2 deliberately reuses the MVD's established bar rather than inventing a new one. Note that holomap + `hdbscan`-rs will **not** reproduce umap-learn + sklearn's exact 46 clusters — these are different implementations. The bar is the qualitative envelope, which is what the MVD itself treated as the gate.

Gate 5 is informational because native/wasm byte-identity is **not required**. holomap already accepts cross-platform ULP-level differences while claiming structural identity. What the package promises is self-consistency (gate 1) and quality (gate 2). Gate 5 exists to tell us how far apart the two runtimes are, and therefore whether holomap's existing native CI can stand proxy for the wasm build or whether wasm needs its own parity fixtures.

### Failure branch

**Any hard gate fails → build a native sidecar instead**, reusing holomap's existing cross-platform CI builds, and adapt the consumer's design to an out-of-process call. This is a real branch, not a formality. The sidecar wins on two points independently of the spike — it inherits holomap's already-verified native determinism, and process isolation means a long CPU-bound run cannot block or crash the host. It loses on distribution: hydra's model is npm-into-a-runtime-dir, where a `.wasm` is an ordinary package asset that works on every platform Node runs on, while a native binary needs per-platform prebuilds, placement, an exec bit, lifecycle supervision, and version-skew management against the plugin.

The spike is what decides whether that ops cost buys anything. It should not be paid speculatively.

## Testing

Beyond the spike gates, which become permanent CI checks once passed:

- **Determinism property test.** Mirror holomap's existing proptest invariant — randomised seeds, shapes and params, asserting byte-identity across a double run. This is the contract; it gets a property test, not an example test.
- **Error-path tests.** One per `ClusterError` code, asserting the code rather than the message.
- **Fixture regression.** The filtered 799-row corpus with a pinned seed, asserting cluster count and noise fraction fall in the gate-2 envelope. Guards against a dependency bump silently changing the pipeline's behaviour.
- **Worker smoke test.** Import and run inside a `worker_threads` Worker, asserting the result matches a main-thread run of the same input.
- **Cross-platform CI.** The existing Linux/macOS/Windows matrix extends to the wasm build and the Node-side tests.

## What this unblocks

Project B — `hydra-recall` crystallisation — consumes this package to produce `recall/Cluster` rows with `derivedFrom` provenance edges to their source rows, driven by `POST /hydra/crystallise` on a caller's schedule. Recorded in the hydra context store as cross-cutting Decision `ef9a4584` and Todo `f403fbca`.

Coda's MVD §4 constrains what B may do with the output: clustering **proposes** candidates, and identity must not be re-derived by global re-clustering, because the corpus grows between runs. New rows attach to existing clusters by proximity in the original embedding space. holomap's determinism makes a re-cluster *auditable and replayable*; it does not make it *stable under new data*, and those are different properties.

## Open assumptions for review

1. **Public npm publish** under `MIT OR Apache-2.0`, matching holomap and its dependencies — rather than a restricted GitHub Packages publish like the `@mnmal-ai/hydra*` line. holomap is already public on crates.io and this is a thin composition of public crates, so a restricted npm artifact would be the odd one out. Trivially reversible if the call goes the other way.
2. **Package name `@mnmal-ai/holomap-cluster`**, matching the crate name.
3. **`hdbscan` 0.12 pinned**, per Coda's spike selection over `petal-clustering` on API-surface grounds.
