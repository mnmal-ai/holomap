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

  // A crash is a crash even when the child managed to print something first.
  // The shape below is not hypothetical: `hdbscan` 0.12 writes
  // `HDBSCAN_WARNING: min_cluster_size (N) cannot be lower than 2. Set to 2.`
  // to STDOUT and *then* panics (exit 101) when rows < the effective minimum,
  // so stdout is non-empty at the moment of death. The `close` handler used to
  // reject only when stdout was ALSO empty, so this path resolved as success
  // and `JSON.parse` choked on the warning text — a crashed peripheral
  // reported as malformed output, which points whoever debugs it at the
  // protocol instead of at the child. No wrong clusters were ever returned
  // (JSON.parse / response.error / the assignment-count check all still
  // fired); the cost was purely diagnostic. A stub child is used rather than
  // the real binary because `validateClusterInput` now rejects that input
  // pre-spawn on both backends, making the one known trigger unreachable —
  // this guards the shape, not the one trigger that happened to expose it.
  it('rejects a non-zero exit even when the child printed to stdout first', async () => {
    const clusterer = new SubprocessClusterer([
      process.execPath,
      '-e',
      // Reads the request before dying, mirroring the real child's shape.
      // (Not required for correctness — an immediate-exit child rejects
      // cleanly too; the write to the dead stdin pipe does not surface.)
      'process.stdin.once("data", () => {' +
        'process.stdout.write("HDBSCAN_WARNING: min_cluster_size (5) cannot be lower than 2. Set to 2.\\n");' +
        'process.stderr.write("thread panicked at core_distances/serial.rs:78: index out of bounds\\n");' +
        'process.exit(101); });'
    ]);
    await expect(
      clusterer.cluster(blobs(), { nComponents: 0, nNeighbors: 15, minClusterSize: 5, seed: 42 })
    ).rejects.toThrow(/clusterer exited 101.*core_distances/s);
  });

  // POSIX-only by premise, not by convenience: Windows has no signals, and
  // `process.kill()` there ignores the signal argument and terminates the
  // target outright, so the child is reported through `code` and the `signal`
  // branch this asserts on is unreachable. The CI matrix includes
  // windows-latest, so this must be gated rather than left to discover.
  it.skipIf(process.platform === 'win32')('names the signal when the child is killed rather than exiting', async () => {
    const clusterer = new SubprocessClusterer([
      process.execPath,
      '-e',
      'process.stdin.once("data", () => { process.stdout.write("partial\\n"); process.kill(process.pid, "SIGKILL"); });'
    ]);
    await expect(
      clusterer.cluster(blobs(), { nComponents: 0, nNeighbors: 15, minClusterSize: 5, seed: 42 })
    ).rejects.toThrow(/killed by SIGKILL/);
  });
});
