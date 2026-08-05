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
 * `WASM_MAX_ROWS + 1` rows and asserts the wasm call itself rejects them.
 * That only catches drift in ONE direction: it fails if this constant is
 * (or becomes) too LOW relative to the real Rust limit — the test would
 * generate a row count the real binary happily accepts, and the
 * `.rejects` assertion would fail. It does NOT catch this constant being
 * too HIGH relative to the real limit (e.g. if `wasm.rs::MAX_ROWS` is ever
 * lowered and this constant isn't updated to match): `wasm.rs` checks
 * `n_rows > MAX_ROWS`, so `WASM_MAX_ROWS + 1` rows still exceeds a lower
 * real threshold too, wasm still rejects, and the test still passes —
 * silently masking the drift. Trust this constant no further than that: an
 * upper bound believed accurate, not one verified in both directions.
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
