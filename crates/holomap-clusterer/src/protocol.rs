use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
pub struct Params {
    /// Output dimensionality of the reduction stage. 0 = skip reduction
    /// (cluster the input vectors directly — used for low-d inputs/tests).
    pub n_components: usize,
    pub n_neighbors: usize,
    pub min_cluster_size: usize,
    /// Seed for every stochastic component. Same input + same seed must
    /// produce byte-identical output (the determinism contract).
    pub seed: u64,
}

#[derive(Debug, Deserialize)]
pub struct Request {
    pub protocol_version: u32,
    pub vectors: Vec<Vec<f32>>,
    pub params: Params,
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub protocol_version: u32,
    /// Cluster label per input vector; -1 = noise (HDBSCAN convention).
    pub assignments: Vec<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probabilities: Option<Vec<f32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
