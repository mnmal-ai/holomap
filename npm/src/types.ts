export interface ClusterParams {
  /** 0 = skip reduction (protocol convention). */
  nComponents: number;
  nNeighbors: number;
  minClusterSize: number;
  seed: number;
}

export interface ClusterResult {
  /** Label per input vector; -1 = noise (HDBSCAN convention). */
  assignments: readonly number[];
  /**
   * Never populated by either backend: hdbscan 0.12's .cluster() returns
   * labels only. Present for protocol forward-compatibility.
   */
  probabilities?: readonly number[];
}

export interface Clusterer {
  cluster(vectors: readonly Float32Array[], params: ClusterParams): Promise<ClusterResult>;
}

/**
 * `WasmClusterer` rejects more than 50,000 input rows (`MAX_ROWS` in
 * `crates/holomap-clusterer/src/wasm.rs`) with a `ClustererError` naming
 * `MAX_ROWS` in the message. This is deliberately **wasm-only** and is not
 * mirrored by the shared validator, so `SubprocessClusterer` has no row
 * ceiling at all.
 *
 * Why the limit exists for wasm: the exact O(N^2*d) kNN runs synchronously
 * inside the wasm call, on whatever thread invoked it. Consumers are
 * expected to run `WasmClusterer` inside a `worker_threads` Worker (see
 * `WasmClusterer`'s doc comment) precisely because a large batch blocks that
 * thread for tens of seconds — the ceiling exists to fail fast rather than
 * let a caller accidentally hang a worker for an unbounded amount of time.
 *
 * Why it does not apply to the subprocess backend: `SubprocessClusterer`
 * already runs the same O(N^2*d) algorithm in a separate OS process, not on
 * any thread of the calling Node process. A slow run there costs wall-clock
 * time, not a blocked worker — the specific hazard `MAX_ROWS` exists to
 * prevent doesn't apply. Imposing the wasm ceiling on the subprocess backend
 * anyway would reject inputs the subprocess backend can actually handle, for
 * a reason that has nothing to do with subprocesses.
 *
 * If you need a row ceiling on `SubprocessClusterer` (e.g. to bound wall-clock
 * cost rather than thread-blocking), that is a distinct policy decision for
 * the caller to make — it is not implied by, or copied from, this constant.
 *
 * This value is kept in sync with `wasm.rs::MAX_ROWS` by hand — it is not
 * read from the wasm binary. `test/wasm-clusterer.test.ts` generates
 * `WASM_MAX_ROWS + 1` rows and asserts the wasm call itself rejects them, so
 * a drift between the two shows up as a test failure rather than a silently
 * wrong number here.
 */
export const WASM_MAX_ROWS = 50_000;

export class ClustererError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ClustererError';
  }
}

export interface ProtocolResponse {
  protocol_version: number;
  assignments: number[];
  probabilities?: number[];
  error?: string;
}
