# SDD working record — holomap-clusterer (2026-08-05)

The working record behind PR #11 (`feat/holomap-clusterer` → `main`, merged as `cf2ee9b`): the crate moved in from coda, the wasm binding, and `@mnmal-ai/holomap-clusterer`.

Committed here because it was never committed anywhere. All of it lived under `.superpowers/`, which is gitignored — so it existed only as untracked files on one machine, and half of it sat inside a git worktree that would take the files with it when removed.

## Why this was nearly lost, and in two different ways

The record was split across two directories at the *same relative path*:

| Where | What |
|---|---|
| the main checkout | `progress.md` only |
| `.worktrees/holomap-clusterer/` | everything else — briefs, reports, review diffs |

The SDD workspace resolved against the main checkout when the ledger was seeded, but every brief, report and diff was written from inside the worktree. Same relative path, different contents, no indication which root you were looking at.

That cost real time twice on 2026-08-05. A relative pointer to `progress.md`, handed over alongside "work in the worktree", sent a reader to the one root that didn't have it — who then verified its absence there and reported the file as never written. The file was fine; the path was ambiguous.

The two failure modes were different, and both are closed by committing:

- **`progress.md`** survives worktree removal but is untracked — lost on a fresh clone, or any cleanup of `.superpowers/`.
- **Everything else** lives in the worktree. `git worktree remove` deletes it outright, with no warning, because git has no idea it's there.

## What's here

- **`progress.md`** — the per-task ledger. Every finding, every ruling, the parked items, and the decisions Rich made with the reasoning attached. Start here.
- **`task-N-brief.md` / `task-N-report.md`** (7 each) — what each task was asked to do, and what actually happened, including deviations from the brief and the ambiguities resolved along the way.
- **`contracts-report.md`**, **`final-fix-report.md`** — the interface contracts pass, and the whole-branch review that closed the branch out.
- **`review-<base>..<head>.diff`** (13) — the exact diff each review was performed against.

## A note on the diffs

Unlike the prose, the diffs are derived data. Every endpoint sha is reachable from `main` (verified at commit time), so any one of them reconstructs exactly:

```sh
git diff <base>..<head>
```

They are kept anyway, because what matters is *what the reviewer was looking at* — a reconstruction is only equivalent as long as nobody rewrites that history. They are also two-thirds of the bytes here (372K of 568K). If this directory ever becomes a burden, the diffs are the part that can go; the prose is not recoverable from anything.

## Reading it later

This is a working record, not documentation. It is accurate as of 2026-08-05 and is not maintained — where it disagrees with the code, the code wins.

Two things in it are worth knowing before you trust a number:

- **`36 clusters / 27.2% noise` is sklearn's figure**, from coda's `holomap_gate.py`, and it validated the *reduction*. The all-Rust pipeline's own baseline is `36 / 30.0%`. Earlier documents in this record conflate them; commit `0ab179a` is where that was caught and corrected.
- **`36 / 30.0%` is measured on raw, unnormalised corpus floats.** Every TypeScript consumer L2-normalises at the boundary, which yields `33 / 25.4%` — from float32 rounding alone, since the pipeline normalises internally anyway. That finding postdates this record entirely; it came out of coda's integration (cortext AgentMessage #57) and is not reflected in any file here.

The live design documents are `docs/superpowers/specs/` and `docs/superpowers/plans/`.
