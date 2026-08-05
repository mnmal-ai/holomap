import { describe, expect, it } from 'vitest';
import { ClustererError, SubprocessClusterer } from '../src/index.js';

const BIN = new URL('../../target/release/holomap-clusterer', import.meta.url).pathname;

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

describe('SubprocessClusterer', () => {
  it('separates three blobs', async () => {
    const clusterer = new SubprocessClusterer([BIN]);
    const result = await clusterer.cluster(blobs(), {
      nComponents: 0, nNeighbors: 15, minClusterSize: 5, seed: 42
    });
    const labels = new Set(result.assignments.filter((l) => l >= 0));
    expect(labels.size).toBe(3);
  });

  it('throws ClustererError on an empty argv', () => {
    expect(() => new SubprocessClusterer([])).toThrow(ClustererError);
  });

  // Empirically-established boundary (see contracts-report.md fix-round):
  // the `hdbscan` crate clamps any minClusterSize below 2 up to 2, then
  // panics if row count < that effective minimum — reproduced directly
  // against the built binary with `seed: 42` (a valid seed), confirming the
  // crash is triggered by row count vs. minClusterSize, not by the seed.
  // Without a pre-spawn guard this crashes the child process (exit 101,
  // a Rust panic in hdbscan's core-distance computation) instead of
  // raising a ClustererError.
  it('rejects fewer rows than minClusterSize instead of crashing the child', async () => {
    const clusterer = new SubprocessClusterer([BIN]);
    const tooFew = [new Float32Array(8), new Float32Array(8)]; // 2 rows, minClusterSize 5
    await expect(
      clusterer.cluster(tooFew, { nComponents: 0, nNeighbors: 15, minClusterSize: 5, seed: 42 })
    ).rejects.toThrow(/too few rows/);
  });
});
