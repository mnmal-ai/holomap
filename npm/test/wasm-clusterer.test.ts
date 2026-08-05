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
