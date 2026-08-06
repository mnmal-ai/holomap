# SDD ledger — plan: docs/superpowers/plans/2026-08-05-holomap-clusterer.md

Worktree: /mnt/data/Develop/holomap/.worktrees/holomap-clusterer (branch feat/holomap-clusterer, off docs/holomap-cluster-wasm-spec @ 171dd32)
Task 9 runs in /mnt/data/Develop/coda, not this worktree.

Pre-flight: Task 8 (publish to crates.io + npm) is outward-facing and irreversible.
Not delegated to a subagent — stops for Rich's authorization. Task 9 depends on it.

Task 1: implemented (commit 01ea9e5, agent ac96b608e03d2a53e) — crate landed as
  holomap-clusterer, root manifest converted to a workspace. Tests 6 + 50, both exit 0.
Task 1: review — spec OK; quality Approved with 1 Important.
  Important: task-1-report.md line 15 falsely claims 379d843a is the ONLY commit touching
  crates/coda-clusterer; there are four. Outcome correct (379d843a IS the oldest/origin and
  is correctly named in the commit message), justification false.
  Minor (accepted, not deferred): Cargo.lock committed though not in the brief's git add —
  verified already-tracked and insertion-only.
Task 1: fix round 1/5 dispatched to ac96b608e03d2a53e — report correction only, no code change.
Task 1: fix round 1/5 (1 addressed, 0 open) — implementer independently re-ran
  `git log --oneline -- crates/coda-clusterer`, confirmed four commits, corrected the report.
  DEVIATION: no scoped re-review dispatched. The fix changed zero tracked files (report lives
  in gitignored scratch), so review-package would yield an empty diff and a re-review would be
  vacuous. Verified ADDRESSED directly: false claim gone, tree clean, HEAD still 01ea9e5.
Task 1: complete (commits 6ce972e..01ea9e5, review clean)

Task 2: implemented (commit 6498b23, agent a77248f4fff9d2b19) — env-gated fixture regression.
  Skip path OK; real run 83.94s -> clusters=36 noise=30.0%, inside both bands.
Task 2: review — spec OK; quality Approved with 1 Minor.
  Resolved reviewer's "cannot verify" item MYSELF before completing: hdbscan 0.12
  hyper_parameters.rs:205 `min_samples: self.min_samples.unwrap_or(min_cluster_size)`
  — the min_samples invariant is real, verified in source. Not a gap.
  CONTROLLER FINDING (mine, not the implementer's): the 27.2% reference figure I put in
  the spec/plan is sklearn-clustered (holomap_gate.py imports sklearn.cluster.HDBSCAN).
  This crate uses Rust hdbscan 0.12. Cluster count matches exactly (36); noise differs ~3pts.
  Corrected spec+plan in 0ab179a; all-Rust baseline 36 / 30.0% now recorded.
Task 2: minor (deferred): crates/holomap-clusterer/tests/fixture_regression.rs doc comment
  still attributes 36/27.2% to this pipeline. Corrected wording is in the plan at Task 2
  Step 1 (commit 0ab179a) — apply verbatim in the final fix wave.
Task 2: complete (commits 01ea9e5..0ab179a, review clean, 1 minor deferred)

Task 3: implemented (commit 1680d4f, agent ac6ff929b29ab47af) — wasm binding behind a
  `wasm` feature. 8 tests pass, native binary intact, holomap_clusterer_bg.wasm 261,036 B,
  node smoke test clustered correctly.
  DEVIATION (verified by me independently): wasm-pack 0.15.0 is incompatible with cargo
  1.95.0 — it calls `cargo build --out-dir`, renamed to --artifact-dir. Replaced with direct
  cargo wasm32 build + wasm-bindgen-cli pinned to Cargo.lock's 0.2.126. Plan Tasks 5+7
  amended (cf52ed7) to a single scripts/build-wasm.sh so the wall isn't hit twice more.
Task 3: review — spec OK; quality Approved with 1 Minor.
  CONTROLLER FIX (my plan error): Task 3's Interfaces line declared 7 params incl. n_rows;
  the code block has 6 and derives n_rows. Corrected in ab73cba.
  Minor PROMOTED, not deferred: `seed as u64` saturates — NaN/negative -> 0 silently, >2^53
  loses precision. Determinism is the product, so a silently-different seed is the worst
  failure this API has. Task 5 now rejects rather than coerces (ab73cba), 4 test cases.
Task 3: complete (commits 0ab179a..1680d4f, review clean)

Task 4: implemented (commit 283df1a, agent a46be5f7210e143db) — npm package, Clusterer
  interface + SubprocessClusterer copied byte-identical from coda (verified by reviewer
  against coda HEAD). check-types exit 0, vitest exit 0, 2 passed (re-verified by me;
  editor tsserver "cannot find module" noise is an artefact of npm/node_modules not being
  resolved by the IDE — tsc itself is clean).
Task 4: review — spec OK; quality Approved with 1 Minor.
Task 4: minor (deferred): ProtocolResponse was module-private in coda; the file split forced
  exporting it, so `export *` leaks a wire-protocol type into the public API. One-line fix.
Task 4: minor (deferred, CODA-SIDE not ours): SubprocessClusterer's close handler treats any
  non-empty stdout as success regardless of exit code (subprocess-clusterer.ts:46-53,
  inherited character-for-character from coda clusterer.ts:87-95). Reviewer and I agree:
  leaving it was correct — fixing mid-copy would violate the verbatim requirement, and it is
  live coda production behaviour, so the fix belongs in coda first. FILE A CODA TODO.
Task 4: complete (commits ab73cba..283df1a, review clean, 2 minors deferred)

Task 5: implemented (commit aea1c74, agent aa58a295aa0fd63b5) — WasmClusterer + seed guard
  + scripts/build-wasm.sh. 11 passed across 3 files, check-types exit 0 (both re-verified by me).
  Deviations judged sound by reviewer: npm/wasm/package.json {"type":"commonjs"} (CJS glue
  under an ESM package), and a test-only --import loader (--experimental-strip-types does not
  remap .js specifiers to sibling .ts).
Task 5: review — spec OK; 1 Important.
  Important: worker-smoke.test.ts does not gate laziness. The IMPLEMENTER found this itself by
  forcing an eager top-level load and watching the test still pass, then reported it rather
  than hiding it. Reviewer confirmed independently and confirmed the implementation IS lazy
  (require lives only in #load(), wasm-clusterer.ts:37, called from cluster() :70).
  The test still earns its place — it gates Worker-environment compatibility, just not laziness.
Task 5: fix round 1/5 dispatched — add a require.cache assertion that DOES gate laziness,
  keep worker-smoke as-is, and demonstrate the new test red on an eager implementation first.
Task 5: fix round 1/5 (1 addressed, 0 open; commits aea1c74..5a6fe68) — new
  wasm-lazy-load.test.ts asserts require.cache membership for the wasm glue. Demonstrated
  RED on an eager implementation (real failing output recorded, exit 1), reverted
  byte-identical, green again. Re-review: path derivation correct, worker-smoke untouched,
  diff purely additive, no new breakage.
Task 5: complete (commits 283df1a..5a6fe68, review clean) — 12 passed across 4 files.

Task 6: implemented (commit 0b78e95, agent acca9499486899517) — backend-equivalence test
  (13 passed, 5 files, exit 0; check-types exit 0) + bench/measure.ts. tsx added as a
  devDependency; bench/ verified outside both the vitest glob and tsconfig include.
Task 6: review — spec OK; 1 Critical + 3 Important, ALL against the benchmark, none against
  the equivalence test.
  Critical: wasm's one-time module load (readFileSync + WebAssembly compile + instantiate)
    lands INSIDE the timed n=723 figure and not n=10k, because the lazy require fires on the
    first cluster() call and the loop runs 723 before 10k, wasm before subprocess. That fixed
    cost is the same magnitude as the claimed ~4% simd delta, so the delta is confounded.
  Important: single-shot, no repetition — cannot support a 4% claim. (Report said so itself;
    reviewer credited that as honest rather than evasive.)
  Important: RSS reads process.memoryUsage() of the HARNESS, so "subprocess RSS" is the
    parent's memory, not the spawned binary's. Also a post-hoc snapshot, not a peak, despite
    the docstring saying "peak RSS".
  Important: report falsely claims npm/wasm/ is gitignored. It is TRACKED — 5 files incl. the
    261036-byte binary, committed at aea1c74. Tree stayed clean by build determinism, not by
    an ignore rule. OPEN QUESTION FOR RICH: should that binary be committed at all, given CI
    builds it in Task 7? Committed = fresh clone works with no Rust toolchain; also = a blob
    that can silently drift from its source.
Task 6: fix round 1/5 dispatched — warm-up before timing, median-of-3 at 723 with 10k
  labelled single-shot, RSS fixed or dropped, report claim corrected. Tracking unchanged.
Task 6: fix round 1/5 (4 addressed, 0 open; commits 7cea47d..1740c9a) — warm-up before all
  timing, median-of-3 at 723, 10k labelled single-shot, RSS column dropped (was the harness's
  own memory, and a snapshot not a peak), report's gitignore claim corrected. Re-review
  confirmed the warm-up is genuine (require caches process-wide, so the first timed call is
  already warm) and the median is 3 real runs. No tracking changed. No new breakage.
Task 6: complete (commits 5a6fe68..1740c9a, review clean)
  RESULT WORTH KEEPING: removing the compile confound ERASED the apparent ~4% SIMD win —
  n=723 identical with/without +simd128, n=10k ~2.2% single-shot. My auto-vectorisation
  rationale is retracted in 36edb6d; the flag stays only because it is free.
  Measured backend cost: wasm 2.4s/53.6s vs subprocess 1.3s/30.5s at n=723/10k — wasm costs
  ~1.8x, both clearing the 300s gate with 5.6x headroom.

Task 7: implemented (commit 772547b, agent a678d3559f3ae0014) — CI covers the workspace,
  the wasm build and the npm suite; npm/wasm/ untracked (verified by me: git ls-files empty,
  .gitignore:15 matches, all 5 files still on disk, tree clean); prepublishOnly + pretest.
  Guard watched firing BOTH ways: green 13/13, red "wasm artifact missing" exit 1.
Task 7: review — spec FAILED. 1 Critical + 1 Important + 1 Minor.
  Critical: the lint job fails deterministically on first run. --workspace newly lints
    crates/holomap-clusterer, exposing clippy's manual-is_multiple_of at wasm.rs:24 and :51.
    reshape() is UNGATED code that had never been linted, because the old clippy invocation
    had no --workspace and only checked the root crate. Reviewer RAN it; the implementer's
    report said "Concerns: None outstanding" on the strength of YAML-parse + actionlint,
    neither of which can catch a compile-time lint failure. Second time today a "no concerns"
    claim was refuted by a sub-minute check.
  Important: no cargo cache on the wasm job — `cargo install wasm-bindgen-cli --locked`
    compiles from source every run. Brief flagged the cost; diff and report both ignored it.
  Minor: pretest verified on local pnpm 11.18.0 but CI pins pnpm v10.
  Verified sound by the reviewer, do not re-litigate: job ordering, artifact deps, SHA pinning,
  and `cargo test --workspace --all-features` passing with the wasm feature on a native target.
Task 7: fix round 1/5 dispatched — fix both clippy sites with is_multiple_of (no allow, no
  weakening the invocation), add SHA-pinned cargo caching, address the pnpm skew honestly.
Task 7: fix round 1/5 (3 addressed, 0 open; commits 772547b..0303de8) — both clippy sites use
  is_multiple_of (no allow, invocation unchanged, sense preserved at the negated site);
  Swatinem/rust-cache SHA-pinned (resolved via gh api, verified as the real peeled commit for
  v2.9.1); pnpm skew CLOSED not noted — real pnpm 10.34.5 installed, both guard paths re-run.
  Clippy independently verified by me: exit 0. cargo test --workspace --all-features: 61 test
  fns + 2 doctests, 0 failures.
Task 7: complete (commits 36edb6d..0303de8, review clean)

Tasks 1-7 done. Task 8 (publish) STOPS for Rich — outward-facing and irreversible.
Task 9 (coda migration) depends on Task 8.

FINAL WHOLE-BRANCH REVIEW (opus, 20 commits, merge-base 9615912..0303de8): NOT READY TO PUBLISH.
  All three pipeline invariants verified intact in the final state.
  Critical 1: pnpm publish would ship NO JavaScript — prepublishOnly builds only wasm, tsc is
    never invoked by any lifecycle hook, dist/ is gitignored, and files:[] silently omits a
    missing entry. Looked fine locally only because of stale build output.
  Critical 2: root Cargo.toml include globs are unanchored, so bare README.md matches at any
    depth — `cargo package --list -p holomap` = 221 of 225 entries under npm/node_modules/.
    Pre-existing pattern, newly triggered by this branch adding npm/.
  Fix wave dispatched for the unambiguous items ONLY (prepack, anchored globs, license files,
  publish.yml --workspace, the stale 27.2% in code, the machine path, ProtocolResponse leak).

*** BLOCKED ON RICH — four decisions, explicitly asked to hold until he answers ALL of them.
*** Take no action on any of these until then. Nothing publishes. Tasks 8 and 9 stay parked.
  D1 LICENSE: nalgebra 0.35.0, simba 0.10.0, approx 0.5.1 are Apache-2.0 ONLY, reached via
     holomap. So the MIT arm of "MIT OR Apache-2.0" is over-broad. Pre-existing on holomap;
     this branch restates it on a new crate. No copyleft anywhere.
  D2 REGISTRY: npm/package.json has no publishConfig. Scoped @mnmal-ai/* defaults to
     access:restricted; only the plan carried --access public. Spec ASSUMED public — confirm
     or flip. (Other @mnmal-ai/* packages publish to GH Packages, restricted.)
  D3 READMEs: neither npm/ nor crates/holomap-clusterer/ has one — both registry pages render
     blank. Nothing tells a consumer SubprocessClusterer needs a Rust toolchain they lack.
  D4 BACKEND CONTRACTS: WasmClusterer rejects empty input, ragged dims, bad seeds;
     SubprocessClusterer validates none of it. Same interface, different rejection surface.
     MAX_ROWS=50_000 is wasm-only and undocumented in types.ts. v0.1.0 freezes this.
  ALSO PARKED (mine, not asked): publish.yml's packages[0] version pick depends on cargo
     metadata ordering — works today by alphabetical luck. And nothing publishes
     holomap-clusterer at all yet.
FINAL FIX WAVE: complete (commit ebdefe8). All 7 findings ADDRESSED, re-review clean, no new
  breakage. Verified by me independently: holomap tarball 22 entries / 0 node_modules; npm
  tarball carries dist/index.js + wasm + both LICENSEs; clippy exit 0. pipeline.rs changes were
  comments-only, all three invariants confirmed untouched.

RICH'S FOUR DECISIONS (all answered 2026-08-05):
  D1 LICENSE: keep MIT OR Apache-2.0, ADD third-party attribution (nalgebra/simba/approx are
     Apache-2.0-only and the npm package ships them compiled into the .wasm — crates.io ships
     source so it was never in this position; npm is the first combined-work distribution).
  D2 REGISTRY: internal first, public later. Recommended his own dogfood-before-publish concept
     instead — no publish at all until hydra-recall exercises it via file:/link:, then GH
     Packages restricted (matches every other @mnmal-ai/*), then public npmjs. Task 8 shrinks
     to "wire registry config", NOT "publish".
  D3 READMEs: create for npm/ and crates/holomap-clusterer/, lead with technology choices and
     the WHY — Rich: "original implementation was quick and dirty, now we're on solid
     grounding so we need to be explicit".
  D4 CONTRACTS: align. SubprocessClusterer gains WasmClusterer's empty/ragged/seed validation;
     MAX_ROWS documented in types.ts instead of being a wasm-only surprise.

D4 CONTRACTS: complete (commits 6a9ee15 + 77670b8). validateClusterInput is a single
  definition in npm/src/validation.ts used by both backends; SubprocessClusterer rejects
  BEFORE spawn; WASM_MAX_ROWS documented in types.ts as deliberately wasm-only.
  21 tests / 5 files, check-types 0, vitest 0, clippy 0. Branch = 23 commits, tree clean.

  REVIEW FALSIFIED THE IMPLEMENTER'S CAUSAL CLAIM — the most valuable catch of the run.
  Reported: "seed 2**53 crashed the child (exit 101, Rust panic)". Reviewer reproduced the
  panic independently and showed it is triggered by ROW-COUNT, not the seed — identical with
  seed 42 given 2 points / min_cluster_size 5, and unreproducible with 2**53 across a dozen
  configs. The test written for it never reached the crash path (failed earlier on
  "need more than n_neighbors=15 points, got 1").

  REAL DEFECT THAT FELL OUT OF IT, now fixed: rows < max(minClusterSize, 2) panics
  hdbscan-0.12.0/src/core_distances/serial.rs:78 (index out of bounds, exit 101). Threshold
  established EMPIRICALLY by sweeping rows x minClusterSize over 2,3,5,8,10,15 — identical on
  both the direct (nComponents=0) and reduction paths. The max(_,2) term exists because
  hdbscan silently CLAMPS min_cluster_size to 2 and prints HDBSCAN_WARNING, then panics.
  Also reachable in WasmClusterer, where it surfaced as an opaque "unreachable".
  Known limitation recorded: that boundary is an observed property of hdbscan 0.12 internals,
  not a documented contract — a dependency bump could move it.

*** STILL OPEN — clean handoff state, nothing half-done, tree clean:
  1. D3 READMEs — npm/ and crates/holomap-clusterer/, leading with technology choices + WHY
     (holomap+hdbscan over Python, why two backends, what determinism buys). Rich: be explicit,
     the original was quick and dirty.
  2. D1 attribution — THIRD-PARTY-LICENSES in npm/ for the Apache-2.0-only deps
     (nalgebra 0.35.0, simba 0.10.0, approx 0.5.1) the .wasm ships compiled.
  3. Task 8 — now just "wire registry config" (GH Packages restricted). NO PUBLISH: dogfood
     via file:/link: from hydra-recall first, per Rich's own dogfood-before-publish concept.
  4. Task 9 — migrate coda to the shared package.
  STRENGTHENED CODA FINDING (was Task 4's deferred minor, now confirmed reachable in practice):
  SubprocessClusterer's close handler treats non-empty stdout as success regardless of exit
  code. hdbscan prints HDBSCAN_WARNING to stdout then panics — so a real crash can arrive as a
  JSON parse error rather than "clusterer exited 101". Inherited verbatim from coda; fix belongs
  in coda first.
