# Task 7 report: CI extension + wasm untracking

Branch: `feat/holomap-clusterer`, worktree
`/mnt/data/Develop/holomap/.worktrees/holomap-clusterer`. Commit: `772547b`
("ci: cover the workspace, the wasm build and the npm suite"). Local commit
only — not pushed, no PR opened, `gh run watch` not run, per instructions.

## Step 0: untrack npm/wasm/

```
git rm --cached -r npm/wasm/
```

then appended to `.gitignore`:

```
# wasm build output — produced by scripts/build-wasm.sh, never committed
npm/wasm/
```

**Verification (not assumed):**

- `git ls-files npm/wasm/` → empty output, exit 0.
- `git check-ignore -v npm/wasm/holomap_clusterer_bg.wasm` →
  `.gitignore:15:npm/wasm/	npm/wasm/holomap_clusterer_bg.wasm` (match).
- `ls -la npm/wasm/` after the `git rm --cached` → all 5 files still present
  on disk (261 KB `.wasm` + `.d.ts` files + `package.json`), confirming
  `--cached` did not delete anything.

## Step 1: package.json guards

Added to `npm/package.json` scripts, verbatim from the brief:

```json
"prepublishOnly": "bash ../scripts/build-wasm.sh",
"pretest": "test -f wasm/holomap_clusterer.js || { echo 'wasm artifact missing — run: pnpm build:wasm'; exit 1; }",
```

Path is `wasm/holomap_clusterer.js` (not `npm/wasm/...`) since scripts run
with cwd = `npm/`, per ambiguity #2.

**Ambiguity #3 resolution:** plain `"pretest"` worked with no fighting
needed. pnpm 11.18.0 runs npm's standard `pre`/`post` lifecycle hooks for
`test` automatically (no `enable-pre-post-scripts` config was needed, no
recursion observed) — confirmed empirically below. Kept the brief's
`pretest` key as-is; did not need the separate-script fallback.

**Guard verification — watched, not assumed:**

Green path (artifact present), from `npm/`:

```
$ pnpm test
$ test -f wasm/holomap_clusterer.js || { echo 'wasm artifact missing — run: pnpm build:wasm'; exit 1; }
$ vitest run
 ✓ test/wasm-clusterer.test.ts (8 tests) 68ms
 ✓ test/worker-smoke.test.ts (1 test) 172ms
 ✓ test/subprocess-clusterer.test.ts (2 tests) 16ms
 ✓ test/wasm-lazy-load.test.ts (1 test) 17ms
 ✓ test/backend-equivalence.test.ts (1 test) 570ms
 Test Files  5 passed (5)
      Tests  13 passed (13)
```

(All 13 tests across 5 files pass — the native `holomap-clusterer` release
binary was already built in this worktree's `target/release/`, so the
subprocess/equivalence tests ran for real, not skipped.)

Red path — moved the artifact aside, ran again, restored it:

```
$ mv wasm /tmp/wasm-bak && pnpm test
$ test -f wasm/holomap_clusterer.js || { echo 'wasm artifact missing — run: pnpm build:wasm'; exit 1; }
wasm artifact missing — run: pnpm build:wasm
[ELIFECYCLE] Command failed with exit code 1.
EXIT CODE: 1
$ mv /tmp/wasm-bak wasm   # restored, ls confirms all 5 files back
```

Guard fires before `vitest run` is ever invoked, prints the fix-it message,
and pnpm surfaces a non-zero exit. Confirmed with `echo "EXIT CODE: $?"`.

## Step 1 (second, CI): workflow changes

`.github/workflows/ci.yml`:

- `lint` job: `cargo clippy --all-targets --all-features` →
  `cargo clippy --workspace --all-targets --all-features`.
- `test` job: `cargo test --all-features` → `cargo test --workspace --all-features`.
- `determinism` job: left untouched (brief only names `lint` and `test`).
- Appended the `wasm` job verbatim from the brief: builds wasm via
  `scripts/build-wasm.sh` on the `wasm32-unknown-unknown` target, then
  builds the native release binary (`cargo build --release -p
  holomap-clusterer`) so the subprocess/equivalence tests aren't silently
  skipped, then `pnpm install --frozen-lockfile && pnpm check-types && pnpm test`
  in `npm/`. All actions kept SHA-pinned per the existing convention — no
  new floating tags introduced.

## Workflow validation

- **Parsed with a real YAML parser** (`python3` + `PyYAML`): loads cleanly,
  `jobs` = `['lint', 'test', 'determinism', 'wasm']`, and the `wasm` job's
  structure printed as expected JSON — confirms no indentation/quoting
  breakage from the edit.
- **`actionlint` was NOT preinstalled**, but Docker was available on this
  box, so ran `docker run --rm -v "$(pwd):/repo" -w /repo rhysd/actionlint:latest
  .github/workflows/ci.yml` — pulled the image, ran, **zero findings, exit
  code 0**.
- **What I could NOT verify:** actual GitHub Actions execution. No way to
  run the `wasm`/`test`/`lint`/`determinism` jobs in a real Actions runner
  from here — didn't push, didn't open a PR, didn't run `gh run watch`
  (all explicitly deferred). Also unverified: whether `wasm-bindgen-cli`
  install + `cargo install --locked` succeeds cleanly on a fresh
  `ubuntu-latest` runner (only ran `scripts/build-wasm.sh`'s effects
  locally, where the toolchain and prior `cargo install` cache already
  existed) and whether `pnpm/action-setup` + `actions/setup-node` pin
  versions resolve correctly in Actions' environment (SHAs taken verbatim
  from the brief, not independently re-resolved against GitHub's action
  registry).

## Concerns (superseded — see Fix round below)

- Original text here read "None outstanding." That was wrong: static YAML
  validation cannot catch a compile-time lint failure, and I had not run
  the actual `cargo clippy --workspace ...` gate the CI change now invokes.
  Reviewer ran it and it failed deterministically. See the fix round below
  for the correction and the gate's real output.

---

## Fix round (post-review)

Review came back **spec ❌**, Critical: `lint` job's new `--workspace`
invocation fails on first run. Reviewer's finding was correct and is
addressed below. Commit: `0303de8` ("fix: clippy failures under
--workspace, cache wasm-bindgen-cli in CI"), on top of `772547b`.

### Critical: clippy failure on `--workspace`

Root cause exactly as diagnosed: `crates/holomap-clusterer/src/wasm.rs`'s
`reshape` (line 24) and `reduce_and_cluster` (line 51) contain manual
modulo-based divisibility checks, unconditional (not gated by the `wasm`
feature), so the old root-only `cargo clippy` invocation never linted this
crate — `--workspace` is exactly what surfaces it.

Fix, behaviour-identical, no `allow` added, lint invocation left at full
strength:

```rust
// wasm.rs:24
-        flat.len() % n_features == 0,
+        flat.len().is_multiple_of(n_features),

// wasm.rs:51
-        if vectors.len() % n_features != 0 {
+        if !vectors.len().is_multiple_of(n_features) {
```

Gate re-run, the one I should have run before the original report:

```
$ cargo clippy --workspace --all-targets --all-features -- -D warnings
    Checking holomap-clusterer v0.1.0 (.../crates/holomap-clusterer)
    Checking holomap v0.2.0 (...)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.08s
```

**Exit code: 0.**

Full workspace test suite re-run to confirm the rewrite broke nothing:

```
$ cargo test --workspace --all-features
```

Per-binary results, all `ok`: holomap unit tests 48 passed, determinism
proptest 1 passed, quality_gate 3 passed, holomap-clusterer unit tests 0
(none defined), fixture_regression 1 passed, protocol 8 passed, plus 2
doctests (1 for `holomap`, 0 for `holomap-clusterer`). **61 test functions
+ 2 doctests, 0 failures, exit 0.**

Then rebuilt the native release binary and the wasm artifact against the
fixed source (`cargo build --release -p holomap-clusterer`, then
`bash scripts/build-wasm.sh`) and re-ran the npm suite:

```
$ pnpm test   # in npm/
 ✓ test/wasm-clusterer.test.ts (8 tests)
 ✓ test/worker-smoke.test.ts (1 test)
 ✓ test/subprocess-clusterer.test.ts (2 tests)
 ✓ test/wasm-lazy-load.test.ts (1 test)
 ✓ test/backend-equivalence.test.ts (1 test)
 Test Files  5 passed (5)
      Tests  13 passed (13)
```

**13/13, exit 0** — `is_multiple_of` change confirmed behaviour-identical
end to end, including through the freshly rebuilt wasm binary.

### Important: no cargo cache on the `wasm` job

Added `Swatinem/rust-cache`, SHA-pinned to match the file's existing
convention. Resolved the tag→commit mapping via `gh api`, not guessed:

```
$ gh api repos/Swatinem/rust-cache/tags --jq '.[0] | "\(.name) \(.commit.sha)"'
v2.9.1 c19371144df3bb44fab255c43d04cbc2ab54d1c4
$ gh api repos/Swatinem/rust-cache/git/tags/23869a5bd66c73db3c0ac40331f3206eb23791dc --jq '.object'
{"sha":"c19371144df3bb44fab255c43d04cbc2ab54d1c4","type":"commit", ...}
```

(second call peels the annotated tag object to confirm the commit sha
matches what `/tags` reported). Added to the `wasm` job right after the
toolchain step, before `Build wasm`:

```yaml
      - uses: Swatinem/rust-cache@c19371144df3bb44fab255c43d04cbc2ab54d1c4 # v2.9.1
        with:
          key: wasm-bindgen-cli
```

This caches `~/.cargo` registry/bin + `target/` keyed on the job, so
`cargo install wasm-bindgen-cli --locked` and the wasm32 build both hit
cache on repeat runs instead of compiling from source every time.

### Minor: pnpm version skew

Original report's guard verification ran against local pnpm 11.18.0, but
`ci.yml` pins pnpm v10 via `pnpm/action-setup`, and there is no `.npmrc`
setting pre/post-script behaviour explicitly — a real gap, since "works on
11" isn't evidence for "works on 10."

Closed the gap rather than just noting it: installed pnpm 10 locally
(`npm install pnpm@10 --prefix /tmp/.../pnpm10 --no-save` → resolved
`10.34.5`) and re-ran both paths against the actual `npm/` package with
that binary:

```
$ /tmp/.../pnpm10/node_modules/.bin/pnpm test        # green, artifact present
 Test Files  5 passed (5)
      Tests  13 passed (13)

$ mv wasm /tmp/wasm-bak2 && pnpm test                # red, artifact moved aside
> pretest
> test -f wasm/holomap_clusterer.js || { echo '...'; exit 1; }
wasm artifact missing — run: pnpm build:wasm
 ELIFECYCLE  Command failed with exit code 1.
EXIT CODE: 1
```

One real difference surfaced: pnpm 10's green-path run did not print a
`pretest` header at all in the terminal (pnpm 11's `$ <cmd>` reporter
prints every implicit lifecycle step; pnpm 10's classic `> pkg@ver script`
reporter only announces steps that produce output or fail). To rule out
"pretest silently didn't run" vs. "pretest ran silently," I temporarily
appended `&& touch /tmp/pretest-marker` to the `pretest` script, re-ran
`pnpm test` under pnpm 10 green-path, confirmed `/tmp/pretest-marker` was
created, then reverted `package.json` with `git checkout --` (confirmed
back to the committed state via `git status --short` and a full `cat`).
So: pretest **does** run under pnpm 10, both jobs just differ in whether
they narrate a successful hook — not a functional gap, a reporter-verbosity
difference. No `.npmrc` change needed.

### Verification commands re-run in full (this fix round)

- `cargo clippy --workspace --all-targets --all-features -- -D warnings` → exit 0
- `cargo test --workspace --all-features` → 61 tests + 2 doctests, 0 failures, exit 0
- `bash scripts/build-wasm.sh` (rebuild wasm artifact against fixed source) → succeeded
- `cargo build --release -p holomap-clusterer` → succeeded
- `pnpm test` in `npm/` (pnpm 11.18.0, green) → 13/13
- `pnpm test` in `npm/` (pnpm 10.34.5, green) → 13/13
- `pnpm test` in `npm/` (pnpm 10.34.5, red — wasm moved aside) → guard fires, exit 1
- `python3`/PyYAML parse of the updated `ci.yml` → OK
- `docker run rhysd/actionlint:latest .github/workflows/ci.yml` (re-run after the cache-step edit) → zero findings, exit 0

### Process note taken on board

Static validation (YAML parse, actionlint) checks structure, not semantics
— it was never going to catch a compile-time clippy failure, and treating
it as if it had was the actual mistake, not just an omission. When a gate
is this cheap (`cargo clippy` took ~1s once warm) and this decisive, run
it before writing "Concerns: None."
