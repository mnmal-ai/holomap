### Task 5: `WasmClusterer`

The bundled backend, plus proof it runs inside a worker thread.

**Files:**
- Create: `npm/src/wasm-clusterer.ts`
- Modify: `npm/src/index.ts`, `npm/package.json`
- Test: `npm/test/wasm-clusterer.test.ts`, `npm/test/worker-smoke.test.ts`

**Interfaces:**
- Consumes: `Clusterer`, `ClusterParams`, `ClusterResult`, `ClustererError` from `./types.js`; the wasm export `reduce_and_cluster` from Task 3.
- Produces: `class WasmClusterer implements Clusterer`.

- [ ] **Step 1: Wire the wasm artifact into the package**

```bash
# wasm-pack is NOT used: wasm-pack 0.15.0 invokes `cargo build --out-dir`
# internally, and cargo 1.95.0 renamed that unstable flag to --artifact-dir,
# so every wasm-pack build fails. Reproduced independently 2026-08-05.
#
# The direct route is also strictly better: wasm-bindgen-cli MUST match the
# wasm-bindgen crate version exactly, and a mismatch fails in confusing ways.
# wasm-pack hid that coupling; here it is explicit and derived from Cargo.lock.
cd /mnt/data/Develop/holomap/.worktrees/holomap-clusterer

WB_VERSION=$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | grep '^version' | cut -d'"' -f2)
echo "matching wasm-bindgen-cli to crate version $WB_VERSION"
cargo install wasm-bindgen-cli --version "$WB_VERSION" --locked

RUSTFLAGS="-C target-feature=+simd128" \
  cargo build --release --target wasm32-unknown-unknown -p holomap-clusterer --features wasm

wasm-bindgen --target nodejs --out-dir npm/wasm \
  target/wasm32-unknown-unknown/release/holomap_clusterer.wasm
ls -la npm/wasm/
```

Expected: `npm/wasm/holomap_clusterer_bg.wasm` (~255 KB), `holomap_clusterer.js`, `holomap_clusterer.d.ts`.

Add to `npm/package.json` scripts (a shell script keeps the version-derivation readable):

```json
"build:wasm": "bash ../scripts/build-wasm.sh"
```

Create `scripts/build-wasm.sh` at the repo root with the command block above (minus the `cd`), `set -euo pipefail` at the top, and `chmod +x`. CI calls the same script, so the build path has exactly one definition.

- [ ] **Step 2: Write the failing test**

`npm/test/wasm-clusterer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ClustererError, WasmClusterer } from '../src/index.js';

function blobs(): Float32Array[] {
  let state = 42n;
  const next = () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number(state >> 33n) / 0xffffffff - 0.5;
  };
  const out: Float32Array[] = [];
  for (let blob = 0; blob < 3; blob++) {
    for (let i = 0; i < 30; i++) {
      const v = new Float32Array(8);
      v[blob * 2] = 10.0;
      for (let j = 0; j < 8; j++) v[j] += next() * 0.5;
      out.push(v);
    }
  }
  return out;
}

const PARAMS = { nComponents: 0, nNeighbors: 15, minClusterSize: 5, seed: 42 };

describe('WasmClusterer', () => {
  it('separates three blobs', async () => {
    const result = await new WasmClusterer().cluster(blobs(), PARAMS);
    expect(new Set(result.assignments.filter((l) => l >= 0)).size).toBe(3);
  });

  it('is deterministic across runs', async () => {
    const c = new WasmClusterer();
    const a = await c.cluster(blobs(), PARAMS);
    const b = await c.cluster(blobs(), PARAMS);
    expect(a.assignments).toEqual(b.assignments);
  });

  it('throws ClustererError on ragged input', async () => {
    const ragged = [new Float32Array(8), new Float32Array(5)];
    await expect(new WasmClusterer().cluster(ragged, PARAMS)).rejects.toThrow(ClustererError);
  });

  it.each([Number.NaN, -1, 1.5, 2 ** 53])('rejects seed %p rather than coercing it', async (seed) => {
    await expect(
      new WasmClusterer().cluster(blobs(), { ...PARAMS, seed })
    ).rejects.toThrow(/seed must be/);
  });

  it('throws ClustererError above MAX_ROWS', async () => {
    const many = Array.from({ length: 50_001 }, () => new Float32Array(2));
    await expect(new WasmClusterer().cluster(many, PARAMS)).rejects.toThrow(/MAX_ROWS/);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd npm && pnpm test wasm-clusterer`
Expected: FAIL — `WasmClusterer` is not exported.

- [ ] **Step 4: Implement**

`npm/src/wasm-clusterer.ts`:

```ts
import { createRequire } from 'node:module';
import {
  type ClusterParams,
  type ClusterResult,
  ClustererError,
  type Clusterer
} from './types.js';

// wasm-pack --target nodejs emits CJS glue. createRequire loads it from an
// ESM module without a bundler step, and resolves the .wasm relative to the
// package's own directory so consumers never handle asset paths.
const require = createRequire(import.meta.url);

interface WasmModule {
  reduce_and_cluster(
    vectors: Float32Array,
    nFeatures: number,
    nComponents: number,
    nNeighbors: number,
    minClusterSize: number,
    seed: number
  ): Int32Array;
}

/**
 * Bundled wasm backend — the default.
 *
 * The module is loaded lazily on first use, never at import time, so this
 * file can be imported inside a worker_threads Worker without side effects.
 * Consumers SHOULD run it in a worker: the batch is CPU-bound for tens of
 * seconds and would otherwise block the event loop.
 */
export class WasmClusterer implements Clusterer {
  #module: WasmModule | undefined;

  #load(): WasmModule {
    this.#module ??= require('../wasm/holomap_clusterer.js') as WasmModule;
    return this.#module;
  }

  async cluster(
    vectors: readonly Float32Array[],
    params: ClusterParams
  ): Promise<ClusterResult> {
    if (vectors.length === 0) throw new ClustererError('empty input');

    const nFeatures = vectors[0]!.length;
    if (vectors.some((v) => v.length !== nFeatures)) {
      throw new ClustererError('vector dimensions inconsistent');
    }

    // The Rust binding takes seed as f64 and casts to u64. That cast
    // saturates: NaN and negatives silently become 0, and anything above
    // 2^53 has already lost precision as a JS number. A seed that quietly
    // becomes a different seed is the worst failure this API can have —
    // determinism is the whole product — so reject rather than coerce.
    if (!Number.isInteger(params.seed) || params.seed < 0 || params.seed > Number.MAX_SAFE_INTEGER) {
      throw new ClustererError(
        `seed must be a non-negative integer <= 2^53-1, got ${params.seed}`
      );
    }

    // Flatten to row-major. One copy — negligible beside an O(N^2*d) kNN,
    // and it keeps the production Clusterer signature unchanged.
    const flat = new Float32Array(vectors.length * nFeatures);
    for (let i = 0; i < vectors.length; i++) flat.set(vectors[i]!, i * nFeatures);

    let assignments: Int32Array;
    try {
      assignments = this.#load().reduce_and_cluster(
        flat,
        nFeatures,
        params.nComponents,
        params.nNeighbors,
        params.minClusterSize,
        params.seed
      );
    } catch (e) {
      throw new ClustererError(e instanceof Error ? e.message : String(e));
    }

    if (assignments.length !== vectors.length) {
      throw new ClustererError(
        `assignment count ${assignments.length} != input count ${vectors.length}`
      );
    }
    return { assignments: Array.from(assignments) };
  }
}
```

Update `npm/src/index.ts` to add `export { WasmClusterer } from './wasm-clusterer.js';`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd npm && pnpm test wasm-clusterer`
Expected: PASS, 4 tests.

- [ ] **Step 6: Write the worker smoke test**

`npm/test/worker-smoke.test.ts`:

```ts
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

const WORKER = `
import { parentPort } from 'node:worker_threads';
import { WasmClusterer } from '${new URL('../src/index.ts', import.meta.url).pathname}';
const vectors = [];
for (let blob = 0; blob < 3; blob++)
  for (let i = 0; i < 30; i++) {
    const v = new Float32Array(8);
    v[blob * 2] = 10.0;
    v[7] = i * 0.01;
    vectors.push(v);
  }
const r = await new WasmClusterer().cluster(vectors,
  { nComponents: 0, nNeighbors: 15, minClusterSize: 5, seed: 42 });
parentPort.postMessage(r.assignments);
`;

describe('worker_threads', () => {
  it('loads and runs inside a Worker with no top-level side effects', async () => {
    const assignments = await new Promise<number[]>((resolve, reject) => {
      const w = new Worker(WORKER, { eval: true, execArgv: ['--experimental-strip-types'] });
      w.on('message', resolve);
      w.on('error', reject);
    });
    expect(new Set(assignments.filter((l) => l >= 0)).size).toBe(3);
  });
});
```

- [ ] **Step 7: Run it**

Run: `cd npm && pnpm test worker-smoke`
Expected: PASS. A failure here means the module has import-time side effects — fix `wasm-clusterer.ts` to defer loading, do not relax the test.

- [ ] **Step 8: Commit**

```bash
git add npm
git commit -m "feat: WasmClusterer — the bundled default backend

Lazy module load, never at import time, so the file can be imported inside a
worker_threads Worker. The worker smoke test is the gate on that: consumers
should run this in a worker because the batch is CPU-bound for tens of seconds
and would otherwise block an event loop serving live traffic.

Flattens to row-major inside the backend rather than changing the production
Clusterer signature — one copy, negligible beside an O(N^2*d) kNN.

Written by [mnmal-ai-claude](https://github.com/mnmal-ai-claude) with [Claude Code](https://claude.com/claude-code)"
```

---

