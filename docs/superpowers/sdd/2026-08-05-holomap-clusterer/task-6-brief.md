### Task 6: Backend equivalence and the measured gates

The test that keeps dual-path honest, plus the wall-clock numbers the spec's gate 5 asks for.

**Files:**
- Test: `npm/test/backend-equivalence.test.ts`
- Create: `npm/bench/measure.ts`

**Interfaces:**
- Consumes: `WasmClusterer`, `SubprocessClusterer`, `ClusterParams`.

- [ ] **Step 1: Write the equivalence test**

`npm/test/backend-equivalence.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SubprocessClusterer, WasmClusterer } from '../src/index.js';

const BIN = new URL('../../target/release/holomap-clusterer', import.meta.url).pathname;
const PARAMS = { nComponents: 5, nNeighbors: 15, minClusterSize: 5, seed: 1234 };

function blobs(dims: number): Float32Array[] {
  let state = 42n;
  const next = () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number(state >> 33n) / 0xffffffff - 0.5;
  };
  const out: Float32Array[] = [];
  for (let blob = 0; blob < 3; blob++) {
    for (let i = 0; i < 30; i++) {
      const v = new Float32Array(dims);
      v[blob * 2] = 10.0;
      for (let j = 0; j < dims; j++) v[j] += next() * 0.5;
      out.push(v);
    }
  }
  return out;
}

/**
 * Gate 3. The bar is NOT byte-identity: holomap promises only structural
 * identity cross-platform ("floats may differ at ULP level"), so native-on-
 * Linux and native-on-macOS may already differ, and HDBSCAN is a density
 * algorithm where small coordinate perturbations flip boundary points.
 * Requiring wasm to match native more tightly than native matches itself
 * would be an unfair gate.
 *
 * What must hold is that both backends recover the same STRUCTURE. If this
 * ever fails, the fix is not to loosen it — it is to record the backend in
 * provenance so a switch is observable, and investigate the divergence.
 */
describe('backend equivalence', () => {
  it('both backends recover the same cluster structure', async () => {
    const vectors = blobs(32);
    const wasm = await new WasmClusterer().cluster(vectors, PARAMS);
    const native = await new SubprocessClusterer([BIN]).cluster(vectors, PARAMS);

    const count = (a: readonly number[]) => new Set(a.filter((l) => l >= 0)).size;
    const noise = (a: readonly number[]) => a.filter((l) => l === -1).length;

    expect(count(wasm.assignments)).toBe(count(native.assignments));
    expect(Math.abs(noise(wasm.assignments) - noise(native.assignments))).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd npm && pnpm test backend-equivalence`
Expected: PASS. A failure is a real finding — report the cluster counts and noise from both backends before changing anything.

- [ ] **Step 3: Write the measurement harness**

`npm/bench/measure.ts`:

```ts
/**
 * Gate 5. Wall clock and peak RSS for both backends.
 *
 * Run with the wasm built both ways to quantify the auto-vectorisation gap:
 *   pnpm build:wasm && pnpm tsx bench/measure.ts          # with +simd128
 *   (rebuild without RUSTFLAGS, re-run)                   # without
 *
 * Native reference from holomap's README: ~3 s at 1k x 50-d, ~26 s at 10k.
 * The gate fails only if 10k exceeds 300 s.
 */
import { SubprocessClusterer, WasmClusterer } from '../src/index.js';

const BIN = new URL('../../target/release/holomap-clusterer', import.meta.url).pathname;

function synthetic(n: number, dims: number): Float32Array[] {
  let state = 7n;
  const next = () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number(state >> 33n) / 0xffffffff - 0.5;
  };
  return Array.from({ length: n }, (_, i) => {
    const v = new Float32Array(dims);
    v[i % dims] = 10.0;
    for (let j = 0; j < dims; j++) v[j] += next() * 0.5;
    return v;
  });
}

const PARAMS = { nComponents: 10, nNeighbors: 15, minClusterSize: 5, seed: 42 };

for (const n of [723, 10_000]) {
  const vectors = synthetic(n, 50);
  for (const [name, clusterer] of [
    ['wasm', new WasmClusterer()],
    ['subprocess', new SubprocessClusterer([BIN])]
  ] as const) {
    const t0 = performance.now();
    await clusterer.cluster(vectors, PARAMS);
    const secs = (performance.now() - t0) / 1000;
    const rss = process.memoryUsage().rss / 1024 / 1024;
    console.log(`${name} n=${n} wall=${secs.toFixed(1)}s rss=${rss.toFixed(0)}MB`);
  }
}
```

- [ ] **Step 4: Run the measurements and record them**

```bash
cd npm && pnpm tsx bench/measure.ts | tee /tmp/measure-simd128.txt
```

Then rebuild the wasm **without** `RUSTFLAGS` and re-run into `/tmp/measure-nosimd.txt`. Paste both tables into the PR description. If 10k exceeds 300 s for the wasm backend, gate 5 fails — stop and report rather than proceeding to Task 7.

- [ ] **Step 5: Commit**

```bash
git add npm/test/backend-equivalence.test.ts npm/bench/measure.ts
git commit -m "test: backend equivalence + measured wall-clock gates

Equivalence asserts both backends recover the same STRUCTURE, not byte-identical
labels. holomap promises only structural identity cross-platform, so native-vs-
native may already differ at ULP level and HDBSCAN can flip boundary points on
that — demanding wasm match native more tightly than native matches itself would
be an unfair gate.

measure.ts quantifies the +simd128 auto-vectorisation gap rather than assuming
it. That number is what any future 'should we just use the sidecar' conversation
should be argued from.

Written by [mnmal-ai-claude](https://github.com/mnmal-ai-claude) with [Claude Code](https://claude.com/claude-code)"
```

---

