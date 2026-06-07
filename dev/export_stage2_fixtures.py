#!/usr/bin/env python3
"""Export umap-learn 0.5.12 Stage-1/2 internals as JSON fixtures for holomap's
M1 parity tests (exit test: rho/sigma/membership weights match on fixtures).

Run with the coda spike venv (pins umap-learn==0.5.12):

    /mnt/data/Develop/coda/scripts/phase0-clusterer-spike/.venv/bin/python \
        dev/export_stage2_fixtures.py

Writes tests/fixtures/stage2_<name>.json. Deterministic: seeded RNG, exact
brute-force kNN (no pynndescent), stable index tie-breaking — the same kNN
semantics holomap implements, so fixtures validate Stage 1 and Stage 2.
"""

import json
from pathlib import Path

import numpy as np
import scipy.sparse
from sklearn.metrics import pairwise_distances
from umap.umap_ import compute_membership_strengths, smooth_knn_dist

OUT_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures"


def exact_knn(X: np.ndarray, k: int, metric: str):
    """Exact brute-force kNN, self included, ties broken by index (stable)."""
    dmat = pairwise_distances(X.astype(np.float64), metric=metric)
    # stable argsort = ties broken by lower index, matching holomap's rule
    order = np.argsort(dmat, axis=1, kind="stable")
    knn_indices = order[:, :k].astype(np.int32)
    knn_dists = np.take_along_axis(dmat, order[:, :k], axis=1).astype(np.float32)
    return knn_indices, knn_dists


def stage2(knn_indices, knn_dists, n_neighbors: int):
    """Mirror fuzzy_simplicial_set's Stage-2 path exactly (umap_.py:442+)."""
    sigmas, rhos = smooth_knn_dist(
        knn_dists, float(n_neighbors), local_connectivity=1.0
    )
    rows, cols, vals, _ = compute_membership_strengths(
        knn_indices, knn_dists, sigmas, rhos
    )
    n = knn_indices.shape[0]
    result = scipy.sparse.coo_matrix((vals, (rows, cols)), shape=(n, n))
    result.eliminate_zeros()
    transpose = result.transpose()
    prod = result.multiply(transpose)
    result = (result + transpose - prod).tocoo()  # set_op_mix_ratio = 1.0
    result.eliminate_zeros()
    return sigmas, rhos, result


def export(name: str, X: np.ndarray, n_neighbors: int, metric: str):
    knn_indices, knn_dists = exact_knn(X, n_neighbors, metric)
    sigmas, rhos, coo = stage2(knn_indices, knn_dists, n_neighbors)

    # canonical (row, col) ordering so the Rust side can compare directly
    order = np.lexsort((coo.col, coo.row))
    fixture = {
        "name": name,
        "metric": metric,
        "n_neighbors": n_neighbors,
        "n_samples": int(X.shape[0]),
        "n_features": int(X.shape[1]),
        "data": [[float(v) for v in row] for row in X],
        "knn_indices": knn_indices.tolist(),
        "knn_dists": [[float(v) for v in row] for row in knn_dists],
        "rhos": [float(v) for v in rhos],
        "sigmas": [float(v) for v in sigmas],
        "graph_rows": coo.row[order].tolist(),
        "graph_cols": coo.col[order].tolist(),
        "graph_vals": [float(v) for v in coo.data[order]],
    }
    out = OUT_DIR / f"stage2_{name}.json"
    out.write_text(json.dumps(fixture) + "\n")
    print(f"{out.name}: n={X.shape[0]} d={X.shape[1]} k={n_neighbors} "
          f"metric={metric} nnz={coo.nnz}")


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(42)

    # 1. three gaussian blobs, euclidean — the bread-and-butter case
    centers = rng.normal(0.0, 5.0, size=(3, 5))
    blobs = np.vstack([
        center + rng.normal(0.0, 0.6, size=(10, 5)) for center in centers
    ]).astype(np.float32)
    export("blobs_euclidean", blobs, n_neighbors=5, metric="euclidean")

    # 2. cosine metric — directional data on varying magnitudes
    directions = rng.normal(0.0, 1.0, size=(25, 8))
    scales = rng.uniform(0.5, 4.0, size=(25, 1))
    cosine_data = (directions * scales).astype(np.float32)
    export("cosine", cosine_data, n_neighbors=4, metric="cosine")

    # 3. exact duplicates — exercises rho's non-identical-neighbour rule and
    #    the d=0 tie-breaking path (self may not be a point's first neighbour)
    base = rng.normal(0.0, 2.0, size=(16, 4))
    dups = np.vstack([base, base[:4]]).astype(np.float32)  # rows 16..19 dup 0..3
    export("duplicates_euclidean", dups, n_neighbors=4, metric="euclidean")


if __name__ == "__main__":
    main()
