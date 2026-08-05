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
