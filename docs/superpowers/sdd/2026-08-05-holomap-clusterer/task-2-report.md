# Task 2 Report: Reference-corpus regression gate

## Status: DONE

## What was done

Created `crates/holomap-clusterer/tests/fixture_regression.rs` verbatim per the
brief's Step 1 code block. No deviations from the specified source.

Before writing the test, sanity-checked `crates/holomap-clusterer/src/pipeline.rs`
against the two global constraints:

- `min_dist` — confirmed left at holomap's default (0.1), with an inline comment
  citing the same 36/27.2% vs 13/45.2% regression finding as this task's brief.
- `min_samples` — confirmed intentionally unset (`HdbscanHyperParams::builder()`
  only sets `min_cluster_size`), with an inline comment citing the same
  36-vs-8-clusters regression finding.

Both constraints hold in the current pipeline code — no regression present.

## Commands run and real output

### Fixture integrity check (before writing anything)

```
$ sha256sum /mnt/data/Develop/coda-fixtures/2026-06-05-claude-corpus-799.tsv
d65077b8c3f62fa2a873507cacc8a7afb8f46ad9ad7e7b959bc23591f9620c4b  /mnt/data/Develop/coda-fixtures/2026-06-05-claude-corpus-799.tsv
```

Matches the brief's stated hash exactly.

### Step 2: run unset, verify clean skip

```
$ cd /mnt/data/Develop/holomap/.worktrees/holomap-clusterer
$ unset HOLOMAP_CLUSTERER_FIXTURE
$ cargo test -p holomap-clusterer --test fixture_regression -- --nocapture
```

Output:

```
   Compiling holomap-clusterer v0.1.0 (/mnt/data/Develop/holomap/.worktrees/holomap-clusterer/crates/holomap-clusterer)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 1.50s
     Running tests/fixture_regression.rs (target/debug/deps/fixture_regression-eb77731421ee1a8b)

running 1 test
skipping: HOLOMAP_CLUSTERER_FIXTURE unset
test reference_corpus_reproduces_the_established_result ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

Matches the brief's expectation exactly: PASS, prints the skip message.

### Step 3: run against the real fixture

```
$ HOLOMAP_CLUSTERER_FIXTURE=/mnt/data/Develop/coda-fixtures/2026-06-05-claude-corpus-799.tsv \
    cargo test -p holomap-clusterer --test fixture_regression -- --nocapture
```

Output (full, unedited):

```
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.04s
     Running tests/fixture_regression.rs (target/debug/deps/fixture_regression-eb77731421ee1a8b)

running 1 test
test reference_corpus_reproduces_the_established_result has been running for over 60 seconds
clusters=36 noise=30.0%
test reference_corpus_reproduces_the_established_result ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 83.94s
```

Wall time: 83.94s (test binary), ~84s total including negligible rebuild.

**Measured: clusters=36, noise=30.0%.**

This is inside both gate bands (30–60 clusters; 10–35% noise) and matches the
established reference cluster count (36) exactly. Noise percentage (30.0%) is
close to but not identical to the reference 27.2% — well within the deliberately
wide band the brief calls for, and not a match for either regression signature:

- NOT 13 clusters / ~45% noise (the `min_dist=0.0` regression signature)
- NOT 8 clusters (the `min_samples=n_neighbors` regression signature)

No regression detected. The small delta from 27.2% to 30.0% noise is consistent
with normal variance across dependency/environment (e.g. exact `hdbscan`/holomap
patch versions, floating-point accumulation differences) rather than a
parameter regression — both suspect parameters were independently verified
correct by reading `pipeline.rs` before running the test.

### Step 4: commit

```
$ git add crates/holomap-clusterer/tests/fixture_regression.rs
$ git commit -m "test: reference-corpus regression gate for the clusterer pipeline ..."
```

Commit: `6498b2369fb67a013bb63e56b1ee91de0d3d84d2`

```
$ git log -1 --format="%H %s"
6498b2369fb67a013bb63e56b1ee91de0d3d84d2 test: reference-corpus regression gate for the clusterer pipeline

$ git status
On branch feat/holomap-clusterer
nothing to commit, working tree clean
```

Footer verified present in the commit body exactly as required:
`Written by [mnmal-ai-claude](https://github.com/mnmal-ai-claude) with [Claude Code](https://claude.com/claude-code)`

## Anything I was unsure about

- The measured noise percentage (30.0%) differs from the brief's stated
  reference (27.2%) by 2.8 points. I did not adjust the test's bands to
  accommodate this — the bands were already wide enough to include it
  (10–35%), and the brief explicitly says the band exists so a "dependency
  patch may shift the exact count without breaking the pipeline." I flag it
  here rather than silently treating it as identical, since the task
  instructions asked me to report exact numbers and be suspicious of any
  drift. Given it's nowhere near either known regression signature (45%/13
  clusters or 8 clusters), and the cluster count matches exactly (36), I'm
  treating this as normal variance, not a regression, but wanted it visible
  for review.
- Did not modify anything outside the worktree; did not touch
  `/mnt/data/Develop/holomap` or `/mnt/data/Develop/coda`.
