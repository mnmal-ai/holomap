# `holomap-clusterer` — adopt the existing crate, ship both backends behind one interface

**Date:** 2026-08-05 · **Status:** design · **Repo:** `mnmal-ai/holomap`

## Goal

Move the existing reduce→cluster crate into the holomap repo, rename and dual-license it, and publish an npm package exposing **one `Clusterer` interface with two backends** — a bundled wasm build for a clean install, and a subprocess adapter for operators who want native speed.

Two consumers: `coda-dynamics` (today, via subprocess) and `hydra-recall` crystallisation (new).

## What already exists

**This spec's first draft was wrong.** It specified building a crate from scratch. Nearly all of it exists and is in production.

### The Rust crate

`coda/crates/coda-clusterer` v0.1.0 — `holomap 0.2` + `hdbscan 0.12` with `default-features = false, features = ["serial"]`, so rayon is disabled and no thread-pool non-determinism can enter. `cargo test -p coda-clusterer`: **6 passed, exit 0** (verified 2026-08-05).

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

Pipeline: L2-normalise → optional holomap reduction → HDBSCAN (`DistanceMetric::Euclidean`, valid post-normalisation). `main.rs` is a JSON-lines stdin/stdout loop; errors are per-line responses, never process aborts.

Already repo-neutral: `protocol.rs` has zero coda/dynamics references, `pipeline.rs` has one, in a doc comment.

### The TypeScript interface

`coda/packages/dynamics/src/clusterer.ts` already defines the backend seam this design needs:

```ts
export interface ClusterParams { nComponents: number; nNeighbors: number;
                                 minClusterSize: number; seed: number }
export interface ClusterResult { assignments: readonly number[];
                                 probabilities?: readonly number[] }
export interface Clusterer {
  cluster(vectors: readonly Float32Array[], params: ClusterParams): Promise<ClusterResult>;
}
export class SubprocessClusterer implements Clusterer { /* spawns argv, JSON-lines */ }
export class ClustererError extends Error {}
```

The binding is config-driven — `CODA_DYNAMICS_CLUSTERER` argv, defaulting to the Rust binary — and **has already been swapped once**, from `clusterer.py` to the Rust binary on 2026-06-07. The pluggable-backend design is not speculative here: it is proven in production and has survived a real backend change.

### Three behaviours that must survive the move

**`min_samples` is deliberately unset.** The `hdbscan` crate then defaults it to `min_cluster_size`, matching sklearn's `HDBSCAN(min_cluster_size=5)`. The in-code comment records that setting it to `n_neighbors` collapsed the reference corpus from **36 clusters to 8**, and that the earlier wiring was a cross-binding inconsistency with `clusterer.py`. Hard-won, not an oversight.

**`min_dist` stays at holomap's default 0.1 — not 0.0.** The Python baseline calls `UMAP(min_dist=0.0)`, so matching it looks like the obviously correct thing to do. It is not: the standalone gate measured 0.0 regressing the corpus to **13 clusters / 45.2% noise** (both figures sklearn-clustered, so compare them against that binding's 36 / 27.2%, not against this crate's 36 / 30.0%), because holomap's SGD schedule handles the zero-min-dist edge case differently from umap-learn's. This is the trap in the crate — the "consistency fix" that silently halves cluster yield.

**`probabilities` is always `None`.** `hdbscan` 0.12's `.cluster()` returns labels only. The field exists for protocol forward-compatibility and is never populated. *(The first draft promised probabilities on the JS surface. It cannot deliver them.)*

### Already proven — do not re-litigate

Native quality on the real 799-row corpus (`coda-fixtures/2026-06-05-claude-corpus-799.tsv`, sha256 `d65077b8…`; 723 rows after excluding the 76 synthetic perf fixtures per MVD §5), at `n_components=10`, `n_neighbors=15`, `min_cluster_size=5`, `seed=42`:

| Pipeline | Clusters | Noise | Source |
|---|---|---|---|
| holomap reduction → **sklearn** HDBSCAN | 36 | 27.2% | `coda/scripts/phase0-clusterer-spike/holomap_gate.py`, re-confirmed byte-identical on the holomap 0.2.0 bump (coda `6062a084`) |
| holomap reduction → **Rust `hdbscan` 0.12** (this crate) | 36 | 30.0% | measured 2026-08-05 |

**The widely-quoted "36 clusters / 27.2% noise" validated the REDUCTION, using a Python clusterer.** `holomap_gate.py` imports `from sklearn.cluster import HDBSCAN`. This crate clusters with the Rust `hdbscan` crate instead, so its noise fraction differs by ~3 points while the cluster count matches exactly. Both sit inside the MVD's 30–60 / 10–35% envelope. Quoting 27.2% as this pipeline's figure is a misattribution — the all-Rust baseline is **36 / 30.0%**, first recorded here.

Confirmed independently 2026-08-05: holomap alone reduces those 723 rows (1024-d → 10-d, cosine, seed 42) in **2.39 s**; its own suite is 50/50 green; and both `holomap` 0.2.0 and `hdbscan` 0.12.0 compile clean to `wasm32-unknown-unknown` (exit 0, 19 s and 4.5 s), neither pulling a C dependency, BLAS, LAPACK, or OS entropy.

## Scope

1. **Move** `crates/coda-clusterer` → `holomap/crates/holomap-clusterer`; rename; relicense `Apache-2.0` → `MIT OR Apache-2.0`, matching holomap, `hdbscan` 0.12 and transitive `kdtree` 0.7.
2. **Add a wasm binding** behind a `wasm` feature.
3. **Publish `@mnmal-ai/holomap-clusterer`** — the `Clusterer` interface plus both backends.
4. **Migrate coda** to the shared package, deleting its local crate and `SubprocessClusterer`.

### Non-goals

- **No behaviour change to `run_pipeline`.** The move is behaviour-preserving; the reference-corpus result is the regression check.
- **No clustering policy.** This crate proposes assignments. Coda's MVD §4 governs consumers: *"concept identity cannot be re-derived by re-running a global clustering."*
- **No hygiene filtering.** MVD §5 — synthetic fixtures out-dense lived experience. Callers filter before calling.
- **No generality added to `holomap` itself.** Its identity is "small, auditable, deterministic — generality is resisted on purpose."

## Repo layout

holomap's root `Cargo.toml` is a single-package manifest with no `[workspace]` today. This adds one:

```
holomap/
  Cargo.toml                     # gains [workspace] members
  src/                           # the holomap crate, unchanged
  crates/holomap-clusterer/
    src/{lib,pipeline,protocol,main}.rs
    src/wasm.rs                  # new, behind the `wasm` feature
    tests/protocol.rs
  npm/                           # @mnmal-ai/holomap-clusterer
    src/{index,wasm-clusterer,subprocess-clusterer}.ts
```

holomap's publish whitelist (`include = ["src/**", "examples/**", …]`) already excludes sibling directories, so its crates.io artifact is unaffected.

**History preservation:** move via `git format-patch` / `git am` so authorship survives. A clean add is acceptable if that proves awkward across unrelated histories, provided the commit message names the origin commit in `mnmal-ai/coda`.

## The npm package

### Surface

The `Clusterer` interface, `ClusterParams`, `ClusterResult` and `ClustererError` move verbatim from `coda/packages/dynamics/src/clusterer.ts`. **The signature does not change** — including `vectors: readonly Float32Array[]` rather than a flat array.

*(The first draft proposed a flat `Float32Array`, arguing it avoids marshalling. Rejected: the interface is in production, and flattening inside the wasm backend costs one copy that is negligible beside an O(N²·d) kNN. Changing a working consumer's interface for a micro-optimisation is the wrong trade.)*

```ts
export class WasmClusterer implements Clusterer { }        // bundled wasm, default
export class SubprocessClusterer implements Clusterer { }  // spawns a native binary
```

### `WasmClusterer`

`src/wasm.rs` sits behind a `wasm` feature so the native crate and sidecar are untouched. It converts incoming rows into the `Vec<Vec<f32>>` that `run_pipeline` takes, calls it unchanged, and translates the response.

**`run_pipeline` is not refactored for this.** One `Vec` allocation per row — 723 on the reference corpus, 50k at the ceiling — is not the bottleneck beside the quadratic kNN. A flat-input core is a fair later optimisation if profiling justifies it; doing it now means changing tested production code for a hypothetical.

**Build with `-C target-feature=+simd128` — but not for the reason originally given.** The rationale here was that native LLVM auto-vectorises `exact_knn`'s scalar distance loop to AVX and wasm would not without the flag, so omitting it would widen the gap. **Measured 2026-08-05, that is not observable on this workload.** With the wasm module warmed before timing, n=723 is identical to three significant figures with and without the flag (2.4 s both), and n=10k differs by ~2.2% single-shot — noise, not signal.

The flag stays because it is free and may matter on other hosts or larger inputs, but no performance claim should rest on it. The real, measured cost of choosing wasm over the subprocess is below.

### Measured backend cost

Same host, same corpus shape, wasm warmed before timing; n=723 is a median of three runs, n=10k single-shot:

| Backend | n=723 | n=10,000 |
|---|---|---|
| `WasmClusterer` | 2.4 s | 53.6 s |
| `SubprocessClusterer` | 1.3 s | 30.5 s |

**Choosing wasm costs roughly 1.8×.** Both clear the 300 s gate with ~5.6× headroom at 10k. For context, coda's real corpus is 723 rows and 10k is estimated at roughly a year of accumulation — so at realistic sizes the absolute difference is about a second.

**Errors throw.** `Response.error` is in-band by design for the sidecar's per-line contract, but a JS method resolving to a result object carrying an error field invites callers to ignore it. `WasmClusterer` throws `ClustererError` with the crate's message, matching what `SubprocessClusterer` already does.

**Row guard.** Reject input above `MAX_ROWS = 50_000` — holomap's honest envelope, set by its exact O(N²·d) kNN. wasm-only: a blocked worker thread is a wasm-specific hazard and the subprocess path is unchanged. A constant, not a parameter — a configurable ceiling lets a caller opt into an unbounded run with no way to know what they asked for.

**No top-level side effects.** Initialisation is explicit or lazy so the module can be imported inside a `worker_threads` Worker. Consumers should run it in one: the batch is CPU-bound for tens of seconds and must not block an event loop serving live traffic.

Built with `wasm-pack build --target nodejs`, wrapped in a thin ESM module. The package resolves its own `.wasm` asset relative to its own `dist/`, so consumers never handle asset paths.

### Choosing a backend

Consumers select per their own config conventions. For hydra-recall that is a `oneOf` discriminated union on `kind`, matching the pattern its config schema already uses for the embedder (`off | fake | ollama | onnx`):

```jsonc
"clusterer": { "kind": "wasm" }                              // default
"clusterer": { "kind": "subprocess", "argv": ["/path/to/holomap-clusterer"] }
```

wasm is the default because hydra's distribution model is npm-into-a-runtime-dir — `npx hydra init`, plugins discovered by scanning `node_modules`, releases shipped by moving version pins and restarting one systemd unit. A `.wasm` is an ordinary package asset that works on every platform Node runs on. The subprocess backend is the opt-in for operators who want native speed and will accept per-platform binary management.

### Backend identity is provenance, not a footnote

**A consumer persisting cluster results must record which backend and version produced them.**

The two backends will not necessarily agree byte-for-byte, and that is not a defect to engineer away — holomap's own README promises only *structural* identity cross-platform ("floats may differ at ULP level"), so native-on-Linux and native-on-macOS may already differ. HDBSCAN is a density algorithm, so small coordinate perturbations can flip boundary points.

Demanding that wasm match native more tightly than native matches itself would be an unfair gate. The honest answer is to make the backend visible: a stored clustering recording `{ backend, version, seed, params }` turns a backend switch into an observable event rather than a silent reprocessing. For hydra-recall this rides the `recall/Cluster` provenance the design already commits to.

## Verification gates

Native pipeline quality is already proven, so these are wasm-specific plus a move regression.

| # | Gate | Bar | Kind |
|---|---|---|---|
| 1 | **Move regression** | `holomap-clusterer` lands inside 30–60 clusters / 10–35% noise on the 723-row filtered corpus at `min_cluster_size=5`, `n_components=10`, `n_neighbors=15`, `seed=42`. The all-Rust baseline is 36 / 30.0% — not the sklearn-measured 27.2% | hard |
| 2 | **wasm self-determinism** | Two wasm runs, same input and params → byte-identical `assignments` | hard |
| 3 | **wasm/native agreement** | wasm diverges from native by no more than native diverges from native across platforms, measured against holomap's existing cross-platform parity suite. Report ARI and cluster-count delta | hard |
| 4 | **Node ESM + worker load** | Imports and runs to completion inside a `worker_threads` Worker under Node ESM, result matching a main-thread run | hard |
| 5 | **Wall clock and peak RSS** | Measured at 723 rows and 10k, with and without `+simd128`. Fails only if 10k exceeds 300 s — roughly 10× holomap's native ~26 s — which would make the batch impractical | hard |

Gate 5 measures both flag settings deliberately: it quantifies the auto-vectorisation gap rather than assuming it, and that number is what any future "should we just use the sidecar" conversation should be argued from.

**If a hard gate fails, the wasm backend is dropped and nothing else changes.** The subprocess backend already exists and is in production. Neither consumer is blocked on the wasm work; it only decides whether they ship as a pure npm install or ask operators to run a second process.

## Migrating coda

Coda is mid-flight and does not need to stay green through this, so the sequencing is direct rather than defensive:

1. Land the crate in holomap under its new name and license; publish to crates.io via holomap's existing trusted-publishing pipeline.
2. Publish `@mnmal-ai/holomap-clusterer` with both backends.
3. Point `coda-dynamics` at the package; delete `crates/coda-clusterer` and the local `SubprocessClusterer`. `CODA_DYNAMICS_CLUSTERER` keeps working — it becomes the argv for the shared `SubprocessClusterer`.
4. Re-run coda's dynamics gates to confirm the move changed nothing.

**Coda is also the proving ground for the wasm backend.** It has the `Clusterer` seam, the reference corpus, and existing gates — so swapping in `WasmClusterer` there exercises the binding against a real workload with a known-good result to compare against, before hydra-recall depends on it. Cheaper to find a problem there than in the substrate.

## Testing

- **Existing suite moves intact.** `tests/protocol.rs` — 6 tests — comes across unchanged. Any edit to it during the move signals the move was not behaviour-preserving.
- **Determinism property test.** Mirror holomap's proptest invariant: randomised seeds, shapes and params, asserting byte-identity across a double run.
- **Fixture regression.** The filtered 723-row corpus at a pinned seed, asserting cluster count and noise fraction. Guards against a dependency bump silently changing pipeline behaviour.
- **Backend equivalence.** Both backends over the same fixture, asserting agreement within gate 3's bar. This is the test that keeps dual-path honest.
- **Worker smoke test.** Import and run inside a `worker_threads` Worker.
- **Cross-platform CI.** holomap's existing Linux/macOS/Windows matrix extends to the wasm build and the Node-side tests.

## What this unblocks

`hydra-recall` crystallisation: `POST /hydra/crystallise` writing `recall/Cluster` rows with `derivedFrom` provenance edges to source rows, on a caller's schedule. Hydra context store: cross-cutting Decision `ef9a4584` (mechanism/policy split), Decision `7c643598` (this crate's home), Todo `f403fbca` (the recall primitive), Todo `0caa6281` (this move).
