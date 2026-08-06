# Final fix-wave report — pre-publish review, feat/holomap-clusterer

Commit: `ebdefe8` — "fix: pre-publish gate failures from final whole-branch review"
Branch: `feat/holomap-clusterer` (worktree `/mnt/data/Develop/holomap/.worktrees/holomap-clusterer`)

## CRITICAL 1 — npm publish would ship no JS

`npm/package.json`: replaced `prepublishOnly` (fires on publish only, never on
`pnpm pack`) with `"prepack": "pnpm build:wasm && pnpm build"`. `prepack` fires
for both `pnpm pack` and `pnpm publish`, so it's the correct single hook —
kept `prepublishOnly` would just rebuild wasm a second time for no benefit, so
it was dropped rather than kept alongside.

Proof — `rm -rf npm/dist npm/wasm && pnpm pack` (exit 0), tarball listing via `tar -tzf`:

```
package/dist/index.d.ts
package/dist/index.js
package/dist/subprocess-clusterer.d.ts
package/dist/subprocess-clusterer.js
package/dist/types.d.ts
package/dist/types.js
package/dist/wasm-clusterer.d.ts
package/dist/wasm-clusterer.js
package/LICENSE-APACHE
package/LICENSE-MIT
package/package.json
package/wasm/holomap_clusterer_bg.wasm
package/wasm/holomap_clusterer_bg.wasm.d.ts
package/wasm/holomap_clusterer.d.ts
package/wasm/holomap_clusterer.js
package/wasm/package.json
```

Both `dist/*.js` and `wasm/holomap_clusterer_bg.wasm` present. `dist/` and
`npm/wasm/` were rebuilt afterward (gitignored, not committed) to leave the
worktree in its normal working state.

## CRITICAL 2 — polluted holomap crate tarball

Root `Cargo.toml` `include` anchored: `/README.md`, `/LICENSE-APACHE`,
`/LICENSE-MIT` (leading slash = crate-root only). `src/**` / `examples/**`
were already effectively anchored (no nested `src`/`examples` dirs existed
under `npm/node_modules` to collide with) and were left as-is.

`cargo package --list -p holomap` — 22 entries (was 225, including 202 stray
`npm/node_modules/**/README.md` copies):

```
.cargo_vcs_info.json  Cargo.lock  Cargo.toml  Cargo.toml.orig
LICENSE-APACHE  LICENSE-MIT  README.md
examples/bench.rs  examples/reduce_tsv.rs
src/api.rs  src/components.rs  src/curve.rs  src/eigen.rs  src/fixture_parity.rs
src/fuzzy.rs  src/knn.rs  src/lib.rs  src/metric.rs  src/rng.rs  src/sgd.rs
src/smooth_knn.rs  src/sparse.rs  src/spectral.rs
```

## IMPORTANT 3 — no license text ships

Copied `LICENSE-MIT`/`LICENSE-APACHE` (identical content to root) into
`crates/holomap-clusterer/` and `npm/`. The clusterer crate has no `include`
filter so the files were picked up automatically once present; npm's `files`
array needed them added explicitly — pnpm's packer (unlike some npm
license-filename heuristics) does not auto-include LICENSE-* by pattern, so
`"files"` now reads `["dist", "wasm", "LICENSE-MIT", "LICENSE-APACHE"]`.

`cargo package --list -p holomap-clusterer` now includes `LICENSE-APACHE` /
`LICENSE-MIT` (13 entries total, see above). `pnpm pack` tarball (above)
includes `package/LICENSE-APACHE` / `package/LICENSE-MIT`.

## IMPORTANT 5 — publish gate weaker than CI

`.github/workflows/publish.yml`: both `cargo clippy` and `cargo test` now run
with `--workspace`, matching `ci.yml:20,36`. `packages[0]` version-resolution
logic left untouched per instruction.

## IMPORTANT 6 — false 27.2% claim

- `crates/holomap-clusterer/tests/fixture_regression.rs`: doc comment now
  states this crate's own all-Rust result — 36 clusters / **30.0%** noise —
  measured directly by re-running the gated test locally
  (`HOLOMAP_CLUSTERER_FIXTURE=... cargo test -p holomap-clusterer --test
  fixture_regression -- --nocapture` → `clusters=36 noise=30.0%`). The 27.2%
  figure is now explicitly attributed as coming from a different clusterer
  (sklearn's HDBSCAN via `coda/scripts/phase0-clusterer-spike/holomap_gate.py`).
- `src/pipeline.rs` (module doc, min_dist rationale paragraph, and the
  `holomap_reduce` doc comment — the three sites at the original 22/43/145
  line neighborhood): kept the sklearn-attributed 27.2% figures but made the
  attribution to the sklearn-HDBSCAN standalone gate explicit, and added this
  crate's own 36/30.0% figure alongside each. Comments only — no code in
  `pipeline.rs` changed (verified via `git diff`, and `cargo test --workspace`
  passing unchanged).

## IMPORTANT 9 — machine-specific path

`fixture_regression.rs` doc comment reworded: describes the fixture (799-row
TSV export of the Claude corpus, 6 tab-separated columns, col 5 text / col 6
1024-float bge-m3 vector) and the `HOLOMAP_CLUSTERER_FIXTURE` env var
generically; the example invocation now reads
`HOLOMAP_CLUSTERER_FIXTURE=/path/to/2026-06-05-claude-corpus-799.tsv` instead
of the hardcoded `/mnt/data/Develop/coda-fixtures/...` path.

## MINOR — ProtocolResponse leak

`npm/src/index.ts` no longer does `export * from './types.js'`; it now
explicitly re-exports only `ClusterParams`, `ClusterResult`, `Clusterer`
(types) and `ClustererError` (class). `ProtocolResponse` is no longer part of
the public surface. `subprocess-clusterer.ts` already imported
`ProtocolResponse` directly from `./types.js` (not via `index.ts`), so no
internal consumer needed a change. Confirmed no other file in `npm/src`,
`npm/test`, or `npm/bench` references `ProtocolResponse` via the public
export.

## Global invariants — verified untouched

- `min_samples` — still never set in `pipeline.rs` (comment-only edits there).
- `min_dist` — still left at holomap's 0.1 default; not overridden anywhere.
- `hdbscan` dependency — still `default-features = false, features = ["serial"]`
  in `crates/holomap-clusterer/Cargo.toml` (unchanged).

## Gate results (real exit codes)

- `cargo clippy --workspace --all-targets --all-features -- -D warnings` → **0**
- `cargo test --workspace --all-features` (with `HOLOMAP_CLUSTERER_FIXTURE` set
  to the local coda-fixtures copy, so the regression test actually ran) → **0**
- `pnpm test` (npm/) → **0** (13 tests, 5 files passed)
- `pnpm check-types` (npm/) → **0**

## Not touched (deliberately, per scope)

Licensing terms, README content, registry configuration, backend validation
contracts, and the `publish.yml` `packages[0]` version-resolution logic — all
explicitly excluded as the repo owner's decisions.

Nothing was left unfixed from the assigned list.
