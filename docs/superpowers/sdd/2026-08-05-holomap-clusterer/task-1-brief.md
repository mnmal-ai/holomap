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

