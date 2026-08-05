/**
 * Gate 5. Wall clock and peak RSS for both backends.
 *
 * Run with the wasm built both ways to quantify the auto-vectorisation gap:
 *   pnpm build:wasm && node --experimental-strip-types bench/measure.ts   # with +simd128
 *   (rebuild without RUSTFLAGS, re-run)                                  # without
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
