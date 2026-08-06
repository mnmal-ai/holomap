import { describe, expect, it } from 'vitest';
import { type ClusterParams, ClustererError, SubprocessClusterer, WasmClusterer } from '../src/index.js';

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
 * READ THIS BEFORE TIGHTENING IT. An earlier version asserted the two
 * backends produce the SAME cluster count, with a noise delta of at most 2
 * rows. That assertion passed, and it was misleading: this fixture is three
 * well-separated synthetic blobs, which is easy enough that both backends
 * trivially agree. On the real 723-row corpus they do not — measured
 * 2026-08-05, 36 vs 37 clusters on raw input and 33 vs 35 on normalised.
 * The old bar would have failed on real data while passing here, so it was
 * not gating what it claimed to.
 *
 * The underlying reason is that this pipeline is DETERMINISTIC but not
 * numerically STABLE. Perturbations far below any meaningful precision move
 * the result: on that same corpus, merely L2-normalising the input before
 * the call — mathematically a no-op, since the pipeline normalises
 * internally — shifts it by up to 3 clusters, and the shift depends on
 * whether the norm was accumulated in f32 or f64. See
 * `crates/holomap-clusterer/tests/fixture_regression.rs` for the measured
 * table.
 *
 * So this test gates what it CAN gate honestly: on an easy fixture with
 * known planted structure, each backend independently recovers that
 * structure, and neither errors or returns nonsense. That is enough to
 * catch the failure mode that actually threatens the wasm binding — a
 * marshalling or build bug — which produces garbage or a throw, not a
 * one-cluster difference.
 *
 * The cross-backend delta is REPORTED, not asserted. If you want a real
 * agreement bar, it belongs on the real corpus in the Rust suite, expressed
 * as the MVD band, not here.
 */
describe('backend equivalence', () => {
  const count = (a: readonly number[]) => new Set(a.filter((l) => l >= 0)).size;
  const noise = (a: readonly number[]) => a.filter((l) => l === -1).length;

  it('each backend independently recovers the planted structure', async () => {
    const vectors = blobs(32);
    const wasm = await new WasmClusterer().cluster(vectors, PARAMS);
    const native = await new SubprocessClusterer([BIN]).cluster(vectors, PARAMS);

    // The fixture plants 3 blobs of 30. Allow +/-1: HDBSCAN may split or
    // absorb a blob edge, and pinning exactly 3 would be pinning one point
    // of a sensitive function again, just at a different place.
    for (const [name, result] of [
      ['wasm', wasm],
      ['native', native]
    ] as const) {
      expect(result.assignments, `${name}: one label per input row`).toHaveLength(vectors.length);
      expect(count(result.assignments), `${name}: recovers ~3 planted blobs`).toBeGreaterThanOrEqual(2);
      expect(count(result.assignments), `${name}: recovers ~3 planted blobs`).toBeLessThanOrEqual(4);
      expect(noise(result.assignments), `${name}: most rows are not noise`).toBeLessThan(vectors.length / 2);
    }

    // Informational — see the block comment. Not a bar.
    console.log(
      `backend delta: ${Math.abs(count(wasm.assignments) - count(native.assignments))} clusters, ` +
        `${Math.abs(noise(wasm.assignments) - noise(native.assignments))} noise rows`
    );
  });
});

/**
 * A rejection is part of the `Clusterer` contract too: both backends
 * implement the same interface, so a caller must get the same
 * `ClustererError` for the same bad input regardless of which backend is
 * configured. Before the shared validator existed, `SubprocessClusterer`
 * forwarded bad input to the child process and surfaced whatever came back
 * (a serde deserialisation error, or — for a seed above
 * Number.MAX_SAFE_INTEGER — a raw process crash), which is both slower and a
 * different error than `WasmClusterer` raises for the identical input.
 *
 * Each case below asks WasmClusterer what it throws (its behaviour is the
 * fixed reference — this suite must never be the thing that changes it) and
 * asserts SubprocessClusterer throws a `ClustererError` with the exact same
 * message, without ever spawning a process that could fail for a different
 * reason.
 */
async function rejection(
  clusterer: { cluster(v: readonly Float32Array[], p: ClusterParams): Promise<unknown> },
  vectors: readonly Float32Array[],
  params: ClusterParams
): Promise<ClustererError> {
  try {
    await clusterer.cluster(vectors, params);
  } catch (e) {
    if (e instanceof ClustererError) return e;
    throw new Error(`expected a ClustererError, got ${e instanceof Error ? e.constructor.name : String(e)}: ${e}`);
  }
  throw new Error('expected cluster() to reject, but it resolved');
}

describe('backend rejection parity', () => {
  const cases: Array<[name: string, vectors: readonly Float32Array[], params: ClusterParams]> = [
    ['empty input', [], PARAMS],
    ['ragged vector dimensions', [new Float32Array(8), new Float32Array(5)], PARAMS],
    ['seed NaN', [new Float32Array(8)], { ...PARAMS, seed: Number.NaN }],
    ['seed negative', [new Float32Array(8)], { ...PARAMS, seed: -1 }],
    ['seed non-integer', [new Float32Array(8)], { ...PARAMS, seed: 1.5 }],
    ['seed above Number.MAX_SAFE_INTEGER', [new Float32Array(8)], { ...PARAMS, seed: 2 ** 53 }]
  ];

  it.each(cases)('%s: both backends reject with the same message', async (_name, vectors, params) => {
    const wasmError = await rejection(new WasmClusterer(), vectors, params);
    const subprocessError = await rejection(new SubprocessClusterer([BIN]), vectors, params);

    expect(subprocessError.message).toBe(wasmError.message);
  });
});
