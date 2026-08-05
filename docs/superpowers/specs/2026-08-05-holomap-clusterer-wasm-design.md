# `holomap-clusterer` — adopt the existing reduce→cluster crate, add a wasm binding

**Date:** 2026-08-05 · **Status:** design · **Repo:** `mnmal-ai/holomap`

## Goal

Move the existing reduce→cluster crate into the holomap repo, rename it, dual-license it, and add a WebAssembly binding published as an npm package — so a TypeScript consumer can run the pipeline in-process without a sidecar process.

## What already exists

**This spec's first draft was wrong.** It specified building a crate from scratch. The crate exists, is tested, and is in production use: `coda/crates/coda-clusterer` v0.1.0.

```toml
holomap = "0.2"
hdbscan = { version = "0.12", default-features = false, features = ["serial"] }
```

`serial` only — rayon is disabled deliberately so no thread-pool non-determinism can enter. Four source files: `protocol.rs`, `pipeline.rs`, `lib.rs`, `main.rs`. `cargo test -p coda-clusterer`: **6 passed, exit 0** (verified 2026-08-05).

It is already effectively repo-neutral. `protocol.rs` contains zero references to coda or dynamics; `pipeline.rs` contains one, in a doc comment.

### Current API

```rust
pub const PROTOCOL_VERSION: u32 = 1;

pub struct Params {
    pub n_components: usize,     // 0 = skip reduction, cluster input directly
    pub n_neighbors: usize,
    pub min_cluster_size: usize,
    pub seed: u64,
}

pub struct Request  { protocol_version: u32, vectors: Vec<Vec<f32>>, params: Params }
pub struct Response { protocol_version: u32, assignments: Vec<i32>,
                      probabilities: Option<Vec<f32>>, error: Option<String> }

pub fn run_pipeline(req: &Request) -> Response;
```

Pipeline: L2-normalise → optional holomap reduction → HDBSCAN (`DistanceMetric::Euclidean`, valid post-normalisation). `main.rs` is a JSON-lines stdin/stdout loop — errors come back as per-line responses, never process aborts.

### Two behaviours that must survive the move

**`min_samples` is deliberately unset.** The `hdbscan` crate defaults it to `min_cluster_size`, matching sklearn's `HDBSCAN(min_cluster_size=5)` default. The code comment records that setting it to `n_neighbors` collapsed the result to **8 clusters versus 36** on the reference corpus, and that the previous wiring was a cross-binding inconsistency with `clusterer.py`. This is a hard-won tuning result, not an oversight.

**`probabilities` is always `None`.** `hdbscan` 0.12's `.cluster()` returns labels only; it exposes no membership strength. The field exists for protocol forward-compatibility and is not populated. *(The first draft of this spec promised probabilities on the JS surface. It cannot deliver them.)*

### Already proven, do not re-litigate

Native pipeline quality is established on the real 799-row corpus (`coda-fixtures/2026-06-05-claude-corpus-799.tsv`, sha256 `d65077b8…`, 723 rows after excluding the 76 synthetic perf fixtures per MVD §5): **36 clusters, 27.2% noise** — inside the MVD's 30–60 / 10–35% envelope — byte-identical across runs, 5.6× faster than the Python stack.

Independently confirmed 2026-08-05: holomap alone reduces those 723 rows (1024-d → 10-d, cosine, seed 42) in **2.39 s**, and holomap's own suite is 50/50 green.

## Scope of this change

1. **Move** `crates/coda-clusterer` → `holomap/crates/holomap-clusterer`.
2. **Rename** the crate and its package.
3. **Relicense** `Apache-2.0` → `MIT OR Apache-2.0`, matching holomap, `hdbscan` 0.12 and transitive `kdtree` 0.7.
4. **Add a wasm binding** and publish it as an npm package.
5. **Migrate coda** to depend on the renamed crate.

### Non-goals

- **No change to `run_pipeline`'s behaviour.** The move must be behaviour-preserving; the reference-corpus result is the regression check.
- **No clustering policy.** This crate proposes assignments. Coda's MVD §4 governs what consumers may do with them: *"concept identity cannot be re-derived by re-running a global clustering."*
- **No hygiene filtering.** MVD §5 — synthetic fixtures out-dense lived experience. Callers filter before calling.
- **No generality added to `holomap` itself.** Its stated identity is "small, auditable, deterministic — generality is resisted on purpose." The composition lives in a sibling crate, never inside it.

## Repo layout

holomap's root `Cargo.toml` is a single-package manifest today with no `[workspace]` section. This adds one:

```
holomap/
  Cargo.toml                     # gains [workspace] members
  src/                           # the holomap crate, unchanged
  crates/
    holomap-clusterer/
      Cargo.toml
      src/{lib,pipeline,protocol,main}.rs
      src/wasm.rs                # new
      tests/protocol.rs
  npm/
    package.json                 # @mnmal-ai/holomap-clusterer
```

holomap's publish whitelist (`include = ["src/**", "examples/**", …]`) already excludes sibling directories, so its crates.io artifact is unaffected.

**History preservation:** move with `git format-patch` / `git am` rather than a plain copy, so the crate's authorship survives. If that proves awkward across two unrelated histories, a clean add is acceptable provided the commit message names the origin commit in `mnmal-ai/coda`.

## The wasm binding

### Why not reuse the JSON-lines protocol

The sidecar's `Vec<Vec<f32>>`-over-JSON wire is exactly the pathology Coda measured: at 50k vectors a single request serialises to ~1.1 GB of JSON and the round trip exceeds ten minutes. Their own finding was that *"the 50k pathology is the wire protocol, not the algorithm."*

Marshalling through JSON *inside* a wasm boundary would import that cost for no reason. The binding takes a flat `Float32Array` written straight into linear memory.

### JS surface

```ts
export interface ClusterParams {
  seed: number;              // required — no default
  nComponents: number;       // 0 = skip reduction
  nNeighbors: number;
  minClusterSize: number;
}

export interface ClusterResult {
  assignments: Int32Array;   // one per row; -1 = noise
  nClusters: number;
  nNoise: number;
}

export function reduceAndCluster(
  vectors: Float32Array,     // row-major, nRows × nFeatures
  nFeatures: number,
  params: ClusterParams
): ClusterResult;
```

`nClusters` / `nNoise` are derived from `assignments` in the binding — convenience, not new pipeline state. No `probabilities`, because the crate cannot produce them. No `reduced` output: a consumer attaching new rows to existing clusters must do so in the *original* embedding space, since a reduced-space centroid cannot be searched against a 768-d HNSW index, and returning one would invite exactly that mistake.

`seed` is required with no default, mirroring holomap's decision to make an unseeded run unconstructible.

### Implementation

`src/wasm.rs` behind a `wasm` feature, so the native crate and sidecar are unaffected. It converts the flat input into the `Vec<Vec<f32>>` the existing `run_pipeline` takes, calls it unchanged, and translates the response.

**`run_pipeline` is not refactored for this.** The row-vector allocation is one `Vec` per row — 723 allocations on the reference corpus, 50k at the ceiling — which is not the bottleneck beside an O(N²·d) kNN. A flat-input core is a reasonable later optimisation if profiling ever justifies it; doing it now would mean changing tested production code for a hypothetical.

**Errors throw.** `Response.error` is in-band by design for the sidecar's per-line contract, but a JS function returning a result object with an error field invites callers to ignore it. The binding throws an `Error` carrying the crate's message. Stable machine-readable error codes are a follow-on if a consumer ever needs to branch on failure kind; today none does.

**Row guard.** The binding rejects input above `MAX_ROWS = 50_000` — holomap's honest envelope, set by its exact O(N²·d) kNN — rather than grinding unbounded. The guard lives in the wasm binding only; the sidecar path is unchanged, because a blocked worker thread is a wasm-specific hazard. A constant rather than a parameter: a configurable ceiling lets a caller opt into an unbounded run without any way to know what they asked for.

**No top-level side effects.** Initialisation must be explicit or lazy, so the module can be imported inside a `worker_threads` Worker. The first consumer runs it in a worker because the batch is CPU-bound for tens of seconds and must not block a Node event loop serving live traffic.

Built with `wasm-pack build --target nodejs`, wrapped in a thin ESM module. The package resolves its own `.wasm` asset relative to its own `dist/`, so consumers never handle asset paths.

## Verification gates

Native pipeline quality is already proven, so these are wasm-specific plus a move regression.

| # | Gate | Bar | Kind |
|---|---|---|---|
| 1 | **Move regression** | `holomap-clusterer` reproduces 36 clusters / 27.2% noise on the 723-row filtered corpus at `min_cluster_size=5`, `n_components=10`, `seed` as used in the original gate | hard |
| 2 | **wasm self-determinism** | Two wasm runs, same input and params → byte-identical `assignments` | hard |
| 3 | **wasm/native agreement** | Same input and params: wasm and native `assignments` agree. Report ARI if they diverge | hard |
| 4 | **Node ESM + worker load** | Imports and runs to completion inside a `worker_threads` Worker under Node ESM, result matching a main-thread run | hard |
| 5 | **Wall clock and peak RSS** | Measured at 723 rows and 10k. Fails only if 10k exceeds 300 s — roughly 10× holomap's native ~26 s — which would make the batch impractical | hard |

Gate 3 is a hard gate here, unlike in the first draft. That draft treated native/wasm divergence as informational because the native result was itself unproven. It is now the established reference, so wasm disagreeing with it is a defect rather than a data point.

**If a hard gate fails, nothing gets built.** The sidecar already exists and is in production use by coda-dynamics; hydra-recall would talk to that binary and pay the ops cost. This is why the wasm work is low-risk and why the consuming project is not blocked on it.

## Migrating coda

`coda-dynamics` currently builds `coda-clusterer` from coda's own workspace. After the move it depends on `holomap-clusterer` from crates.io. Sequencing:

1. Land the crate in holomap under its new name and license; publish to crates.io via holomap's existing trusted-publishing pipeline.
2. Point coda's `Cargo.toml` at the published crate; delete `crates/coda-clusterer`.
3. Re-run coda's dynamics gates to confirm the rename changed nothing.

Coda must not be left depending on a crate that no longer exists in its tree, so steps 1–2 land close together.

## Testing

- **Existing suite moves intact.** `tests/protocol.rs` — 6 tests — comes across unchanged. Any edit to it during the move is a signal the move was not behaviour-preserving.
- **Determinism property test.** Mirror holomap's proptest invariant: randomised seeds, shapes and params, asserting byte-identity across a double run.
- **Fixture regression.** The filtered 723-row corpus with a pinned seed, asserting cluster count and noise fraction. Guards against a dependency bump silently changing pipeline behaviour.
- **Worker smoke test.** Import and run inside a `worker_threads` Worker.
- **Cross-platform CI.** holomap's existing Linux/macOS/Windows matrix extends to the wasm build and the Node-side tests.

## What this unblocks

`hydra-recall` crystallisation: `POST /hydra/crystallise` writing `recall/Cluster` rows with `derivedFrom` provenance edges to source rows, on a caller's schedule. Recorded in the hydra context store as cross-cutting Decision `ef9a4584` and Todo `f403fbca`; this crate's move is Todo `0caa6281`.

That consumer is **not blocked on the wasm binding** — the sidecar path works today. The binding determines whether hydra-recall ships as a pure npm install or requires operators to run a second process.
