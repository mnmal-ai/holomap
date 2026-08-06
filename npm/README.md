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

**`WasmClusterer` — the default.** A `.wasm` is an ordinary package asset. No install step, no per-platform binary matrix, no postinstall script, no `node-gyp`. This matters most for the intended consumer: hydra's distribution model is npm-into-a-runtime-dir — plugins are discovered by scanning `node_modules`, releases ship by moving version pins and restarting one systemd unit. A backend requiring an operator to place a platform-correct executable somewhere would break that model.

**`SubprocessClusterer` — the opt-in.** Spawns the native binary and speaks JSON-lines to it. Faster, no row ceiling, and it's the backend that was already in production before any of this — the seam has survived one real backend swap already (`clusterer.py` → the Rust binary), so its pluggability is proven rather than speculative. Take this one if you're happy to manage a per-platform executable and want the speed.

### What the default costs you

Measured, not assumed. Same host, same corpus shape, wasm module warmed before timing; n=723 is a median of three runs, n=10k single-shot:

| Backend | n=723 | n=10,000 |
|---|---|---|
| `WasmClusterer` | 2.4 s | 53.6 s |
| `SubprocessClusterer` | 1.3 s | 30.5 s |

**Choosing wasm costs roughly 1.8×.** At the corpus sizes that actually occur — the reference corpus is 723 rows, and 10k is estimated at about a year of accumulation — that is about a second. That is what a clean install is worth here, and it's why wasm is the default rather than the fallback.

The build passes `-C target-feature=+simd128`. It is kept because it is free, **not** because it was measured to help: with the module warmed, n=723 is identical to three significant figures with and without it, and n=10k differs ~2.2% single-shot. The original argument — that native LLVM auto-vectorises the kNN distance loop and wasm won't — was plausible and did not survive measurement. Don't restate it.

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

## Choosing a backend from config

The package exports both classes and takes no view on how you select one. The pattern the intended consumer uses is a discriminated union, matching how it already configures its embedder:

```jsonc
"clusterer": { "kind": "wasm" }                                        // default
"clusterer": { "kind": "subprocess", "argv": ["/path/to/holomap-clusterer"] }
```

## Install

`@mnmal-ai/*` packages resolve from GitHub Packages, and this one is **restricted** like every other. Route the scope in your `.npmrc`:

```
@mnmal-ai:registry=https://npm.pkg.github.com
```

Supply the auth token from a source pnpm trusts — `~/.npmrc` locally, a CI auth step in workflows. Never put a credential in a committed project `.npmrc`; pnpm ≥11 ignores it there anyway, deliberately.

**Not yet published.** `0.1.0` is unreleased on purpose: freezing a public API before any real integration has exercised it buys nothing. Consume it via `file:`/`link:` from a checkout until a consumer has actually run it in anger.

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
