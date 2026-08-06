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

