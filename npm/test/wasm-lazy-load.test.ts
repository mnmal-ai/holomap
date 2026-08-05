import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { WasmClusterer } from '../src/index.js';

// The observable is require.cache membership for the wasm glue's resolved
// path — the worker-smoke test proves the module runs correctly inside a
// Worker, but says nothing about *when* it loads, so an eager require at
// module scope would pass it silently. This test is the actual lazy-load
// gate.
//
// Resolved the same way wasm-clusterer.ts resolves it: its own
// require('../wasm/holomap_clusterer.js') runs from npm/src/, one directory
// level under npm/. This test file lives at npm/test/, the same depth under
// npm/, so the identical relative specifier resolves to the exact same
// absolute file — not a path that was never going to be in the cache.
const require = createRequire(import.meta.url);
const wasmGluePath = require.resolve('../wasm/holomap_clusterer.js');

const PARAMS = { nComponents: 0, nNeighbors: 15, minClusterSize: 5, seed: 42 };

// Same shape as wasm-clusterer.test.ts's blobs() — enough rows for
// nNeighbors: 15 not to underflow the pipeline. This test only needs
// cluster() to complete without erroring; cluster *quality* isn't the point.
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

describe('WasmClusterer lazy loading', () => {
  it('does not require the wasm glue until cluster() is called', async () => {
    expect(require.cache[wasmGluePath]).toBeUndefined();

    const clusterer = new WasmClusterer();
    expect(require.cache[wasmGluePath]).toBeUndefined();

    await clusterer.cluster(blobs(), PARAMS);
    expect(require.cache[wasmGluePath]).toBeDefined();
  });
});
