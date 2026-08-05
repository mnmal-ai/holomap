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
