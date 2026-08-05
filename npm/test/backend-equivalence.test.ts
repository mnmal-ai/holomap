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
