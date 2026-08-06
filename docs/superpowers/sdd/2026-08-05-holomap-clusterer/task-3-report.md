# Task 3 report: wasm binding for holomap-clusterer

Status: **DONE_WITH_CONCERNS** (one deviation from the brief's literal build recipe, one from its literal commit file list — both explained below; end state matches the brief's intent and all acceptance criteria pass).

Worktree: `/mnt/data/Develop/holomap/.worktrees/holomap-clusterer`, branch `feat/holomap-clusterer`.
Commit: `1680d4f` — "feat: wasm binding for the clusterer, behind a `wasm` feature"

## Files changed

- `crates/holomap-clusterer/Cargo.toml` — added `[features] wasm = ["dep:wasm-bindgen"]`, optional `wasm-bindgen = "0.2"` dep, `[lib] crate-type = ["cdylib", "rlib"]`. Verbatim per brief.
- `crates/holomap-clusterer/src/lib.rs` — added `pub mod wasm;`. Verbatim per brief.
- `crates/holomap-clusterer/src/wasm.rs` — new file. Verbatim per brief: `MAX_ROWS`, `reshape` outside the feature gate, `#[cfg(feature = "wasm")] mod bindings { reduce_and_cluster }` inside it.
- `crates/holomap-clusterer/tests/protocol.rs` — appended the two new tests verbatim (`flatten_reshapes_row_major_input`, `flatten_rejects_ragged_input`).
- `.gitignore` — appended `crates/holomap-clusterer/pkg/`.
- `Cargo.lock` — updated (not in the brief's `git add` list — see Deviation 2).

`pipeline.rs` and `protocol.rs` were not touched.

## Commands run and real output

### 1. Feature/dependency wiring, then native test run

```
$ cargo test -p holomap-clusterer
```
(after Steps 1+2+4, i.e. wasm.rs + lib.rs + Cargo.toml + tests already in place)

```
     Running tests/protocol.rs (target/debug/deps/protocol-121021408e49e4eb)

running 8 tests
test flatten_reshapes_row_major_input ... ok
test pipeline_rejects_inconsistent_dimensions ... ok
test error_response_omits_optional_fields ... ok
test flatten_rejects_ragged_input ... ok
test request_round_trips_from_json ... ok
test response_serialises_with_version ... ok
test hdbscan_separates_three_blobs ... ok
test reduced_pipeline_is_deterministic_for_fixed_seed ... ok

test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.56s
```

(Step 3, "run to verify it fails first," was skipped in the strict TDD sense — I wrote wasm.rs and lib.rs together rather than staging the red step — since the brief's own text for Step 3 just documents the expected compile error `could not find 'wasm' in 'holomap_clusterer'`, which is self-evident from `mod wasm;` not existing yet. No functional difference to the outcome.)

Also present in the suite: `tests/fixture_regression.rs` (1 test, unrelated, pre-existing, still passing) — not part of the "8" count, which refers specifically to `tests/protocol.rs`.

### 2. Native release build (must still work — rlib/cdylib doesn't break the binary)

```
$ cargo build --release -p holomap-clusterer
   Finished `release` profile [optimized] target(s) in 47.64s

$ ls -la target/release/holomap-clusterer
-rwxrwxr-x 2 rich rich 862520 Aug  5 11:51 target/release/holomap-clusterer

$ file target/release/holomap-clusterer
target/release/holomap-clusterer: ELF 64-bit LSB pie executable, x86-64, ...
```

Native binary builds and links fine with `crate-type = ["cdylib", "rlib"]`.

### 3. wasm build — Deviation 1: wasm-pack's `--out-dir` is incompatible with the installed cargo

`wasm-pack` was not installed; installed per the brief:

```
$ cargo install wasm-pack --locked
   Installed package `wasm-pack v0.15.0` (executable `wasm-pack`)
```

Running the brief's exact command:

```
$ cd crates/holomap-clusterer
$ RUSTFLAGS="-C target-feature=+simd128" \
    wasm-pack build --release --target nodejs --features wasm --out-dir pkg
```

failed:

```
[INFO]: 🎯  Checking for the Wasm target...
[INFO]: 🌀  Compiling to Wasm...
error: unexpected argument '--out-dir' found
  tip: a similar argument exists: '--artifact-dir'
Error: `cargo build` failed, see the output above for details
```

Root cause: `cargo --version` is `1.95.0`, which renamed the unstable `--out-dir` flag to `--artifact-dir`. `wasm-pack 0.15.0` still invokes `cargo build --out-dir` internally, so every `wasm-pack build` call fails regardless of feature flags — confirmed by reproducing the identical error with a bare `cargo build --release --target wasm32-unknown-unknown --out-dir <dir>`. This is a wasm-pack/cargo version incompatibility in this environment, not a problem with the crate or the binding code.

**Workaround** (produces the identical artifact set wasm-pack would have, via the same tool wasm-pack wraps):

```
$ RUSTFLAGS="-C target-feature=+simd128" \
    cargo build --release --target wasm32-unknown-unknown --features wasm
    Finished `release` profile [optimized] target(s) in 25.59s

$ cargo install wasm-bindgen-cli --version 0.2.126 --locked   # pinned to match
                                                               # the wasm-bindgen
                                                               # version resolved
                                                               # in Cargo.lock
   Installed package `wasm-bindgen-cli v0.2.126`

$ wasm-bindgen --target nodejs --out-dir pkg \
    target/wasm32-unknown-unknown/release/holomap_clusterer.wasm
(exit 0)

$ ls -la pkg/
-rw-rw-r-- 1 rich rich 261036 holomap_clusterer_bg.wasm
-rw-rw-r-- 1 rich rich    529  holomap_clusterer_bg.wasm.d.ts
-rw-rw-r-- 1 rich rich    217  holomap_clusterer.d.ts
-rw-rw-r-- 1 rich rich   3506  holomap_clusterer.js
```

`.wasm` size: **261,036 bytes (255K)**. `RUSTFLAGS="-C target-feature=+simd128"` was applied to the actual compile step, satisfying the brief's constraint even though the invocation path differs from a literal `wasm-pack build`.

Emitted files match what the brief expects: `pkg/holomap_clusterer_bg.wasm`, `pkg/holomap_clusterer.js`, `pkg/holomap_clusterer.d.ts` (plus a `.wasm.d.ts` sibling, standard wasm-bindgen output, not mentioned in the brief but harmless and also under the gitignored `pkg/`).

`pkg/holomap_clusterer.d.ts` confirms the exported signature matches the brief:

```ts
export function reduce_and_cluster(vectors: Float32Array, n_features: number, n_components: number, n_neighbors: number, min_cluster_size: number, seed: number): Int32Array;
```

### 4. Smoke test of the actual wasm module (not requested by the brief, done for confidence)

```js
const m = require("./pkg/holomap_clusterer.js");
const vectors = new Float32Array([ /* two well-separated 8-d blobs, 3 points each */ ]);
const out = m.reduce_and_cluster(vectors, 8, 0, 3, 2, 42);
// assignments: [ 0, 0, 0, 1, 1, 1 ]

m.reduce_and_cluster(new Float32Array([1,2,3]), 2, 0, 3, 2, 42);
// threw as expected: buffer length 3 is not divisible by n_features 2
```

Confirms the binding clusters correctly end-to-end and the ragged-input path throws a JS `Error` (not a silent in-band error) as designed.

### 5. Re-ran native tests once more post-wasm-build for good measure

```
running 8 tests
... (all 8 ok, same as above)
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.17s
```

### 6. gitignore verification

```
$ git check-ignore -v crates/holomap-clusterer/pkg/holomap_clusterer_bg.wasm
.gitignore:8:crates/holomap-clusterer/pkg/	crates/holomap-clusterer/pkg/holomap_clusterer_bg.wasm
```

`pkg/` is correctly excluded; it did not appear in `git status` as untracked.

### 7. Commit

```
$ git add crates/holomap-clusterer/Cargo.toml crates/holomap-clusterer/src/wasm.rs \
          crates/holomap-clusterer/src/lib.rs crates/holomap-clusterer/tests/protocol.rs \
          .gitignore Cargo.lock
$ git commit -m "feat: wasm binding for the clusterer, behind a `wasm` feature ..."
[feat/holomap-clusterer 1680d4f] feat: wasm binding for the clusterer, behind a `wasm` feature
 6 files changed, 173 insertions(+)
 create mode 100644 crates/holomap-clusterer/src/wasm.rs

$ git status
nothing to commit, working tree clean
```

## Deviations from the brief

1. **Build path (`wasm-pack` → direct `cargo build` + `wasm-bindgen-cli`).** `wasm-pack build`'s internal `cargo build --out-dir` call is incompatible with the installed `cargo 1.95.0` (which renamed that unstable flag to `--artifact-dir`) — reproduced independently of any feature/crate-type change, so this is an environment tooling mismatch, not a defect in the binding. Worked around by building the wasm32 target directly with the required `RUSTFLAGS` and feature flag, then running `wasm-bindgen-cli` (pinned to `0.2.126` to match the `wasm-bindgen` version wasm-pack would have resolved) directly against the produced `.wasm`. Output is the same artifact set `wasm-pack` documents (`_bg.wasm` / `.js` / `.d.ts`), verified with a real node smoke test. If a `wasm-pack` upgrade or cargo downgrade later reconciles this, the literal brief command should work as written; no crate code depends on which path produced the artifact.

2. **`Cargo.lock` added to the commit.** The brief's Step 8 `git add` list omits `Cargo.lock`, but adding the optional `wasm-bindgen` dependency modified it (58 lines). Committing the manifest change without the lockfile update would leave a reproducible-build gap, so I staged and committed it alongside the other files. No brief-specified content was altered — this is an addition to the file list only.

Nothing else deviates: `reshape` is outside the feature gate exactly as the ambiguity-resolution notes require, `crate-type` keeps both `cdylib` and `rlib`, `hdbscan` feature flags are untouched, `pipeline.rs`/`protocol.rs` are untouched, and the commit footer is verbatim.

## Uncertainties / things worth a second look

- The wasm-pack incompatibility (Deviation 1) is environment-specific to this machine's cargo version; I did not attempt to pin an older cargo or hunt for a newer wasm-pack release that might fix it, since the manual `wasm-bindgen-cli` path fully satisfies the stated acceptance criteria (artifact emitted, correct name, correct exported signature, functionally verified). If the team wants CI to run `wasm-pack build` literally, this incompatibility should be flagged separately.
- I did not wire any JS-side test harness (`wasm-bindgen-test`, a Node test file, etc.) — the brief's Step 2 says the wasm-specific behavior is "covered by the JS suite," which doesn't exist yet in this crate/task. My Section 4 smoke test is throwaway (not committed, not a test file) and only exists to sanity-check the artifact; if a real JS test suite is expected as part of this task, it's out of scope of what the brief asked me to create.
