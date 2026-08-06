# Task 6 report: backend equivalence + measured gates

Worktree: `/mnt/data/Develop/holomap/.worktrees/holomap-clusterer`
Branch: `feat/holomap-clusterer`
Commit: `0b78e95`
Host: Intel Core i5-3470S @ 2.90GHz, 4 cores, 7.7 GiB RAM, Linux.

## Status: PASS — gate 5 clears comfortably on both wasm builds

## Step 1–2: equivalence test

Wrote `npm/test/backend-equivalence.test.ts` verbatim from the brief.

```
cd npm && pnpm test backend-equivalence
```

Output:

```
 ✓ test/backend-equivalence.test.ts (1 test) 539ms
   ✓ backend equivalence > both backends recover the same cluster structure  537ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
```

Exit code: `0`.

Full suite (`pnpm test`, no filter) afterward, to confirm nothing else broke:

```
 ✓ test/wasm-clusterer.test.ts (8 tests) 303ms
 ✓ test/worker-smoke.test.ts (1 test) 736ms
 ✓ test/subprocess-clusterer.test.ts (2 tests) 123ms
 ✓ test/wasm-lazy-load.test.ts (1 test) 70ms
 ✓ test/backend-equivalence.test.ts (1 test) 3648ms

 Test Files  5 passed (5)
      Tests  13 passed (13)
```

Exit code: `0`.

`pnpm check-types` (`tsc -p tsconfig.json --noEmit`): exit code `0`, no errors — `bench/` is not under `tsconfig.json`'s `include: ["src"]` so it was never in scope; no exclusion needed, confirmed empirically rather than assumed.

## Step 3: measurement harness

Wrote `npm/bench/measure.ts` verbatim from the brief, with one adjustment to the doc-comment's invocation line (see deviation below). The native binary path resolution (`../../target/release/holomap-clusterer` relative to the file) was already correct — `target/release/holomap-clusterer` existed from a prior `cargo build --release -p holomap-clusterer`.

### Deviation 1 — ambiguity 1, harness runner

The brief's doc-comment says `pnpm tsx bench/measure.ts`; `tsx` was not a dependency. I tried the no-new-dependency option first — `node --experimental-strip-types bench/measure.ts` (Node v26.2.0, confirmed the flag itself works with a trivial script) — and it failed:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'.../npm/src/index.js' imported from '.../npm/bench/measure.ts'
```

The project's TS sources use NodeNext-style `.js`-suffixed imports pointing at `.ts` files (`../src/index.js` → `src/index.ts`), which is the standard TS/NodeNext convention but requires a loader that remaps that extension at resolution time. Node's native `--experimental-strip-types` strips types but does not do that remap; `tsx` does. So I added `tsx: "^4.19.0"` to `npm/package.json` devDependencies (resolved to `4.23.5`) and ran `pnpm install`, keeping the brief's literal `pnpm tsx bench/measure.ts` invocation unchanged. This is recorded in the commit body.

Verified `bench/measure.ts` does NOT run under `pnpm test`: `vitest.config.ts`'s `include: ['test/**/*.test.ts']` excludes `bench/` entirely (also confirmed by the full-suite run above showing only the 5 `test/` files).

## Step 4: measurements

Both runs used `PARAMS = { nComponents: 10, nNeighbors: 15, minClusterSize: 5, seed: 42 }`, dims=50, exactly as in the harness.

### Build A — wasm with `RUSTFLAGS="-C target-feature=+simd128"` (via `bash scripts/build-wasm.sh`, unmodified — this is the script's only mode)

Commands:

```bash
cd /mnt/data/Develop/holomap/.worktrees/holomap-clusterer
bash scripts/build-wasm.sh                     # exit 0, wasm/holomap_clusterer_bg.wasm = 261036 bytes
cd npm && pnpm tsx bench/measure.ts | tee /tmp/measure-simd128.txt   # exit 0
```

| backend    | n     | wall    | RSS   |
|------------|-------|---------|-------|
| wasm       | 723   | 3.2 s   | 73 MB |
| subprocess | 723   | 1.5 s   | 78 MB |
| wasm       | 10000 | 57.7 s  | 110 MB |
| subprocess | 10000 | 34.3 s  | 161 MB |

Total wall time for the `tee` invocation: 1:39.75 (`time` builtin).

### Build B — wasm without RUSTFLAGS (manual rebuild bypassing the script, since `build-wasm.sh` hardcodes `+simd128` unconditionally)

Commands (script's cargo/wasm-bindgen steps run manually, RUSTFLAGS confirmed unset in the shell beforehand):

```bash
cd /mnt/data/Develop/holomap/.worktrees/holomap-clusterer
echo "RUSTFLAGS='${RUSTFLAGS:-<unset>}'"          # RUSTFLAGS='<unset>'
cargo build --release --target wasm32-unknown-unknown -p holomap-clusterer --features wasm   # exit 0
wasm-bindgen --target nodejs --out-dir npm/wasm target/wasm32-unknown-unknown/release/holomap_clusterer.wasm   # exit 0
# + regenerate npm/wasm/package.json {"type":"commonjs"} marker, same as the script does
cd npm && pnpm tsx bench/measure.ts | tee /tmp/measure-nosimd.txt   # exit 0
```

Resulting `.wasm` was a genuinely different binary (258697 bytes vs. 261036 bytes for the SIMD build — confirms the flag took effect, not a cached no-op).

| backend    | n     | wall    | RSS   |
|------------|-------|---------|-------|
| wasm       | 723   | 3.6 s   | 73 MB |
| subprocess | 723   | 1.3 s   | 75 MB |
| wasm       | 10000 | 60.1 s  | 112 MB |
| subprocess | 10000 | 32.4 s  | 154 MB |

Total wall time for the `tee` invocation: 1:40.41 (`time` builtin).

### Gate 5 verdict

Both wasm builds finish 10k rows well under the 300 s cutoff (57.7 s and 60.1 s respectively — an 18–20x margin). **No BLOCKED condition.** No extrapolation was needed; both 10k runs ran to completion and both were captured directly from `time`/harness output, not estimated.

### Observation (not a gate concern, recorded honestly rather than asserting a story)

The `+simd128` vs. no-SIMD gap on this run was small and within noise (57.7 s vs. 60.1 s at 10k, ~4% — inside run-to-run jitter on a shared 4-core box also running the rest of the toolchain). I did not re-run repeatedly to denoise this because gate 5 only cares about the 300 s ceiling, which both configurations clear by a wide margin; if a future "should we just use the sidecar" conversation wants a tighter SIMD-gap number, it should re-run both configurations several times back-to-back on a quiet machine rather than trust this single pair.

Subprocess (native) was consistently faster than wasm at 10k (~32–34 s vs. ~58–60 s), consistent with the README's ~26 s native reference (this host is slower/shared, so the higher subprocess numbers here track that, not a regression).

After both measurement runs, I rebuilt the wasm artifact once more via `bash scripts/build-wasm.sh` to leave the repo's `npm/wasm/` in its canonical +simd128 shipped state (the script's only supported mode). `npm/wasm/` and `target/` are both gitignored, so none of the rebuild churn touched git status.

## Step 5: commit

```
git add npm/test/backend-equivalence.test.ts npm/bench/measure.ts npm/package.json npm/pnpm-lock.yaml
git commit -m "test: backend equivalence + measured wall-clock gates ..."
```

Commit SHA: `0b78e95`. `npm/package.json` and `npm/pnpm-lock.yaml` were included beyond the brief's two named files because adding `tsx` (deviation 1) touched them; omitting them would have left the commit's own harness non-runnable for the next person.

Post-commit `git status`: clean.

Final full-suite re-run before writing this report (with the restored +simd128 wasm in place): `pnpm test` → 5 files, 13 tests, all passed, exit 0. `pnpm check-types` → exit 0.

## Anything I was unsure about

- Whether to touch `npm/package.json`/`npm/pnpm-lock.yaml` at all, since the brief's Step 5 `git add` line names only the two new files. I judged that shipping a bench script whose documented invocation can't run without the added devDependency would defeat the point of "record which you used and make it repeatable," so I included the dependency change in the same commit rather than a separate one.
- The brief's `measure.ts` doc-comment literally says `pnpm tsx bench/measure.ts` already (matching what I ended up using) — I updated only the comment's second line to be consistent, no functional code changed from the verbatim brief.
- I did not attempt to quantify the SIMD gap more rigorously (repeated trials, warm-up runs) since gate 5's bar (300 s) was cleared with large margin either way; flagged above so a future reader doesn't over-read the single-pair 4% delta.

---

## Fix round (post-review)

Review came back spec ✅ with one Critical and three Important findings, all against the harness (the equivalence test itself was untouched and still passes verbatim). This section is appended rather than rewriting the above — the original numbers stay visible so the correction is auditable.

### What was found, and fixed

**Critical — wasm's one-time module load was inside the timed n=723 number.** `wasm-clusterer.ts`'s lazy `require()` triggers `npm/wasm/holomap_clusterer.js`'s synchronous `readFileSync` + `WebAssembly.Module` compile + instantiate the first time any `WasmClusterer` runs in the process; Node then caches that module process-wide, so the cost is paid exactly once per process. The original loop order (n=723 before n=10000, wasm before subprocess) meant that one-time cost landed entirely on "wasm n=723" in **both** builds — a fixed cost on the same order as the claimed ~4% simd128 delta, confounding it. Fixed by adding a throwaway `WasmClusterer().cluster()` call on a tiny (`n=10, dims=4`) input, executed once before the timed loop even starts.

**Important — single-shot couldn't support a percent-level claim.** `n=723` now runs 3 times per backend and reports the median, with all three individual times printed alongside it. `n=10000` stays single-shot (repeating it 3x would add several minutes per backend per build) but the output now says `(single-shot)` explicitly, so nobody downstream mistakes it for a denoised figure.

**Important — the RSS column was wrong.** `process.memoryUsage().rss` only ever reflects the harness (parent) process. For `wasm`, compute happens in-process so that's at least a meaningful (if not peak) reading; for `subprocess`, the actual compute happens in a spawned child this process never samples, so the printed "subprocess RSS" described the wrong process's memory entirely, and even the wasm number was a post-completion snapshot, not the "peak" the old docstring claimed. Rather than build the additional instrumentation to sample a child's peak RSS (out of scope for this bench script), the column was dropped entirely, with the docstring explaining why. This is the "drop it" option the review explicitly allowed.

**Important — false claim in the original report that `npm/wasm/` is gitignored.** Checked directly, as asked:

```
git check-ignore -v npm/wasm/holomap_clusterer_bg.wasm
# exit 1 (no output) — NOT ignored

git ls-files npm/wasm/
# npm/wasm/holomap_clusterer.d.ts
# npm/wasm/holomap_clusterer.js
# npm/wasm/holomap_clusterer_bg.wasm
# npm/wasm/holomap_clusterer_bg.wasm.d.ts
# npm/wasm/package.json
```

Confirmed: `npm/wasm/` is git-tracked (landed in the Task 5 commit `aea1c74`), not gitignored — only `/target` is. The original report's clean `git status` after each rebuild was build determinism (the SIMD and non-SIMD rebuilds each reproduced byte-identical output to what was already committed/on disk), not a gitignore safety net. I did not change what is or isn't tracked — that's confirmed as the reviewer's/Rich's call. **Note for the coordinator:** while writing this fix-round, a new commit already landed on this branch from outside this task — `7cea47d "plan: untrack the wasm artifact, make CI its only producer"` — recording Rich's decision (2026-08-05) that `npm/wasm/` should not be committed, with Task 7 slated to `git rm --cached` it, gitignore it, and add a `prepublishOnly` guard. That's independent confirmation of this finding; I made no changes in that direction myself.

### Corrected measurements

Same params as before (`PARAMS = { nComponents: 10, nNeighbors: 15, minClusterSize: 5, seed: 42 }`, dims=50). Both wasm builds reconfirmed byte-for-byte identical to the original run (261036 bytes for +simd128, 258697 bytes for no-RUSTFLAGS) before re-measuring, so this is a like-for-like re-run with only the harness changed.

Commands:

```bash
cd /mnt/data/Develop/holomap/.worktrees/holomap-clusterer
bash scripts/build-wasm.sh                                            # exit 0, +simd128, 261036 bytes (byte-identical to before)
cd npm && pnpm check-types                                             # exit 0
pnpm test                                                              # exit 0, 5 files / 13 tests
time (pnpm tsx bench/measure.ts | tee /tmp/measure-simd128-v2.txt)     # exit 0
```

**Build A — wasm with `+simd128` (corrected harness):**

| backend | n | wall | notes |
|---|---|---|---|
| wasm | 723 | 2.4 s | median of 3: 2.5s, 2.4s, 2.4s |
| subprocess | 723 | 1.3 s | median of 3: 1.2s, 1.3s, 1.3s |
| wasm | 10000 | 53.6 s | single-shot |
| subprocess | 10000 | 30.5 s | single-shot |

Total wall time for the `tee` invocation: 1:38.34.

```bash
cargo build --release --target wasm32-unknown-unknown -p holomap-clusterer --features wasm   # RUSTFLAGS unset, confirmed; exit 0
wasm-bindgen --target nodejs --out-dir npm/wasm target/wasm32-unknown-unknown/release/holomap_clusterer.wasm   # exit 0, 258697 bytes (byte-identical to before)
cd npm && time (pnpm tsx bench/measure.ts | tee /tmp/measure-nosimd-v2.txt)    # exit 0
```

**Build B — wasm without RUSTFLAGS (corrected harness):**

| backend | n | wall | notes |
|---|---|---|---|
| wasm | 723 | 2.4 s | median of 3: 2.4s, 2.4s, 2.4s |
| subprocess | 723 | 1.2 s | median of 3: 1.2s, 1.2s, 1.2s |
| wasm | 10000 | 54.8 s | single-shot |
| subprocess | 10000 | 32.1 s | single-shot |

Total wall time for the `tee` invocation: 1:40.44.

### Gate 5 verdict (unchanged): still PASS

Both corrected 10k wasm figures (53.6 s, 54.8 s) still clear the 300 s cutoff with wide margin (~5.5x). No BLOCKED condition, no extrapolation — both runs completed and both figures are read directly from harness output.

### What the correction actually shows

Once the compile confound is removed, the n=723 SIMD-vs-not gap effectively vanishes (2.4s vs. 2.4s — no detectable difference, consistent across all 3 reps in each build). At n=10000 the gap is ~2.2% (53.6s vs. 54.8s), smaller than the originally reported ~4% and still within plausible single-shot noise on this shared 4-core box — i.e. the corrected numbers point toward *no meaningful auto-vectorisation benefit detected on this workload/host*, not toward a confirmed ~4% one. That's a materially different, and more honest, conclusion than the original report supported. A future "should we just use the sidecar" conversation should treat this as "no measured SIMD win here" rather than "measured a small win," and if that number matters, should re-run n=10000 multiple times on a quiet host rather than trust either single-shot pair.

After the second (no-RUSTFLAGS) run, `npm/wasm/` was rebuilt once more via `bash scripts/build-wasm.sh` to restore the canonical +simd128 artifact — confirmed byte-identical to the version already committed at `aea1c74` (`git diff --stat npm/wasm/` empty after the restore).

### Fix-round commit

```
git add npm/bench/measure.ts
git commit -m "fix: warm the wasm module before timing, drop wrong RSS, add repetition ..."
```

Commit SHA: `1740c9a` (on top of `7cea47d`, the externally-landed plan commit noted above, which itself sits on top of this task's original `0b78e95`).

Final verification after the fix-round commit: `pnpm test` → 5 files, 13 tests, all passed, exit `0`. `pnpm check-types` → exit `0`. `git status` → clean.
