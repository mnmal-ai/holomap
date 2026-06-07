#!/usr/bin/env python3
"""Export scipy eigsh eigenpairs of the normalized Laplacian for holomap's
M2 parity gate, mirroring umap-learn's _spectral_layout exactly:
L = I − D^{−1/2} W D^{−1/2}, eigsh(k=dim+1, which='SM', v0=ones), columns
ordered by ascending eigenvalue with the trivial first one KEPT in the
export (the Rust side checks all of them, then drops the trivial for init).

Run with the coda spike venv:

    /mnt/data/Develop/coda/scripts/phase0-clusterer-spike/.venv/bin/python \
        dev/export_spectral_fixtures.py

The graph is built through the same Stage-1/2 path as the M1 fixtures
(exact kNN fed into umap-learn's smooth_knn_dist + membership + t-conorm),
so this fixture exercises the whole front half of the pipeline plus the
eigensolve.
"""

import json
from pathlib import Path

import numpy as np
import scipy.sparse
import scipy.sparse.csgraph
import scipy.sparse.linalg
from export_stage2_fixtures import exact_knn, stage2

OUT_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
DIM = 2


def main():
    rng = np.random.default_rng(2026)
    # single connected cloud: one anisotropic gaussian, k high enough that
    # the fuzzy graph stays one component
    base = rng.normal(0.0, 1.0, size=(60, 6))
    stretch = np.array([3.0, 1.5, 1.0, 0.7, 0.5, 0.3])
    X = (base * stretch).astype(np.float32)
    k = 10

    knn_indices, knn_dists = exact_knn(X, k, "euclidean")
    sigmas, rhos, coo = stage2(knn_indices, knn_dists, k)

    csr = coo.tocsr()
    n_comp, _ = scipy.sparse.csgraph.connected_components(csr)
    assert n_comp == 1, f"fixture graph must be connected, got {n_comp} components"

    # normalized Laplacian per umap spectral.py
    sqrt_deg = np.sqrt(np.asarray(csr.sum(axis=0)).squeeze())
    I = scipy.sparse.identity(csr.shape[0], dtype=np.float64)
    D = scipy.sparse.spdiags(1.0 / sqrt_deg, 0, csr.shape[0], csr.shape[0])
    L = I - D * csr * D

    k_eig = DIM + 1
    eigenvalues, eigenvectors = scipy.sparse.linalg.eigsh(
        L,
        k_eig,
        which="SM",
        ncv=max(2 * k_eig + 1, int(np.sqrt(csr.shape[0]))),
        tol=1e-12,  # tighter than umap's 1e-4: this is a parity oracle
        v0=np.ones(L.shape[0]),
        maxiter=csr.shape[0] * 5,
    )
    order = np.argsort(eigenvalues)
    eigenvalues = eigenvalues[order]
    eigenvectors = eigenvectors[:, order]

    fixture = {
        "name": "cloud_connected",
        "metric": "euclidean",
        "n_neighbors": k,
        "n_samples": int(X.shape[0]),
        "n_features": int(X.shape[1]),
        "dim": DIM,
        "data": [[float(v) for v in row] for row in X],
        "eigenvalues": [float(v) for v in eigenvalues],
        # column-major: eigenvectors[j] is the j-th eigenvector
        "eigenvectors": [[float(v) for v in eigenvectors[:, j]] for j in range(k_eig)],
    }
    out = OUT_DIR / "spectral_cloud_connected.json"
    out.write_text(json.dumps(fixture) + "\n")
    print(f"{out.name}: n={X.shape[0]} nnz={csr.nnz} eigenvalues={eigenvalues}")


if __name__ == "__main__":
    main()
