import { type ClusterParams, ClustererError } from './types.js';

/**
 * Input validation shared by every `Clusterer` backend.
 *
 * Lives in its own module rather than inside either backend so neither one
 * imports the other to get it, and so a third backend picks it up the same
 * way. `WasmClusterer` and `SubprocessClusterer` both call this before doing
 * any backend-specific work — the wasm binding rejects this input on its own
 * (these checks mirror it so the message doesn't depend on which backend
 * ran), and the subprocess's child process has no opportunity to reject it
 * differently, or at all.
 */
export function validateClusterInput(vectors: readonly Float32Array[], params: ClusterParams): void {
  if (vectors.length === 0) throw new ClustererError('empty input');

  const nFeatures = vectors[0]!.length;
  if (vectors.some((v) => v.length !== nFeatures)) {
    throw new ClustererError('vector dimensions inconsistent');
  }

  // Every backend eventually turns this into a fixed-width integer (the wasm
  // binding casts to u64 in Rust; the subprocess protocol deserialises into
  // a u64 field). That cast/deserialisation saturates or fails in ways that
  // differ by backend — NaN and negatives silently become 0 for wasm, and
  // the subprocess just returns a generic deserialisation error — and
  // anything above 2^53 has already lost precision as a JS number. A seed
  // that quietly becomes a different seed is the worst failure this API can
  // have — determinism is the whole product — so reject rather than coerce,
  // identically on both backends.
  if (!Number.isInteger(params.seed) || params.seed < 0 || params.seed > Number.MAX_SAFE_INTEGER) {
    throw new ClustererError(`seed must be a non-negative integer <= 2^53-1, got ${params.seed}`);
  }

  // The `hdbscan` crate (both backends run the same crate — wasm in-process,
  // subprocess out-of-process) silently clamps any minClusterSize below 2 up
  // to 2 (its own internal floor), then panics — an out-of-bounds index in
  // its core-distance computation — if row count is below that *effective*
  // minimum. Empirically confirmed by direct experiment against the built
  // binary: the boundary is exactly `rows < max(minClusterSize, 2)`,
  // identical whether nComponents is 0 (cluster the raw vectors) or > 0
  // (cluster after a holomap reduction) — the reduction stage runs before
  // HDBSCAN either way and doesn't change row count. Below the boundary,
  // wasm surfaces an opaque JS "unreachable" trap and the subprocess crashes
  // the child process outright (exit 101); this rejects cleanly instead, on
  // both backends, before either one is invoked.
  const effectiveMinClusterSize = Math.max(params.minClusterSize, 2);
  if (vectors.length < effectiveMinClusterSize) {
    throw new ClustererError(
      `too few rows: got ${vectors.length}, need at least ${effectiveMinClusterSize} for minClusterSize ${params.minClusterSize}`
    );
  }
}
