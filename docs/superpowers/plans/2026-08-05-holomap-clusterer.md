# holomap-clusterer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the existing reduce→cluster crate into the holomap repo, add a wasm binding, and publish an npm package exposing one `Clusterer` interface with two backends.

**Architecture:** `crates/holomap-clusterer` is the Rust core — unchanged `run_pipeline`, plus a `wasm` feature exposing it to JS. `npm/` wraps it as `@mnmal-ai/holomap-clusterer`, shipping the `Clusterer` interface with `WasmClusterer` (bundled wasm, default) and `SubprocessClusterer` (spawns a native binary). Coda migrates to the package and deletes its local copies.

**Tech Stack:** Rust 1.93 (edition 2024 for holomap, 2021 for the clusterer), `holomap` 0.2, `hdbscan` 0.12 (`serial` only), `wasm-bindgen` + `wasm-bindgen-cli`, TypeScript, Vitest, Biome. **Not `wasm-pack`** — 0.15.0 is incompatible with cargo 1.95.0 (see Task 5).

**Spec:** [`docs/superpowers/specs/2026-08-05-holomap-clusterer-wasm-design.md`](../specs/2026-08-05-holomap-clusterer-wasm-design.md)

## Global Constraints

- **Behaviour-preserving move.** `run_pipeline` logic does not change. Any diff to `pipeline.rs` beyond the crate rename in `use` paths is a defect.
- **`min_samples` stays unset.** `hdbscan` then defaults it to `min_cluster_size`, matching sklearn. Setting it to `n_neighbors` collapsed the reference corpus from 36 clusters to 8.
- **`min_dist` stays at holomap's default 0.1 — NOT 0.0.** Setting 0.0 to match the umap-learn baseline regresses the corpus to **13 clusters / 45.2% noise** (sklearn-clustered figures — see Task 2 for the all-Rust baseline). holomap's SGD schedule handles the zero-min-dist edge case differently from umap-learn's.
- **`hdbscan` keeps `default-features = false, features = ["serial"]`.** Enabling rayon admits thread-scheduling non-determinism.
- **`probabilities` is always `None`.** `hdbscan` 0.12's `.cluster()` returns labels only. Do not invent a value for it.
- **Errors stay in-band in Rust** (`Response.error`), and **throw in JS** (`ClustererError`).
- **License: `MIT OR Apache-2.0`** on the crate and the npm package.
- **Determinism is the product.** Same input + same params + same seed → byte-identical `assignments`.
- **TDD, DRY, YAGNI, frequent commits.** Green-gate before each commit.
- **Commit footer**, every commit: `Written by [mnmal-ai-claude](https://github.com/mnmal-ai-claude) with [Claude Code](https://claude.com/claude-code)`
- **Branch:** `feat/holomap-clusterer`.
- **Never commit to main.** Feature branch → PR.

## File Structure

```
holomap/
  Cargo.toml                          # MODIFY: add [workspace]
  crates/holomap-clusterer/
    Cargo.toml                        # CREATE
    src/lib.rs                        # CREATE (from coda)
    src/protocol.rs                   # CREATE (from coda, verbatim)
    src/pipeline.rs                   # CREATE (from coda, verbatim but for `use` paths)
    src/main.rs                       # CREATE (from coda, crate rename only)
    src/wasm.rs                       # CREATE (new)
    tests/protocol.rs                 # CREATE (from coda, crate rename only)
    tests/fixture_regression.rs       # CREATE (new, env-gated)
  npm/
    package.json                      # CREATE
    tsconfig.json                     # CREATE
    vitest.config.ts                  # CREATE
    src/types.ts                      # CREATE: Clusterer, ClusterParams, ClusterResult, ClustererError
    src/subprocess-clusterer.ts       # CREATE (from coda, verbatim)
    src/wasm-clusterer.ts             # CREATE (new)
    src/index.ts                      # CREATE: re-exports
    test/subprocess-clusterer.test.ts # CREATE
    test/wasm-clusterer.test.ts       # CREATE
    test/worker-smoke.test.ts         # CREATE
    test/backend-equivalence.test.ts  # CREATE
  .github/workflows/ci.yml            # MODIFY: wasm build + npm jobs
```

Coda changes land in Task 9.

---

### Task 1: Land the crate in a holomap workspace

Move, rename and relicense the crate with zero behaviour change. The existing 6-test suite is the proof.

**Files:**
- Modify: `Cargo.toml` (root)
- Create: `crates/holomap-clusterer/Cargo.toml`
- Create: `crates/holomap-clusterer/src/{lib,protocol,pipeline,main}.rs`
- Test: `crates/holomap-clusterer/tests/protocol.rs`

**Interfaces:**
- Produces: `holomap_clusterer::protocol::{Params, Request, Response, PROTOCOL_VERSION}` and `holomap_clusterer::pipeline::run_pipeline(&Request) -> Response`. Signatures identical to `coda_clusterer`'s.

- [ ] **Step 1: Create the branch**

```bash
cd /mnt/data/Develop/holomap
git checkout main && git pull
git checkout -b feat/holomap-clusterer
```

- [ ] **Step 2: Convert the root manifest to a workspace**

Add to the **top** of `Cargo.toml`, above `[package]`:

```toml
[workspace]
members = [".", "crates/holomap-clusterer"]
```

- [ ] **Step 3: Copy the crate source across, preserving history**

```bash
cd /mnt/data/Develop/coda
git log --oneline -- crates/coda-clusterer | tail -1   # note the origin commit for the message
mkdir -p /mnt/data/Develop/holomap/crates/holomap-clusterer
cp -r crates/coda-clusterer/src crates/coda-clusterer/tests \
      /mnt/data/Develop/holomap/crates/holomap-clusterer/
```

History preservation via `git format-patch`/`git am` is preferred where it works cleanly across the two unrelated histories. If it does not, this copy is acceptable — name the origin commit in the Step 8 commit message.

- [ ] **Step 4: Write the crate manifest**

`crates/holomap-clusterer/Cargo.toml`:

```toml
[package]
name = "holomap-clusterer"
version = "0.1.0"
edition = "2021"
license = "MIT OR Apache-2.0"
description = "Deterministic reduce→cluster pipeline: holomap UMAP + HDBSCAN. JSON-lines peripheral and wasm binding."
repository = "https://github.com/mnmal-ai/holomap"
keywords = ["clustering", "hdbscan", "umap", "deterministic", "embedding"]
categories = ["science", "algorithms"]

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
# rayon disabled deliberately: parallel MST construction would admit
# thread-scheduling non-determinism. `serial` gives us .cluster().
hdbscan = { version = "0.12", default-features = false, features = ["serial"] }
holomap = { version = "0.2", path = "../.." }

[[bin]]
name = "holomap-clusterer"
path = "src/main.rs"
```

- [ ] **Step 5: Rename crate references in source**

Three files reference the old crate name. Replace `coda_clusterer` with `holomap_clusterer` in:
- `src/main.rs` — the two `use coda_clusterer::…` lines
- `tests/protocol.rs` — the `use` line and three fully-qualified `coda_clusterer::pipeline::run_pipeline` / `coda_clusterer::protocol::Params` references

```bash
cd /mnt/data/Develop/holomap/crates/holomap-clusterer
grep -rl 'coda_clusterer' src tests | xargs sed -i 's/coda_clusterer/holomap_clusterer/g'
grep -rn 'coda_clusterer' src tests   # must print nothing
```

Also update the one doc-comment reference in `src/pipeline.rs` that names `docs/2026-06-06-phase0-clusterer-spike-findings.md` — that file lives in the coda repo, so qualify it as `coda's docs/2026-06-06-phase0-clusterer-spike-findings.md`. **Do not touch any other line of `pipeline.rs`.**

- [ ] **Step 6: Run the moved suite to verify it passes unchanged**

Run: `cargo test -p holomap-clusterer`
Expected: **6 passed**, exit 0. Same count as `coda-clusterer`. A different count means the move was not behaviour-preserving.

- [ ] **Step 7: Verify the holomap crate is unaffected**

Run: `cargo test -p holomap`
Expected: 50 passed, exit 0. The workspace conversion must not disturb it.

- [ ] **Step 8: Commit**

```bash
git add Cargo.toml crates/holomap-clusterer
git commit -m "feat: land holomap-clusterer, moved from coda

Behaviour-preserving move of coda/crates/coda-clusterer at <origin-sha>.
Renamed, relicensed Apache-2.0 -> MIT OR Apache-2.0 to match holomap and
its deps, and the root manifest becomes a workspace.

Only crate-name references changed. pipeline.rs logic is untouched: the
6-test suite passes unchanged, which is the proof.

Written by [mnmal-ai-claude](https://github.com/mnmal-ai-claude) with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 2: Reference-corpus regression gate

The 6 unit tests prove the code moved. They do not prove the *pipeline* still produces the right answer on real data. This adds that gate, env-gated so the 9.4 MB fixture never enters the repo.

**Files:**
- Create: `crates/holomap-clusterer/tests/fixture_regression.rs`

**Interfaces:**
- Consumes: `holomap_clusterer::pipeline::run_pipeline`, `holomap_clusterer::protocol::{Params, Request, PROTOCOL_VERSION}`

- [ ] **Step 1: Write the failing test**

`crates/holomap-clusterer/tests/fixture_regression.rs`:

```rust
//! Reference-corpus regression gate.
//!
//! The unit suite proves the code is wired correctly. This proves the
//! PIPELINE still behaves on the real 723-row corpus. Baseline for THIS
//! all-Rust pipeline: 36 clusters / 30.0% noise (measured 2026-08-05).
//!
//! The widely-quoted 36 / 27.2% is a DIFFERENT binding — holomap_gate.py
//! reduces with holomap then clusters with sklearn's HDBSCAN. Same
//! reduction, different clusterer, so the cluster count matches exactly
//! and the noise fraction differs by ~3 points. Do not treat 27.2% as
//! this pipeline's number.
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
```

- [ ] **Step 2: Run it unset to verify it skips cleanly**

Run: `cargo test -p holomap-clusterer --test fixture_regression`
Expected: PASS, prints `skipping: HOLOMAP_CLUSTERER_FIXTURE unset`.

- [ ] **Step 3: Run it against the real fixture**

```bash
HOLOMAP_CLUSTERER_FIXTURE=/mnt/data/Develop/coda-fixtures/2026-06-05-claude-corpus-799.tsv \
  cargo test -p holomap-clusterer --test fixture_regression -- --nocapture
```

Expected: PASS, printing `clusters=36 noise=30.0%` or values inside the gate bands. (27.2% is the sklearn-clustered figure for the same reduction — not this pipeline's.) **If clusters is 13 and noise ~45%, `min_dist` has been changed to 0.0 — revert it to holomap's default.** If clusters is 8, `min_samples` has been set — unset it.

- [ ] **Step 4: Commit**

```bash
git add crates/holomap-clusterer/tests/fixture_regression.rs
git commit -m "test: reference-corpus regression gate for the clusterer pipeline

The unit suite proves the code moved. This proves the pipeline still
behaves — 36 clusters / 30.0% noise on the real 723-row corpus, the
first recorded baseline for the all-Rust pipeline.

Env-gated on HOLOMAP_CLUSTERER_FIXTURE so the 9.4 MB fixture stays out
of the repo, mirroring hydra's POSTGRES_URL-gated suites. Asserts the
MVD's 30-60 / 10-35% band rather than exact equality: a dependency patch
may shift the count without breaking the pipeline, but leaving the band
means something real changed.

Written by [mnmal-ai-claude](https://github.com/mnmal-ai-claude) with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 3: wasm binding

Expose `run_pipeline` to JS behind a `wasm` feature, leaving the native crate and binary untouched.

**Files:**
- Modify: `crates/holomap-clusterer/Cargo.toml`
- Modify: `crates/holomap-clusterer/src/lib.rs`
- Create: `crates/holomap-clusterer/src/wasm.rs`

**Interfaces:**
- Produces: wasm export `reduce_and_cluster(vectors: &[f32], n_features: usize, n_components: usize, n_neighbors: usize, min_cluster_size: usize, seed: f64) -> Result<Vec<i32>, JsError>` — six parameters. `n_rows` is NOT a parameter; it is derived as `vectors.len() / n_features`. `seed` is `f64` because JS numbers are doubles; the binding casts to `u64`, and that cast saturates — NaN and negatives become 0, and values above 2^53 lose precision. Task 5's TypeScript layer guards this.

- [ ] **Step 1: Add the feature and dependency**

In `crates/holomap-clusterer/Cargo.toml`, append:

```toml
[features]
default = []
wasm = ["dep:wasm-bindgen"]

[dependencies.wasm-bindgen]
version = "0.2"
optional = true

[lib]
crate-type = ["cdylib", "rlib"]
```

`rlib` keeps the native binary and integration tests working; `cdylib` is what `wasm-pack` needs.

- [ ] **Step 2: Write the failing test**

Append to `crates/holomap-clusterer/tests/protocol.rs`:

```rust
/// The wasm binding flattens a row-major input into the Vec<Vec<f32>> that
/// run_pipeline takes. That reshape is the only logic the binding adds, so
/// it is the only part worth testing on the native side — the wasm-specific
/// behaviour is covered by the JS suite.
#[test]
fn flatten_reshapes_row_major_input() {
    let flat = vec![1.0f32, 2.0, 3.0, 4.0, 5.0, 6.0];
    let rows = holomap_clusterer::wasm::reshape(&flat, 3);
    assert_eq!(rows, vec![vec![1.0, 2.0, 3.0], vec![4.0, 5.0, 6.0]]);
}

#[test]
fn flatten_rejects_ragged_input() {
    let flat = vec![1.0f32, 2.0, 3.0, 4.0, 5.0];
    assert!(std::panic::catch_unwind(|| holomap_clusterer::wasm::reshape(&flat, 3)).is_err());
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cargo test -p holomap-clusterer`
Expected: FAIL — `could not find 'wasm' in 'holomap_clusterer'`.

- [ ] **Step 4: Write the binding**

`crates/holomap-clusterer/src/wasm.rs`:

```rust
//! WebAssembly binding.
//!
//! Wraps `run_pipeline` unchanged. The only logic here is marshalling: a
//! flat row-major Float32Array in, an Int32Array of labels out.
//!
//! `run_pipeline` is deliberately NOT refactored to take a flat slice. One
//! Vec allocation per row is 723 on the reference corpus and 50k at the
//! ceiling — nothing beside an O(N²·d) kNN — and changing tested production
//! code for a micro-optimisation is the wrong trade.

/// holomap's honest envelope, set by its exact O(N²·d) kNN.
///
/// A constant rather than a parameter: a configurable ceiling lets a caller
/// opt into an unbounded run with no way to know what they asked for. The
/// guard is wasm-only — a blocked worker thread is a wasm-specific hazard,
/// and the subprocess path is unaffected.
pub const MAX_ROWS: usize = 50_000;

/// Reshape a flat row-major buffer into rows. Panics on a ragged length;
/// the caller checks divisibility first and returns a JS error.
pub fn reshape(flat: &[f32], n_features: usize) -> Vec<Vec<f32>> {
    assert!(n_features > 0, "n_features must be positive");
    assert!(
        flat.len() % n_features == 0,
        "buffer length {} is not divisible by n_features {}",
        flat.len(),
        n_features
    );
    flat.chunks_exact(n_features).map(<[f32]>::to_vec).collect()
}

#[cfg(feature = "wasm")]
mod bindings {
    use super::{reshape, MAX_ROWS};
    use crate::pipeline::run_pipeline;
    use crate::protocol::{Params, Request, PROTOCOL_VERSION};
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    pub fn reduce_and_cluster(
        vectors: &[f32],
        n_features: usize,
        n_components: usize,
        n_neighbors: usize,
        min_cluster_size: usize,
        seed: f64,
    ) -> Result<Vec<i32>, JsError> {
        if n_features == 0 {
            return Err(JsError::new("n_features must be positive"));
        }
        if vectors.len() % n_features != 0 {
            return Err(JsError::new(&format!(
                "buffer length {} is not divisible by n_features {n_features}",
                vectors.len()
            )));
        }
        let n_rows = vectors.len() / n_features;
        if n_rows > MAX_ROWS {
            return Err(JsError::new(&format!(
                "{n_rows} rows exceeds MAX_ROWS {MAX_ROWS} — holomap's exact kNN is O(N^2*d); \
                 use the subprocess backend for corpora this size"
            )));
        }

        let resp = run_pipeline(&Request {
            protocol_version: PROTOCOL_VERSION,
            vectors: reshape(vectors, n_features),
            params: Params {
                n_components,
                n_neighbors,
                min_cluster_size,
                seed: seed as u64,
            },
        });

        // The Rust side reports errors in-band for the sidecar's per-line
        // contract. JS gets a throw instead: a resolved object carrying an
        // error field invites callers to ignore it.
        match resp.error {
            Some(e) => Err(JsError::new(&e)),
            None => Ok(resp.assignments),
        }
    }
}
```

Add to `crates/holomap-clusterer/src/lib.rs`:

```rust
pub mod pipeline;
pub mod protocol;
pub mod wasm;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p holomap-clusterer`
Expected: **8 passed** (6 original + 2 new), exit 0.

- [ ] **Step 6: Build the wasm artifact**

```bash
cargo install wasm-pack --locked   # if absent
cd crates/holomap-clusterer
RUSTFLAGS="-C target-feature=+simd128" \
  wasm-pack build --release --target nodejs --features wasm --out-dir pkg
ls -la pkg/
```

Expected: `pkg/holomap_clusterer_bg.wasm`, `pkg/holomap_clusterer.js`, `pkg/holomap_clusterer.d.ts`.

`+simd128` is kept because it is free, NOT because it was measured to help: with the module warmed before timing, n=723 is identical with and without it and n=10k differs ~2.2% single-shot. Do not restate the auto-vectorisation rationale as if it were established.

- [ ] **Step 7: Gitignore the build output**

Append to `.gitignore`:

```
crates/holomap-clusterer/pkg/
```

- [ ] **Step 8: Commit**

```bash
git add crates/holomap-clusterer/Cargo.toml crates/holomap-clusterer/src/wasm.rs \
        crates/holomap-clusterer/src/lib.rs crates/holomap-clusterer/tests/protocol.rs .gitignore
git commit -m "feat: wasm binding for the clusterer, behind a \`wasm\` feature

Marshalling only — flat Float32Array in, Int32Array of labels out — wrapping
run_pipeline unchanged. Native crate and binary are untouched: the feature is
off by default and crate-type gains cdylib alongside rlib.

Errors throw rather than resolving in-band. In-band is right for the sidecar's
per-line contract, but a JS call resolving to an object carrying an error field
invites callers to ignore it.

MAX_ROWS is a constant, not a parameter — a configurable ceiling lets a caller
opt into an unbounded run with no way to know what they asked for.

Written by [mnmal-ai-claude](https://github.com/mnmal-ai-claude) with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 4: npm package with the interface and `SubprocessClusterer`

Scaffold the package and move the TypeScript interface plus the subprocess backend across verbatim.

**Files:**
- Create: `npm/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `npm/src/{types,subprocess-clusterer,index}.ts`
- Test: `npm/test/subprocess-clusterer.test.ts`

**Interfaces:**
- Produces: `ClusterParams { nComponents, nNeighbors, minClusterSize, seed }`, `ClusterResult { assignments: readonly number[]; probabilities?: readonly number[] }`, `interface Clusterer { cluster(vectors: readonly Float32Array[], params: ClusterParams): Promise<ClusterResult> }`, `class ClustererError extends Error`, `class SubprocessClusterer implements Clusterer`.

- [ ] **Step 1: Scaffold the package**

`npm/package.json`:

```json
{
  "name": "@mnmal-ai/holomap-clusterer",
  "version": "0.1.0",
  "description": "Deterministic reduce→cluster: holomap UMAP + HDBSCAN. One Clusterer interface, wasm and subprocess backends.",
  "license": "MIT OR Apache-2.0",
  "repository": { "type": "git", "url": "git+https://github.com/mnmal-ai/holomap.git", "directory": "npm" },
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
  "files": ["dist", "wasm"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "check-types": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  }
}
```

`npm/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`npm/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 120_000 }
});
```

The 120 s timeout exists because the wasm backend's reference-corpus run is tens of seconds.

- [ ] **Step 2: Write the types**

`npm/src/types.ts` — copied verbatim from `coda/packages/dynamics/src/clusterer.ts`, which is the production definition:

```ts
export interface ClusterParams {
  /** 0 = skip reduction (protocol convention). */
  nComponents: number;
  nNeighbors: number;
  minClusterSize: number;
  seed: number;
}

export interface ClusterResult {
  /** Label per input vector; -1 = noise (HDBSCAN convention). */
  assignments: readonly number[];
  /**
   * Never populated by either backend: hdbscan 0.12's .cluster() returns
   * labels only. Present for protocol forward-compatibility.
   */
  probabilities?: readonly number[];
}

export interface Clusterer {
  cluster(vectors: readonly Float32Array[], params: ClusterParams): Promise<ClusterResult>;
}

export class ClustererError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ClustererError';
  }
}

export interface ProtocolResponse {
  protocol_version: number;
  assignments: number[];
  probabilities?: number[];
  error?: string;
}
```

- [ ] **Step 3: Move `SubprocessClusterer` verbatim**

Copy the `SubprocessClusterer` class from `coda/packages/dynamics/src/clusterer.ts` (lines 44–117) into `npm/src/subprocess-clusterer.ts`, changing only the imports:

```ts
import { spawn } from 'node:child_process';
import { type ClusterParams, type ClusterResult, ClustererError, type Clusterer, type ProtocolResponse } from './types.js';
```

**Do not otherwise modify the class.** It is production code; a rewrite during a move is how behaviour gets lost.

`npm/src/index.ts`:

```ts
export * from './types.js';
export { SubprocessClusterer } from './subprocess-clusterer.js';
export { WasmClusterer } from './wasm-clusterer.js';
```

`WasmClusterer` arrives in Task 5; until then this line will not compile, so add it in Task 5 and export only the subprocess backend for now.

- [ ] **Step 4: Write the failing test**

`npm/test/subprocess-clusterer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ClustererError, SubprocessClusterer } from '../src/index.js';

const BIN = new URL('../../target/release/holomap-clusterer', import.meta.url).pathname;

function blobs(): Float32Array[] {
  let state = 42n;
  const next = () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number(state >> 33n) / 0xffffffff - 0.5;
  };
  const out: Float32Array[] = [];
  for (let blob = 0; blob < 3; blob++) {
    for (let i = 0; i < 30; i++) {
      const v = new Float32Array(8);
      v[blob * 2] = 10.0;
      for (let j = 0; j < 8; j++) v[j] += next() * 0.5;
      out.push(v);
    }
  }
  return out;
}

describe('SubprocessClusterer', () => {
  it('separates three blobs', async () => {
    const clusterer = new SubprocessClusterer([BIN]);
    const result = await clusterer.cluster(blobs(), {
      nComponents: 0, nNeighbors: 15, minClusterSize: 5, seed: 42
    });
    const labels = new Set(result.assignments.filter((l) => l >= 0));
    expect(labels.size).toBe(3);
  });

  it('throws ClustererError on an empty argv', () => {
    expect(() => new SubprocessClusterer([])).toThrow(ClustererError);
  });
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `cd npm && pnpm install && pnpm test`
Expected: FAIL — the binary does not exist yet at that path.

- [ ] **Step 6: Build the native binary and re-run**

```bash
cd /mnt/data/Develop/holomap && cargo build --release -p holomap-clusterer
cd npm && pnpm test
```

Expected: PASS, 2 tests.

- [ ] **Step 7: Commit**

```bash
git add npm
git commit -m "feat: npm package with the Clusterer interface and subprocess backend

Interface and SubprocessClusterer move verbatim from coda/packages/dynamics/
src/clusterer.ts — production code that has already survived one backend swap
(clusterer.py -> Rust binary, 2026-06-07). Copied rather than rewritten: a
rewrite during a move is how behaviour gets lost.

probabilities is documented as never populated. hdbscan 0.12's .cluster()
returns labels only; the field exists for protocol forward-compatibility.

Written by [mnmal-ai-claude](https://github.com/mnmal-ai-claude) with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 5: `WasmClusterer`

The bundled backend, plus proof it runs inside a worker thread.

**Files:**
- Create: `npm/src/wasm-clusterer.ts`
- Modify: `npm/src/index.ts`, `npm/package.json`
- Test: `npm/test/wasm-clusterer.test.ts`, `npm/test/worker-smoke.test.ts`

**Interfaces:**
- Consumes: `Clusterer`, `ClusterParams`, `ClusterResult`, `ClustererError` from `./types.js`; the wasm export `reduce_and_cluster` from Task 3.
- Produces: `class WasmClusterer implements Clusterer`.

- [ ] **Step 1: Wire the wasm artifact into the package**

```bash
# wasm-pack is NOT used: wasm-pack 0.15.0 invokes `cargo build --out-dir`
# internally, and cargo 1.95.0 renamed that unstable flag to --artifact-dir,
# so every wasm-pack build fails. Reproduced independently 2026-08-05.
#
# The direct route is also strictly better: wasm-bindgen-cli MUST match the
# wasm-bindgen crate version exactly, and a mismatch fails in confusing ways.
# wasm-pack hid that coupling; here it is explicit and derived from Cargo.lock.
cd /mnt/data/Develop/holomap/.worktrees/holomap-clusterer

WB_VERSION=$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | grep '^version' | cut -d'"' -f2)
echo "matching wasm-bindgen-cli to crate version $WB_VERSION"
cargo install wasm-bindgen-cli --version "$WB_VERSION" --locked

RUSTFLAGS="-C target-feature=+simd128" \
  cargo build --release --target wasm32-unknown-unknown -p holomap-clusterer --features wasm

wasm-bindgen --target nodejs --out-dir npm/wasm \
  target/wasm32-unknown-unknown/release/holomap_clusterer.wasm
ls -la npm/wasm/
```

Expected: `npm/wasm/holomap_clusterer_bg.wasm` (~255 KB), `holomap_clusterer.js`, `holomap_clusterer.d.ts`.

Add to `npm/package.json` scripts (a shell script keeps the version-derivation readable):

```json
"build:wasm": "bash ../scripts/build-wasm.sh"
```

Create `scripts/build-wasm.sh` at the repo root with the command block above (minus the `cd`), `set -euo pipefail` at the top, and `chmod +x`. CI calls the same script, so the build path has exactly one definition.

- [ ] **Step 2: Write the failing test**

`npm/test/wasm-clusterer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ClustererError, WasmClusterer } from '../src/index.js';

function blobs(): Float32Array[] {
  let state = 42n;
  const next = () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number(state >> 33n) / 0xffffffff - 0.5;
  };
  const out: Float32Array[] = [];
  for (let blob = 0; blob < 3; blob++) {
    for (let i = 0; i < 30; i++) {
      const v = new Float32Array(8);
      v[blob * 2] = 10.0;
      for (let j = 0; j < 8; j++) v[j] += next() * 0.5;
      out.push(v);
    }
  }
  return out;
}

const PARAMS = { nComponents: 0, nNeighbors: 15, minClusterSize: 5, seed: 42 };

describe('WasmClusterer', () => {
  it('separates three blobs', async () => {
    const result = await new WasmClusterer().cluster(blobs(), PARAMS);
    expect(new Set(result.assignments.filter((l) => l >= 0)).size).toBe(3);
  });

  it('is deterministic across runs', async () => {
    const c = new WasmClusterer();
    const a = await c.cluster(blobs(), PARAMS);
    const b = await c.cluster(blobs(), PARAMS);
    expect(a.assignments).toEqual(b.assignments);
  });

  it('throws ClustererError on ragged input', async () => {
    const ragged = [new Float32Array(8), new Float32Array(5)];
    await expect(new WasmClusterer().cluster(ragged, PARAMS)).rejects.toThrow(ClustererError);
  });

  it.each([Number.NaN, -1, 1.5, 2 ** 53])('rejects seed %p rather than coercing it', async (seed) => {
    await expect(
      new WasmClusterer().cluster(blobs(), { ...PARAMS, seed })
    ).rejects.toThrow(/seed must be/);
  });

  it('throws ClustererError above MAX_ROWS', async () => {
    const many = Array.from({ length: 50_001 }, () => new Float32Array(2));
    await expect(new WasmClusterer().cluster(many, PARAMS)).rejects.toThrow(/MAX_ROWS/);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd npm && pnpm test wasm-clusterer`
Expected: FAIL — `WasmClusterer` is not exported.

- [ ] **Step 4: Implement**

`npm/src/wasm-clusterer.ts`:

```ts
import { createRequire } from 'node:module';
import {
  type ClusterParams,
  type ClusterResult,
  ClustererError,
  type Clusterer
} from './types.js';

// wasm-pack --target nodejs emits CJS glue. createRequire loads it from an
// ESM module without a bundler step, and resolves the .wasm relative to the
// package's own directory so consumers never handle asset paths.
const require = createRequire(import.meta.url);

interface WasmModule {
  reduce_and_cluster(
    vectors: Float32Array,
    nFeatures: number,
    nComponents: number,
    nNeighbors: number,
    minClusterSize: number,
    seed: number
  ): Int32Array;
}

/**
 * Bundled wasm backend — the default.
 *
 * The module is loaded lazily on first use, never at import time, so this
 * file can be imported inside a worker_threads Worker without side effects.
 * Consumers SHOULD run it in a worker: the batch is CPU-bound for tens of
 * seconds and would otherwise block the event loop.
 */
export class WasmClusterer implements Clusterer {
  #module: WasmModule | undefined;

  #load(): WasmModule {
    this.#module ??= require('../wasm/holomap_clusterer.js') as WasmModule;
    return this.#module;
  }

  async cluster(
    vectors: readonly Float32Array[],
    params: ClusterParams
  ): Promise<ClusterResult> {
    if (vectors.length === 0) throw new ClustererError('empty input');

    const nFeatures = vectors[0]!.length;
    if (vectors.some((v) => v.length !== nFeatures)) {
      throw new ClustererError('vector dimensions inconsistent');
    }

    // The Rust binding takes seed as f64 and casts to u64. That cast
    // saturates: NaN and negatives silently become 0, and anything above
    // 2^53 has already lost precision as a JS number. A seed that quietly
    // becomes a different seed is the worst failure this API can have —
    // determinism is the whole product — so reject rather than coerce.
    if (!Number.isInteger(params.seed) || params.seed < 0 || params.seed > Number.MAX_SAFE_INTEGER) {
      throw new ClustererError(
        `seed must be a non-negative integer <= 2^53-1, got ${params.seed}`
      );
    }

    // Flatten to row-major. One copy — negligible beside an O(N^2*d) kNN,
    // and it keeps the production Clusterer signature unchanged.
    const flat = new Float32Array(vectors.length * nFeatures);
    for (let i = 0; i < vectors.length; i++) flat.set(vectors[i]!, i * nFeatures);

    let assignments: Int32Array;
    try {
      assignments = this.#load().reduce_and_cluster(
        flat,
        nFeatures,
        params.nComponents,
        params.nNeighbors,
        params.minClusterSize,
        params.seed
      );
    } catch (e) {
      throw new ClustererError(e instanceof Error ? e.message : String(e));
    }

    if (assignments.length !== vectors.length) {
      throw new ClustererError(
        `assignment count ${assignments.length} != input count ${vectors.length}`
      );
    }
    return { assignments: Array.from(assignments) };
  }
}
```

Update `npm/src/index.ts` to add `export { WasmClusterer } from './wasm-clusterer.js';`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd npm && pnpm test wasm-clusterer`
Expected: PASS, 4 tests.

- [ ] **Step 6: Write the worker smoke test**

`npm/test/worker-smoke.test.ts`:

```ts
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

const WORKER = `
import { parentPort } from 'node:worker_threads';
import { WasmClusterer } from '${new URL('../src/index.ts', import.meta.url).pathname}';
const vectors = [];
for (let blob = 0; blob < 3; blob++)
  for (let i = 0; i < 30; i++) {
    const v = new Float32Array(8);
    v[blob * 2] = 10.0;
    v[7] = i * 0.01;
    vectors.push(v);
  }
const r = await new WasmClusterer().cluster(vectors,
  { nComponents: 0, nNeighbors: 15, minClusterSize: 5, seed: 42 });
parentPort.postMessage(r.assignments);
`;

describe('worker_threads', () => {
  it('loads and runs inside a Worker with no top-level side effects', async () => {
    const assignments = await new Promise<number[]>((resolve, reject) => {
      const w = new Worker(WORKER, { eval: true, execArgv: ['--experimental-strip-types'] });
      w.on('message', resolve);
      w.on('error', reject);
    });
    expect(new Set(assignments.filter((l) => l >= 0)).size).toBe(3);
  });
});
```

- [ ] **Step 7: Run it**

Run: `cd npm && pnpm test worker-smoke`
Expected: PASS. A failure here means the module has import-time side effects — fix `wasm-clusterer.ts` to defer loading, do not relax the test.

- [ ] **Step 8: Commit**

```bash
git add npm
git commit -m "feat: WasmClusterer — the bundled default backend

Lazy module load, never at import time, so the file can be imported inside a
worker_threads Worker. The worker smoke test is the gate on that: consumers
should run this in a worker because the batch is CPU-bound for tens of seconds
and would otherwise block an event loop serving live traffic.

Flattens to row-major inside the backend rather than changing the production
Clusterer signature — one copy, negligible beside an O(N^2*d) kNN.

Written by [mnmal-ai-claude](https://github.com/mnmal-ai-claude) with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 6: Backend equivalence and the measured gates

The test that keeps dual-path honest, plus the wall-clock numbers the spec's gate 5 asks for.

**Files:**
- Test: `npm/test/backend-equivalence.test.ts`
- Create: `npm/bench/measure.ts`

**Interfaces:**
- Consumes: `WasmClusterer`, `SubprocessClusterer`, `ClusterParams`.

- [ ] **Step 1: Write the equivalence test**

`npm/test/backend-equivalence.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SubprocessClusterer, WasmClusterer } from '../src/index.js';

const BIN = new URL('../../target/release/holomap-clusterer', import.meta.url).pathname;
const PARAMS = { nComponents: 5, nNeighbors: 15, minClusterSize: 5, seed: 1234 };

function blobs(dims: number): Float32Array[] {
  let state = 42n;
  const next = () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number(state >> 33n) / 0xffffffff - 0.5;
  };
  const out: Float32Array[] = [];
  for (let blob = 0; blob < 3; blob++) {
    for (let i = 0; i < 30; i++) {
      const v = new Float32Array(dims);
      v[blob * 2] = 10.0;
      for (let j = 0; j < dims; j++) v[j] += next() * 0.5;
      out.push(v);
    }
  }
  return out;
}

/**
 * Gate 3. The bar is NOT byte-identity: holomap promises only structural
 * identity cross-platform ("floats may differ at ULP level"), so native-on-
 * Linux and native-on-macOS may already differ, and HDBSCAN is a density
 * algorithm where small coordinate perturbations flip boundary points.
 * Requiring wasm to match native more tightly than native matches itself
 * would be an unfair gate.
 *
 * What must hold is that both backends recover the same STRUCTURE. If this
 * ever fails, the fix is not to loosen it — it is to record the backend in
 * provenance so a switch is observable, and investigate the divergence.
 */
describe('backend equivalence', () => {
  it('both backends recover the same cluster structure', async () => {
    const vectors = blobs(32);
    const wasm = await new WasmClusterer().cluster(vectors, PARAMS);
    const native = await new SubprocessClusterer([BIN]).cluster(vectors, PARAMS);

    const count = (a: readonly number[]) => new Set(a.filter((l) => l >= 0)).size;
    const noise = (a: readonly number[]) => a.filter((l) => l === -1).length;

    expect(count(wasm.assignments)).toBe(count(native.assignments));
    expect(Math.abs(noise(wasm.assignments) - noise(native.assignments))).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd npm && pnpm test backend-equivalence`
Expected: PASS. A failure is a real finding — report the cluster counts and noise from both backends before changing anything.

- [ ] **Step 3: Write the measurement harness**

`npm/bench/measure.ts`:

```ts
/**
 * Gate 5. Wall clock and peak RSS for both backends.
 *
 * Run with the wasm built both ways to quantify the auto-vectorisation gap:
 *   pnpm build:wasm && pnpm tsx bench/measure.ts          # with +simd128
 *   (rebuild without RUSTFLAGS, re-run)                   # without
 *
 * Native reference from holomap's README: ~3 s at 1k x 50-d, ~26 s at 10k.
 * The gate fails only if 10k exceeds 300 s.
 */
import { SubprocessClusterer, WasmClusterer } from '../src/index.js';

const BIN = new URL('../../target/release/holomap-clusterer', import.meta.url).pathname;

function synthetic(n: number, dims: number): Float32Array[] {
  let state = 7n;
  const next = () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number(state >> 33n) / 0xffffffff - 0.5;
  };
  return Array.from({ length: n }, (_, i) => {
    const v = new Float32Array(dims);
    v[i % dims] = 10.0;
    for (let j = 0; j < dims; j++) v[j] += next() * 0.5;
    return v;
  });
}

const PARAMS = { nComponents: 10, nNeighbors: 15, minClusterSize: 5, seed: 42 };

for (const n of [723, 10_000]) {
  const vectors = synthetic(n, 50);
  for (const [name, clusterer] of [
    ['wasm', new WasmClusterer()],
    ['subprocess', new SubprocessClusterer([BIN])]
  ] as const) {
    const t0 = performance.now();
    await clusterer.cluster(vectors, PARAMS);
    const secs = (performance.now() - t0) / 1000;
    const rss = process.memoryUsage().rss / 1024 / 1024;
    console.log(`${name} n=${n} wall=${secs.toFixed(1)}s rss=${rss.toFixed(0)}MB`);
  }
}
```

- [ ] **Step 4: Run the measurements and record them**

```bash
cd npm && pnpm tsx bench/measure.ts | tee /tmp/measure-simd128.txt
```

Then rebuild the wasm **without** `RUSTFLAGS` and re-run into `/tmp/measure-nosimd.txt`. Paste both tables into the PR description. If 10k exceeds 300 s for the wasm backend, gate 5 fails — stop and report rather than proceeding to Task 7.

- [ ] **Step 5: Commit**

```bash
git add npm/test/backend-equivalence.test.ts npm/bench/measure.ts
git commit -m "test: backend equivalence + measured wall-clock gates

Equivalence asserts both backends recover the same STRUCTURE, not byte-identical
labels. holomap promises only structural identity cross-platform, so native-vs-
native may already differ at ULP level and HDBSCAN can flip boundary points on
that — demanding wasm match native more tightly than native matches itself would
be an unfair gate.

measure.ts quantifies the +simd128 auto-vectorisation gap rather than assuming
it. That number is what any future 'should we just use the sidecar' conversation
should be argued from.

Written by [mnmal-ai-claude](https://github.com/mnmal-ai-claude) with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 7: CI, and stop committing the wasm artifact

Extend holomap's existing matrix to cover the workspace, the wasm build, and the npm suite — and make CI the only producer of the wasm binary.

**Files:**
- Modify: `.github/workflows/ci.yml`, `.gitignore`, `npm/package.json`

- [ ] **Step 0: Untrack the wasm artifact**

`npm/wasm/` is currently git-tracked, including a 261 KB `.wasm` binary committed in Task 5. That was not deliberate — it survived only because a rebuild happened to be byte-identical. A checked-in build artifact can silently drift from the source it was built from, which is exactly the failure this project keeps meeting. Decision (Rich, 2026-08-05): **not committed; CI builds it.**

```bash
cd /mnt/data/Develop/holomap/.worktrees/holomap-clusterer
git rm --cached -r npm/wasm/
printf '\n# wasm build output — produced by scripts/build-wasm.sh, never committed\nnpm/wasm/\n' >> .gitignore
git check-ignore -v npm/wasm/holomap_clusterer_bg.wasm   # must now report a match
git ls-files npm/wasm/                                    # must print nothing
```

The files stay on disk — `git rm --cached` untracks without deleting, so the local suite keeps working.

- [ ] **Step 1: Make publishing unable to ship a stale or missing artifact**

Add to `npm/package.json` scripts:

```json
"prepublishOnly": "bash ../scripts/build-wasm.sh"
```

Now the artifact cannot be absent or stale at publish time, which is the whole reason it was safe to untrack. Also document the local requirement — add to `npm/package.json`:

```json
"pretest": "test -f wasm/holomap_clusterer.js || { echo 'wasm artifact missing — run: pnpm build:wasm'; exit 1; }"
```

Verify both the pass and fail paths before committing: run `pnpm test` with the artifact present (must proceed), then `mv wasm /tmp/wasm-bak && pnpm test` (must print the message and exit non-zero), then `mv /tmp/wasm-bak wasm`. A guard nobody has watched fire is not a guard.

A developer on a fresh clone otherwise meets an opaque module-resolution error; this tells them the one command to run.


- [ ] **Step 1: Add the wasm and npm jobs**

Append to `.github/workflows/ci.yml`, and change the existing `lint` and `test` jobs' `cargo` invocations to `--workspace` so the new crate is covered:

```yaml
  wasm:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
      - uses: dtolnay/rust-toolchain@29eef336d9b2848a0b548edc03f92a220660cdb8 # stable as of 2026-06-07
        with:
          targets: wasm32-unknown-unknown
      - name: Build wasm
        run: bash scripts/build-wasm.sh
      - uses: pnpm/action-setup@a7487c7e89a18df4991f7f222e4898a00d66ddda # v4.1.0
        with: { version: 10 }
      - uses: actions/setup-node@2028fbc5c25fe9cf00d9f06a71cc4710d4507903 # v5.0.0
        with: { node-version: 22 }
      - name: Build the native binary for the subprocess backend
        run: cargo build --release -p holomap-clusterer
      - name: npm suite
        working-directory: npm
        run: pnpm install --frozen-lockfile && pnpm check-types && pnpm test
```

The wasm job builds the native binary too: `backend-equivalence.test.ts` and `subprocess-clusterer.test.ts` both need it, so a wasm-only job would silently skip half the suite.

- [ ] **Step 2: Verify the workflow parses**

Run: `gh workflow view ci.yml --repo mnmal-ai/holomap` after pushing, or lint locally with `actionlint .github/workflows/ci.yml` if available.

- [ ] **Step 3: Commit and push, then confirm CI is green**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: cover the workspace, the wasm build and the npm suite

cargo jobs move to --workspace so holomap-clusterer is tested alongside
holomap. The wasm job also builds the native binary: the equivalence and
subprocess suites need it, and a wasm-only job would silently skip half
the tests.

Written by [mnmal-ai-claude](https://github.com/mnmal-ai-claude) with [Claude Code](https://claude.com/claude-code)"
git push -u origin feat/holomap-clusterer
gh run watch
```

Expected: all jobs green. Do not proceed to Task 8 on a red run.

---

### Task 8: Publish

**Files:**
- Modify: `.github/workflows/publish.yml`

- [ ] **Step 1: Open the PR and merge**

```bash
gh pr create --title "feat: holomap-clusterer — deterministic reduce→cluster, wasm + subprocess backends" \
             --body-file /tmp/holomap-clusterer-pr.md
```

Write the body to `/tmp/holomap-clusterer-pr.md` first — never inline heredoc. Include the gate-5 measurement tables from Task 6.

- [ ] **Step 2: Publish the crate**

holomap already has tokenless trusted publishing to crates.io. Follow its existing release convention: a `release/vX.Y.Z` branch with the version bump, merged with a `release: v` commit subject. **Do not push the tag by hand** — the workflow tags and publishes.

- [ ] **Step 3: Publish the npm package**

```bash
cd npm && pnpm build && pnpm publish --access public
```

Public because the crate is a thin composition of public `MIT OR Apache-2.0` crates and holomap is already public on crates.io. Verify: `npm view @mnmal-ai/holomap-clusterer version`.

- [ ] **Step 4: Verify the published package works from a clean install**

```bash
cd $(mktemp -d) && pnpm init && pnpm add @mnmal-ai/holomap-clusterer
node --input-type=module -e "
import { WasmClusterer } from '@mnmal-ai/holomap-clusterer';
const v = Array.from({length: 90}, (_, i) => {
  const a = new Float32Array(8); a[(i % 3) * 2] = 10; a[7] = i * 0.01; return a;
});
const r = await new WasmClusterer().cluster(v, {nComponents:0,nNeighbors:15,minClusterSize:5,seed:42});
console.log('clusters:', new Set(r.assignments.filter(l => l >= 0)).size);
"
```

Expected: `clusters: 3`. This catches a broken `files` list or a missing wasm asset, which no in-repo test can.

---

### Task 9: Migrate coda

**Files (in `/mnt/data/Develop/coda`):**
- Modify: `packages/dynamics/package.json`, `packages/dynamics/src/clusterer.ts`, `packages/dynamics/src/index.ts`, `packages/dynamics/src/bin.ts`
- Delete: `crates/coda-clusterer/`, root `Cargo.toml` workspace member

- [ ] **Step 1: Branch and add the dependency**

```bash
cd /mnt/data/Develop/coda
git checkout -b feat/adopt-holomap-clusterer
pnpm --filter @mnmal-ai/coda-dynamics add @mnmal-ai/holomap-clusterer
```

- [ ] **Step 2: Replace the local module with a re-export**

Replace the whole of `packages/dynamics/src/clusterer.ts` with:

```ts
/**
 * Clusterer peripheral adapter — now supplied by @mnmal-ai/holomap-clusterer.
 *
 * The interface and SubprocessClusterer moved to that package when the
 * clusterer crate did (holomap Decision 7c643598). Re-exported here so
 * existing imports keep working; import from the package directly in new code.
 */
export {
  type Clusterer,
  type ClusterParams,
  type ClusterResult,
  ClustererError,
  SubprocessClusterer,
  WasmClusterer
} from '@mnmal-ai/holomap-clusterer';
```

- [ ] **Step 3: Run the dynamics suite**

Run: `pnpm --filter @mnmal-ai/coda-dynamics test`
Expected: PASS, same count as before the change. `CODA_DYNAMICS_CLUSTERER` still works — it becomes the argv for the shared `SubprocessClusterer`.

- [ ] **Step 4: Point the default argv at the published binary**

In `packages/dynamics/src/bin.ts:73`, the default is `'target/release/coda-clusterer'`. Change it to `'target/release/holomap-clusterer'` and update the comment on line 70 to name the new crate and its repo.

- [ ] **Step 5: Delete the local crate**

```bash
git rm -r crates/coda-clusterer
```

Remove `"crates/coda-clusterer"` from the root `Cargo.toml` workspace members. If it was the only member, remove the `[workspace]` block.

Run: `cargo check --workspace`
Expected: exit 0, or a clean "no targets" if the workspace is now empty.

- [ ] **Step 6: Run coda's full gates**

Run: `pnpm test && pnpm check-types && pnpm lint`
Expected: all green, no count regressions.

- [ ] **Step 7: Commit and PR**

```bash
git add -A
git commit -m "refactor: adopt @mnmal-ai/holomap-clusterer, drop the local crate

The clusterer crate and the TypeScript Clusterer interface moved to the
holomap repo (Decision 7c643598) now that hydra-recall is a second consumer.
clusterer.ts becomes a re-export so existing imports keep working.

CODA_DYNAMICS_CLUSTERER is unchanged in meaning — it is now the argv for the
shared SubprocessClusterer. The default moves to target/release/holomap-clusterer.

Written by [mnmal-ai-claude](https://github.com/mnmal-ai-claude) with [Claude Code](https://claude.com/claude-code)"
gh pr create --title "refactor: adopt @mnmal-ai/holomap-clusterer" --body-file /tmp/coda-adopt-pr.md
```

- [ ] **Step 8: Exercise the wasm backend against coda's real workload**

Coda is the proving ground — it has the seam, the reference corpus, and a known-good result. Swap `WasmClusterer` in for one dynamics cycle and confirm the cluster count and noise land in the 30–60 / 10–35% band. Report the numbers. **Do not change coda's default backend** — this is a validation run, and the default stays subprocess until hydra-recall has its own reason to move.

---

## Self-Review

**Spec coverage.** Move + rename + relicense → Task 1. Behaviour preservation → Tasks 1–2. wasm binding, `+simd128`, `MAX_ROWS`, throwing errors, no top-level side effects → Tasks 3, 5. npm package with both backends → Tasks 4–5. Gate 1 → Task 2; gates 2 and 4 → Task 5; gate 3 → Task 6; gate 5 → Task 6. CI → Task 7. Publish → Task 8. Coda migration and proving ground → Task 9.

**One gap found and closed while writing:** the spec listed two must-survive behaviours (`min_samples` unset, `probabilities` always `None`). Reading `pipeline.rs` surfaced a **third** — `min_dist` stays at holomap's default 0.1, because 0.0 regresses the corpus to 13 clusters / 45.2% noise. It is now in Global Constraints and called out in Task 2's failure diagnosis.

**Not covered by any task, by design:** backend identity in persisted provenance. That belongs to the consumer, and lands with hydra-recall's `recall/Cluster` type in project B.

**Type consistency.** `ClusterParams` / `ClusterResult` / `Clusterer` / `ClustererError` are defined once in Task 4 and used unchanged in Tasks 5, 6 and 9. Rust `Params` / `Request` / `Response` / `run_pipeline` keep their coda signatures throughout. The wasm export `reduce_and_cluster` is defined in Task 3 and consumed in Task 5 with matching arity and order.
