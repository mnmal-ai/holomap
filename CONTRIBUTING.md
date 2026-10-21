# Contributing

Work happens on a branch and lands on `main` through a pull request. `main` takes no direct pushes or force-pushes, and review threads must be resolved before merge.

## Before you open a PR

    cargo fmt --check
    cargo clippy --workspace --all-targets --all-features -- -D warnings
    cargo test --workspace --all-features

For `npm/`, run `bash scripts/build-wasm.sh`, then `pnpm install && pnpm check-types && pnpm test` inside `npm/`.

## Labels

The `PR hygiene` check requires every ready PR to carry:

| Kind | Rule | Labels |
|---|---|---|
| Area | at least one | the crate the PR touches (`holomap`, or `holomap-clusterer` for the clusterer crate and its npm wrapper), or `repo` for root-level changes |
| Type | exactly one | `feat`, `fix`, `refactor`, `docs`, `test`, `infra` |
| Priority | exactly one | `P0-critical`, `P1-high`, `P2-medium`, `P3-low` |

It also requires an assignee. Status labels (`blocked`, `needs-review`, `ready-to-merge`) are optional.

If you can't set labels or assignees on your PR, leave them: a maintainer will. The check fails until then, and that's expected.

## Releases

Releases publish from `main` through the `publish*.yml` workflows, using trusted publishing behind a protected `release` environment. AGENTS.md lists the commit subject that triggers each one. Don't tag or publish by hand.
