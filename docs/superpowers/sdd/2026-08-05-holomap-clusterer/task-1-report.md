# Task 1 report: land holomap-clusterer in a holomap workspace

**Status:** DONE
**Commit:** `01ea9e5` on branch `feat/holomap-clusterer` (worktree `/mnt/data/Develop/holomap/.worktrees/holomap-clusterer`)

## What changed

1. **Root `Cargo.toml`** — added a `[workspace]` table above `[package]`:
   ```toml
   [workspace]
   members = [".", "crates/holomap-clusterer"]
   ```
   Diff is exactly that (verified with `git diff Cargo.toml` before commit — three added lines, nothing else touched).

2. **`crates/holomap-clusterer/`** created by `cp -r` of `coda/crates/coda-clusterer/{src,tests}` (origin commit `379d843a`, "feat: Phase-0 clusterer validation spike — verdict FALLBACK-Python; #237 budget measured (#22)" — four commits touch `crates/coda-clusterer` in coda's history (`379d843a`, `a3c27919`, `e6a47fbe`, `6062a084`); `379d843a` is the oldest of the four, which is why `git log --oneline -- crates/coda-clusterer | tail -1` (per the brief's Step 3) selects it as the origin commit).

   - `src/lib.rs`, `src/protocol.rs` — copied byte-identical (confirmed via `diff`, zero output).
   - `src/main.rs`, `tests/protocol.rs` — only `coda_clusterer` → `holomap_clusterer` in `use`/fully-qualified references (7 occurrences total across the two files), via
     `grep -rl 'coda_clusterer' src tests | xargs sed -i 's/coda_clusterer/holomap_clusterer/g'`. Post-sed `grep -rn 'coda_clusterer' src tests` printed nothing.
   - `src/pipeline.rs` — exactly one line changed, the doc-comment:
     `//! see \`docs/2026-06-06-phase0-clusterer-spike-findings.md\` for the root-cause`
     → `//! see coda's \`docs/2026-06-06-phase0-clusterer-spike-findings.md\` for the root-cause`
     Confirmed via `diff` against the coda source: this is the *only* line that differs. `min_samples` is left unset (not touched) and `min_dist` stays at the source's 0.1 (not touched) — both per the global constraints, both untouched by construction since I never edited those lines.

3. **`crates/holomap-clusterer/Cargo.toml`** — written from the brief verbatim: `license = "MIT OR Apache-2.0"` (relicensed up from coda's `Apache-2.0`), `hdbscan = { version = "0.12", default-features = false, features = ["serial"] }` (unchanged from source — rayon never enabled), `holomap = { version = "0.2", path = "../.." }` (both version and path kept, per the caller's resolved ambiguity #3).

## Deviations from the brief, and why

- **Step 1 (branch creation) skipped** — branch already existed and was checked out in this worktree, per the caller's resolved ambiguity #1.
- **Step 3 (history-preserving `format-patch`/`git am`) skipped in favor of plain `cp`** — per the caller's resolved ambiguity #2 (unrelated histories, 4-file crate). Origin commit named in the Step 8 commit message as instructed.
- **`Cargo.lock` staged and committed alongside `Cargo.toml` and `crates/holomap-clusterer`**, which the brief's Step 8 `git add` line does not mention. `Cargo.lock` is git-tracked in this repo (`git ls-files Cargo.lock` confirms), and the workspace conversion regenerated it (`cargo test` added 50 insertion-only lines — new transitive deps for `hdbscan`/`holomap-clusterer`, no existing entries altered). Committing a stale lockfile alongside a workspace-adding manifest change seemed clearly worse than the minor scope expansion, so I included it and called it out in the commit message. Flagging this explicitly in case the reviewer wants it split into a separate commit.

Nothing else deviated. No other file under `crates/holomap-clusterer` differs from the coda source beyond the two categories above (crate-name references, one doc-comment line).

## Verification — exact commands and output

**Step 6 — moved suite:**
```
$ cargo test -p holomap-clusterer
```
```
running 6 tests
test error_response_omits_optional_fields ... ok
test pipeline_rejects_inconsistent_dimensions ... ok
test request_round_trips_from_json ... ok
test response_serialises_with_version ... ok
test hdbscan_separates_three_blobs ... ok
test reduced_pipeline_is_deterministic_for_fixed_seed ... ok

test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.21s
```
6 passed, exit 0 — matches coda-clusterer's count exactly.

**Step 7 — holomap crate unaffected:**
```
$ cargo test -p holomap
```
Summed across all four test binaries (`unittests`, `tests/determinism_proptest.rs`, `tests/quality_gate.rs`, doc-tests):
```
test result: ok. 45 passed; ...   (lib unittests)
test result: ok. 1 passed; ...    (determinism_proptest)
test result: ok. 3 passed; ...    (quality_gate)
test result: ok. 1 passed; ...    (doc-tests)
```
45 + 1 + 3 + 1 = **50 passed**, 0 failed, exit 0 — matches the expected count exactly.

**Workspace sanity check:** `cargo metadata --no-deps` lists both `holomap` and `holomap-clusterer` as workspace members with `holomap-clusterer` depending on local `holomap` via path.

## What I was unsure about

- Whether to fold `Cargo.lock` into this commit vs. a separate one — resolved as above (included, called out).
- The brief's commit-message template says "at `<origin-sha>`" — I used the short sha `379d843a` (what `git log --oneline` gives); happy to switch to the full sha if the reviewer wants it, but nothing in the brief specified length.
- No other open questions. All three global constraints (min_samples unset, min_dist 0.1, hdbscan serial-only) were verified untouched by diffing the copied `pipeline.rs`/`Cargo.toml` line-by-line against the coda source before commit.

## Fix round 1 (post-review)

Review came back spec ✅, code Approved, with one Important finding: line 15 (in the "What changed" section, item 2) claimed `379d843a` was "the only commit touching `crates/coda-clusterer` in coda's history." That claim was false — verified independently, not taken on the reviewer's word:

```
$ cd /mnt/data/Develop/coda && git log --oneline -- crates/coda-clusterer
6062a084 chore(clusterer): bump holomap 0.1.0 → 0.2.0 (correctness + bug fixes) (#41)
e6a47fbe chore(clusterer): holomap via crates.io 0.1.0 — git pin retired (#32)
a3c27919 feat(clusterer): holomap reduction stage — the GO-Rust path reopens (#29)
379d843a feat: Phase-0 clusterer validation spike — verdict FALLBACK-Python; #237 budget measured (#22)
```

Four commits touch the crate, not one. `379d843a` is correctly the oldest of the four (last in `--oneline` order, so `tail -1` correctly selects it per the brief's Step 3), and the commit message and mechanical origin-sha selection were both already correct — only the report's stated justification was wrong. Corrected item 2 above to state "four commits touch `crates/coda-clusterer`... `379d843a` is the oldest of the four, which is why `tail -1` selects it as the origin commit." No code changes, no new commit to the crate — this was a report-only correction.
