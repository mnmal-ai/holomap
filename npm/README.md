# @mnmal-ai/holomap-clusterer

**Deterministic reduce→cluster for Node.** One `Clusterer` interface, two backends: a bundled WebAssembly build (default) and a subprocess adapter onto a native binary.

```ts
import { WasmClusterer } from '@mnmal-ai/holomap-clusterer';

const result = await new WasmClusterer().cluster(vectors, {
  nComponents: 10,      // 0 = skip reduction, cluster the input directly
  nNeighbors: 15,
  minClusterSize: 5,
  seed: 42              // required — there is no unseeded path
});
// result.assignments: one label per input row; -1 = noise.
```

The pipeline underneath is [`holomap-clusterer`](../crates/holomap-clusterer): [`holomap`](https://crates.io/crates/holomap) UMAP → HDBSCAN, all Rust. That crate's README covers the algorithm choices and the three parameter values that are load-bearing. This one covers the packaging decisions — which are, roughly, the whole product from a JS consumer's point of view.

## Why this is a package at all

The reduce→cluster pipeline started as a Python sidecar around `umap-learn` + `sklearn`, and worked. The reason it isn't one any more is distribution: it made every consumer install and pin a Python environment alongside their Node one. Two runtimes, two dependency managers, two things to get wrong on a new machine — paid forever, by everyone, so that one batch job could run.

Rewriting it in Rust removed the Python. Shipping the Rust as wasm removed the *binary* too. `pnpm add` and it works, on every platform Node runs on.

## Why two backends

Because they buy genuinely different things, and neither one dominates.

**`WasmClusterer` — the default, and the reproducible one.** A `.wasm` is an ordinary package asset. No install step, no per-platform binary matrix, no postinstall script, no `node-gyp`. This matters most for the intended consumer: hydra's distribution model is npm-into-a-runtime-dir — plugins are discovered by scanning `node_modules`, releases ship by moving version pins and restarting one systemd unit. A backend requiring an operator to place a platform-correct executable somewhere would break that model.

It also produces **identical clusterings on different machines**, which the native backend does not. That was discovered rather than designed — see [Reproducibility across machines](#reproducibility-across-machines-the-backends-differ) — and for a workload that carries identity it may matter more than the distribution argument.

**`SubprocessClusterer` — the opt-in.** Spawns the native binary and speaks JSON-lines to it. Faster, no row ceiling, and it's the backend that was already in production before any of this — the seam has survived one real backend swap already (`clusterer.py` → the Rust binary), so its pluggability is proven rather than speculative.

Take this one if you're happy to manage a per-platform executable, want the speed, and **do not need results to match across machines**. That last condition is not a formality; it is measured, and it is the reason to think twice.

### What the default costs you

Measured on a quiet host: Intel i7-6820HQ (Skylake, AVX2 + FMA), 8 threads, load average 0.33 before and 0.90 after, one idle kiwix container present. wasm module warmed before timing; n=723 is a median of three runs, n=10k single-shot.

| Backend | n=723 | n=10,000 |
|---|---|---|
| `WasmClusterer` | 2.2 s | 47.1 s |
| `SubprocessClusterer` | 0.9 s | 25.5 s |
| **wasm costs** | **2.4×** | **1.9×** |

At the corpus sizes that actually occur — the reference corpus is 723 rows, and 10k is roughly a year of accumulation — that is about **1.3 seconds**. That is what a clean install and cross-machine reproducibility are worth here.

Two things worth knowing about these numbers rather than taking them flat:

- **The ratio is hardware-dependent.** On an older pre-AVX2 host (i5-3470S, Ivy Bridge) the same measurement gave ~1.8× at n=723. Native gains from AVX2 and FMA on the O(N²·d) kNN kernel; wasm's `simd128` is 128-bit with no FMA and cannot. Expect the gap to widen, not narrow, on newer hardware.
- **The n=10k figure is a single shot, and the harness runs wasm before subprocess.** On a 45 W mobile part, sustained load provokes package-power throttling, so the second arm ran on a hotter chassis. If that happened it penalised *subprocess*, meaning the true ratio may be higher than 1.9×. Interleaving would settle it; this run did not.

### `+simd128`: not measured, rather than measured as noise

The build passes `-C target-feature=+simd128`, and it is kept because it is free.

The original argument for it was that native LLVM auto-vectorises the kNN distance loop and wasm will not without the flag. That was once described here as having "not survived measurement" — on the basis that n=723 was identical to three significant figures with and without it, and n=10k differed ~2.2%.

**That retraction was overstated, in two separate ways.** Those runs were taken under heavy concurrent load, where a 2.2% delta establishes nothing in either direction. And the test hardware could not have shown the effect at all: the i5-3470S predates AVX2 and has no FMA, while wasm's `simd128` is 128-bit — so the widest gap the argument predicts was not available to be observed.

So the honest position is **not measured**, not *measured and found absent*. The flag itself still has not been A/B-tested on AVX2 hardware. What *has* been measured there is the backend ratio widening at n=723, which is the direction the original argument predicted.

## Reproducibility across machines: the backends differ

**`WasmClusterer` produces identical output on different machines. `SubprocessClusterer` does not.**

Measured on two hosts with the same commit, the same `rustc` 1.97.1, a byte-identical `Cargo.lock`, and the same corpus verified by sha256 after transfer. Only the CPU differs:

| Input regime | Backend | i5-3470S (Ivy Bridge) | i7-6820HQ (Skylake) | |
|---|---|---|---|---|
| raw | **wasm** | 37 / 29.6% | 37 / 29.6% | identical |
| raw | **native** | 36 / 30.0% | 36 / 31.4% | **differs** |
| normalised | **wasm** | 36 / 27.0% | 36 / 27.0% | identical |
| normalised | **native** | 34 / 27.2% | 33 / 27.7% | **differs** |

The Ivy Bridge baseline was re-run as a control immediately afterwards and was unchanged, so this is reproducible rather than drift. Every figure remains inside the consumer's 30–60 cluster / 10–35% noise envelope — the bands hold; the exact values do not.

**Why wasm is stable is a specification property, not luck.** WebAssembly's floating-point arithmetic is IEEE-754 correctly-rounded and deterministic by design, there is no runtime CPU-feature detection, and the MVP has no fused multiply-add — so there is no contraction for a compiler to apply differently on different hardware. A given `.wasm` computes the same answer everywhere.

Native has no such guarantee. What the divergence is *not*: compile-time instruction selection. Rebuilding on the Skylake host with `-C target-cpu=ivybridge` — 42 crates recompiled, verified — still produced the Skylake numbers. That plus wasm's invariance is consistent with **runtime CPU-feature dispatch** somewhere in the native dependency stack. `matrixmultiply`, reached via `nalgebra`, does exactly that and is the obvious suspect — but it is a suspect, not a conclusion, and this document will not assert it until it is confirmed.

### What to do about it

- **If you persist clusterings, record the host alongside the backend.** `{ backend, version, seed, params }` was already the recommended provenance tuple; CPU identity belongs in it too. A stored clustering compared against a fresh one computed elsewhere is comparing two different functions.
- **If cluster identity has to survive a host migration, use wasm.** This is the case where the ~2× is worth paying, and it is not a preference — the alternative does not have the property.
- **Do not switch to native purely for speed without checking this first.** The performance win is real and visible; the reproducibility cost is invisible at the moment you make the decision, and shows up on a machine you have not bought yet.

## Why determinism is the point

`seed` is a required field on `ClusterParams`, and the validator rejects a seed it cannot pass through faithfully — non-integer, negative, or above `2^53-1` — rather than coercing it. A seed that quietly becomes a *different* seed is the worst failure this API can have.

What the contract buys a consumer:

- **A clustering you can regression-test.** "Did my change move the output?" is answerable.
- **A quality change you can bisect.** The baseline doesn't move under you.
- **Eval harnesses that don't flake.** Cluster counts and neighbourhood metrics stop drifting between runs.
- **A stored result you can reproduce.** `{ backend, version, seed, params }` is enough to replay it.

Both backends run the identical Rust pipeline — one in-process, one out — so the contract is the same on either.

### What determinism does *not* give you

It is a guarantee about identical input, not similar input. This pipeline is deterministic but **not numerically stable**: HDBSCAN is a density algorithm, so a perturbation far below any meaningful precision moves points across cluster boundaries.

Concretely — on a 723-row reference corpus, L2-normalising the vectors before calling `cluster()` shifts the result by up to 3 clusters and 20 noise rows, *and the shift depends on whether you accumulated the norm in f32 or f64*. Normalising first is mathematically a no-op; the pipeline normalises internally anyway. Only the rounding differs.

So: pin your preprocessing as carefully as you pin your seed. A refactor that changes where you normalise, or a library that accumulates differently, will move your clustering even though nothing about the algorithm changed. And if you compare against a published figure, check which input regime produced it — a consumer normalising at its boundary is not in the same regime as this project's raw-input baseline, and the gap is not a defect. The measured table is in `crates/holomap-clusterer/README.md`.

## Backend identity is provenance, not a footnote

**If you persist cluster results, record which backend and version produced them.**

The two backends will not necessarily agree byte-for-byte, and that isn't a defect to engineer away. `holomap` promises only *structural* identity cross-platform — floats may differ at ULP level — so native-on-Linux and native-on-macOS may already differ from each other. HDBSCAN is a density algorithm, so small coordinate perturbations can flip boundary points. Demanding wasm match native more tightly than native matches itself would be an unfair gate.

On the real 723-row corpus the two backends differ by 1–2 clusters, measured. So `test/backend-equivalence.test.ts` gates what it honestly can — that each backend independently recovers the planted structure of an easy synthetic fixture without erroring — and *reports* the cross-backend delta rather than asserting a bound on it. That catches the failure mode which actually threatens the binding (a marshalling or build bug produces garbage or a throw, not a one-cluster difference), and it does not pretend to a tightness that real data contradicts.

An earlier version of that test asserted identical cluster counts. It passed, and it was misleading: three well-separated synthetic blobs are easy enough that both backends trivially agree, so the bar would have failed on real data while passing in CI.

The honest mitigation is visibility — a stored clustering that records its backend turns a backend switch into an observable event rather than a silent reprocessing.

Rejections are held to a stricter bar: the same bad input must produce the *same* `ClustererError` message on both backends, verified case by case. A shared validator runs before either backend does any work — so `SubprocessClusterer` rejects bad input without paying for a spawn, and the caller's error handling doesn't depend on which backend is configured.

One class of rejection is subprocess-only, because it has no wasm analogue: the child dying. `SubprocessClusterer` rejects on **any** non-zero exit or terminating signal — `clusterer exited 101: …` or `clusterer killed by SIGKILL: …`, carrying stderr (or stdout, if the child said nothing on stderr). Partial stdout from a failed child is never salvaged, and that is safe rather than merely strict: the child reports every protocol-level error as a normal response on stdout and *still exits 0*, so a non-zero exit only ever means abnormal termination. If you match on error text to distinguish a bad batch from a dead peripheral, `clusterer exited`/`clusterer killed by` is the peripheral.

## Run it in a Worker

```ts
// worker.ts
import { WasmClusterer } from '@mnmal-ai/holomap-clusterer';
```

The wasm module loads lazily on first `cluster()` call, never at import time, so this file has no import-time side effects and is safe to load inside a `worker_threads` Worker. **You should use one.** The batch is CPU-bound for seconds to tens of seconds and runs synchronously on whatever thread invokes it; on your main thread it blocks the event loop for that entire time.

## The row ceiling is wasm-only

`WasmClusterer` rejects more than **50,000 rows** (`WASM_MAX_ROWS`, mirroring `MAX_ROWS` in the Rust binding). `SubprocessClusterer` has no ceiling at all.

That asymmetry is deliberate. The ceiling exists to prevent a *blocked worker thread* — the exact O(N²·d) kNN runs synchronously inside the wasm call, so a large batch hangs that thread for an unbounded time, and failing fast beats discovering it in production. The subprocess backend runs the same algorithm in a separate OS process; a slow run there costs wall-clock, not a blocked thread. The specific hazard doesn't apply, so imposing the limit anyway would reject inputs that backend can genuinely handle, for a reason that has nothing to do with subprocesses.

If you want a ceiling on the subprocess backend to bound wall-clock cost, that's a distinct policy decision for you to make — it isn't implied by this one.

## API

```ts
interface ClusterParams {
  nComponents: number;    // 0 = skip reduction (protocol convention)
  nNeighbors: number;
  minClusterSize: number;
  seed: number;           // non-negative integer <= 2^53-1
}

interface ClusterResult {
  assignments: readonly number[];      // one per input row; -1 = noise
  probabilities?: readonly number[];   // never populated — see below
}

interface Clusterer {
  cluster(vectors: readonly Float32Array[], params: ClusterParams): Promise<ClusterResult>;
}

class WasmClusterer implements Clusterer {}
class SubprocessClusterer implements Clusterer {
  constructor(argv: readonly string[]);   // argv[0] = executable, rest = args
}
class ClustererError extends Error {}
const WASM_MAX_ROWS = 50_000;
```

`probabilities` is **never populated by either backend** — `hdbscan` 0.12's `.cluster()` returns labels only. The field exists for protocol forward-compatibility. Don't build against it.

Input takes `readonly Float32Array[]` rather than one flat buffer. That signature was already in production and is kept unchanged: flattening inside the wasm backend costs a single copy, negligible beside a quadratic kNN, and changing a working consumer's interface for a micro-optimisation is the wrong trade.

## Adopting this package: two things that won't announce themselves

Both were found by the first real consumer during migration. Neither is a defect, and neither shows up as a failure — which is exactly why they're here rather than left to be discovered.

### Your existing tests may go quietly vacuous

A shared validator runs **before either backend does any work**, rejecting empty input, ragged dimensions, seeds it can't pass through faithfully, and row counts below `max(minClusterSize, 2)`.

If you're migrating from a looser clusterer and you have tests that feed degenerate input to assert on downstream behaviour — a child process's stderr, an exit code, a specific parse failure — those assertions now target something that never runs. `SubprocessClusterer` rejects before spawning, so the process under test doesn't exist. **The tests keep passing.** Nothing in the result says the subject became unreachable.

The first consumer had exactly two such tests and the suite stayed green through the whole migration.

There's a cheap general heuristic here, and it isn't specific to this package: **any assertion whose expected delta is exactly `0`, or whose input is degenerate, deserves a deliberate check that the code path still executes.** We produced this failure twice in one day from opposite directions — their tests passed because the input stopped reaching the child; ours passed because the fixture couldn't distinguish the two backends. Same signature, different mechanism, both invisible to CI.

### `SubprocessClusterer` has no out-of-the-box path from the registry

This package ships `dist/` and `wasm/`. It does **not** ship the native binary, and won't.

So a registry-only consumer can use `WasmClusterer` immediately and `SubprocessClusterer` not at all — the latter needs a `holomap-clusterer` binary you build or distribute yourself, and you point its `argv` at that.

That asymmetry is the entire reason wasm is the default. Shipping per-platform native binaries through npm is the distribution problem this package exists to avoid: a platform matrix, a postinstall step, and an artifact that breaks on every runner you didn't anticipate. A consumer that just wants clustering to work should use wasm and never think about this. A consumer that wants native speed is, by definition, already willing to manage a binary.

Recorded so it reads as a decision rather than an omission.

## Choosing a backend from config

The package exports both classes and takes no view on how you select one. The pattern the intended consumer uses is a discriminated union, matching how it already configures its embedder:

```jsonc
"clusterer": { "kind": "wasm" }                                        // default
"clusterer": { "kind": "subprocess", "argv": ["/path/to/holomap-clusterer"] }
```

## Install

`@mnmal-ai/*` packages resolve from GitHub Packages. Route the scope in your `.npmrc`:

```
@mnmal-ai:registry=https://npm.pkg.github.com
```

Supply the auth token from a source pnpm trusts — `~/.npmrc` locally, a CI auth step in workflows. Never put a credential in a committed project `.npmrc`; pnpm ≥11 ignores it there anyway, deliberately.

```sh
pnpm add @mnmal-ai/holomap-clusterer
```

`0.1.0` was deliberately held back until a consumer had exercised the API for real, rather than frozen on the day it was written. coda did that first — the shared validator fitted its call sites unchanged, the re-export shim needed no additions, and both backends were measured against its reference corpus. Only then was it released.

### Cutting a release

`.github/workflows/publish-npm.yml` owns it. Ride a `release/npm-vX.Y.Z` branch, bump the version in `npm/package.json`, and set the merge commit subject to `release: npm vX.Y.Z`. The workflow gates on the full suite, refuses a version already on the registry, publishes, and pushes a `holomap-clusterer-vX.Y.Z` tag. **Do not tag by hand** — the workflow owns the tag.

Two things that are easy to get wrong:

- **The trigger is `release: npm v`, not `release: v`.** The latter belongs to `publish.yml`, which releases the `holomap` *crate* to crates.io. The three artifacts version **independently** — read the current numbers from `Cargo.toml`, `crates/holomap-clusterer/Cargo.toml` and `npm/package.json`, not from prose — so one trigger cannot serve all three. They are mutually exclusive by construction: after `release: `, the next character is `v`, `c` or `n`.
- **The tag is `holomap-clusterer-vX.Y.Z`.** Plain `vX.Y.Z` is the crate's namespace; an npm release tagged that way would collide. `git tag` is the authority on what is taken.

#### Queued for the next release — do this while you are here

Deliberately deferred work that is **not worth cutting a release for on its own**, but costs nothing folded into one that is happening anyway. If you are reading this because you are about to cut a release, do these first.

- [ ] **Add `"./package.json": "./package.json"` to the `exports` map.** Version introspection currently requires `new URL('…/package.json', import.meta.url)` + `readFileSync`, because the map has only ever exposed `"."`. Two of three consumers hit this independently: hydra-recall documented it in `clusterer-version.ts`'s comment and works around it with a hand-maintained constant plus a drift test; coda-claude tripped over it with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Neither *needs* the fix — both have working paths — which is why it is queued rather than shipped.

  For the record, since the reverse claim was made and is wrong: **nothing was ever dropped.** `./package.json` has never been in this map — verified by `git log -S'"./package.json"' -- npm/package.json` returning nothing, and the map reading identically since commit `283df1a`, which created the package. A 0.2.1 "restoring" it would have documented a regression that never happened.

### A note on visibility, corrected by observation

A GitHub Packages npm package inherits **repository** visibility **at publish time**, and `publishConfig.access` — an npmjs concept — does not override it. That much held.

What did *not* hold is the assumption that it tracks the repository afterwards. This repo was private when `0.1.0` was published and went public shortly after; the package **stayed private**, and there is no REST endpoint to change it (`PATCH /orgs/{org}/packages/npm/{name}` returns 404). Package visibility is a one-time inheritance plus a manual setting, not a mirror.

Practically it makes little difference either way: the GitHub Packages npm registry demands an authenticated token for **every** read, public packages included. "Public" there means listed, not installable-by-strangers.

The consequence worth keeping: if you want a package's visibility to differ from what it inherited, that is a deliberate act in the package settings UI — not something a workflow, `publishConfig`, or a later repo change will do for you.

## Building the wasm artifact

`npm/wasm/` is **not** in the repository — it is build output, produced by CI and by `prepack`. To build it locally:

```sh
pnpm build:wasm     # → bash ../scripts/build-wasm.sh
pnpm test
```

`pretest` fails with a fix-it message if the artifact is missing, rather than letting the suite fail obscurely.

Use the script, not `wasm-pack` directly: `wasm-pack` 0.15.0 is broken against cargo 1.95.0 (it calls the removed `cargo build --out-dir`), and the script also derives the `wasm-bindgen-cli` version from `Cargo.lock` — CLI and crate versions must match exactly or the generated glue won't load. It preflights the two things that otherwise fail deep inside cargo with unhelpful messages: an unresolvable `cargo` shim, and a missing `wasm32-unknown-unknown` target. Both cost a first-time consumer real time before the checks existed.

The repo ships a `rust-toolchain.toml` pinning the channel to `stable` and declaring `wasm32-unknown-unknown`, so a fresh checkout gets the target without a separate `rustup target add`. Note it tracks stable rather than a fixed version — deliberately, since CI uses stable and a pin here would silently override it — so it may update your toolchain.

It does **not** help if `cargo` is a mise shim with no version configured: mise doesn't read that file. A `mise.toml` would, and was tried and reverted — on a machine where rustup already provided a working toolchain it made mise take over, fail to install its own copy, and leave `cargo` unusable. The preflight names the fix for that case instead.

### The `.wasm` is not byte-reproducible

Two builds of the same source produce artifacts of identical size that differ by a **single byte** (measured: 1 byte out of 261,037, across two checkouts of the same commit). It is not embedded build paths — those would change the size, and none appear in the binary.

This does not affect behaviour: both artifacts produce identical clusterings, verified by running the suite against each. It is called out only because "determinism is the product" invites the stronger reading. The determinism contract is about the *pipeline's output* for a given input and seed. It has never been a claim about bit-identical build artifacts, and this package does not make one.

If you need to verify you're running the expected build, hash what you ship rather than expecting a rebuild to match it.

## License

MIT OR Apache-2.0, at your option.

The bundled `.wasm` is a combined work: it statically links compiled Rust dependencies, some of which are Apache-2.0 only. See [THIRD-PARTY-LICENSES](./THIRD-PARTY-LICENSES) for the full attribution.
