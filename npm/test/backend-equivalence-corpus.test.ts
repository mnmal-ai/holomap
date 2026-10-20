import { describe, expect, it } from 'vitest';
import { SubprocessClusterer, WasmClusterer } from '../src/index.js';
import {
  clusterCount,
  FIXTURE_ROWS,
  fixturePath,
  l2normalize,
  loadFixture,
  noiseCount
} from './fixture.js';

const BIN = new URL('../../target/release/holomap-clusterer', import.meta.url).pathname;
const PARAMS = { nComponents: 10, nNeighbors: 15, minClusterSize: 5, seed: 42 };

/** The MVD's established envelope. */
const CLUSTER_MIN = 30;
const CLUSTER_MAX = 60;
const NOISE_MIN = 10.0;
const NOISE_MAX = 35.0;

/**
 * Backend equivalence on the REAL corpus.
 *
 * This exists because `backend-equivalence.test.ts` cannot do the job its
 * name implies. Its fixture is three well-separated synthetic blobs, which
 * are robust to epsilon-scale perturbation by construction — the observed
 * cross-backend delta there is 0, and would stay 0 even if wasm and native
 * genuinely diverged at ULP level. holomap promises only *structural*
 * identity cross-platform, so they may.
 *
 * The real corpus is where boundary points flip. Measured deltas there are
 * 1-2 clusters between backends, and up to 3 clusters between input regimes
 * that are mathematically identical. That is the regime worth testing in.
 *
 * WHAT THIS ASSERTS: each backend, in each regime, lands inside the MVD band.
 * WHAT IT DOES NOT ASSERT: any bound on the cross-backend delta. That bar was
 * withdrawn for being unachievable in general — requiring wasm to match native
 * more tightly than native matches itself across platforms would be unfair,
 * and pinning an exact count pins one arbitrary point of a sensitive function.
 * The delta is printed instead. If it ever grows startling, that is a signal
 * to investigate, not a test to loosen.
 *
 * Env-gated on HOLOMAP_CLUSTERER_FIXTURE and additionally requires the native
 * binary, since half the comparison is the subprocess backend.
 */
describe('backend equivalence on the reference corpus', () => {
  const path = fixturePath();
  const t = path === undefined ? it.skip : it;

  t(
    'both backends land in the MVD band, in both input regimes',
    async () => {
      const raw = loadFixture(path!);
      expect(raw).toHaveLength(FIXTURE_ROWS);

      const regimes = [
        ['raw', raw],
        ['normalised', l2normalize(raw)]
      ] as const;

      for (const [regime, vectors] of regimes) {
        const wasm = await new WasmClusterer().cluster(vectors, PARAMS);
        const native = await new SubprocessClusterer([BIN]).cluster(vectors, PARAMS);

        for (const [backend, result] of [
          ['wasm', wasm],
          ['native', native]
        ] as const) {
          const clusters = clusterCount(result.assignments);
          const noisePct = (100 * noiseCount(result.assignments)) / result.assignments.length;
          const label = `${regime}/${backend}`;

          console.log(`${label}: ${clusters} clusters, ${noisePct.toFixed(1)}% noise`);

          expect(result.assignments, `${label}: one label per row`).toHaveLength(vectors.length);
          expect(clusters, `${label}: cluster count in band`).toBeGreaterThanOrEqual(CLUSTER_MIN);
          expect(clusters, `${label}: cluster count in band`).toBeLessThanOrEqual(CLUSTER_MAX);
          expect(noisePct, `${label}: noise in band`).toBeGreaterThanOrEqual(NOISE_MIN);
          expect(noisePct, `${label}: noise in band`).toBeLessThanOrEqual(NOISE_MAX);
        }

        // Informational — deliberately not a bar. See the block comment.
        console.log(
          `${regime}: backend delta ${Math.abs(
            clusterCount(wasm.assignments) - clusterCount(native.assignments)
          )} clusters, ${Math.abs(
            noiseCount(wasm.assignments) - noiseCount(native.assignments)
          )} noise rows`
        );
      }
    },
    // Four clusterings of 723x1024 through an O(N^2*d) kNN, two of them in
    // wasm at ~1.8x native. Comfortably over vitest's 5s default.
    300_000
  );
});
