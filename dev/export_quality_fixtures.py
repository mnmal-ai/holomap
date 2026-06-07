#!/usr/bin/env python3
"""Export the M3 quality-gate fixtures: blobs + swiss roll datasets with
umap-learn 0.5.12's trustworthiness on its own embedding. holomap's exit
bar is trustworthiness(k=15) within 0.05 of the reference on the same data.

Run with the coda spike venv:

    /mnt/data/Develop/coda/scripts/phase0-clusterer-spike/.venv/bin/python \
        dev/export_quality_fixtures.py
"""

import json
from pathlib import Path

import numpy as np
from sklearn.datasets import make_blobs, make_swiss_roll
from sklearn.manifold import trustworthiness
from umap import UMAP

OUT_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
K_TRUST = 15


def export(name: str, X: np.ndarray):
    reducer = UMAP(
        n_components=2,
        n_neighbors=15,
        min_dist=0.1,
        random_state=42,
        force_approximation_algorithm=False,
    )
    emb = reducer.fit_transform(X)
    t = float(trustworthiness(X, emb, n_neighbors=K_TRUST))
    fixture = {
        "name": name,
        "n_samples": int(X.shape[0]),
        "n_features": int(X.shape[1]),
        "k_trust": K_TRUST,
        "umap_trustworthiness": t,
        "data": [[float(v) for v in row] for row in X],
    }
    out = OUT_DIR / f"quality_{name}.json"
    out.write_text(json.dumps(fixture) + "\n")
    print(f"{out.name}: n={X.shape[0]} d={X.shape[1]} umap_t={t:.4f}")


def main():
    X_blobs, _ = make_blobs(
        n_samples=150, n_features=10, centers=3, cluster_std=1.0, random_state=42
    )
    export("blobs", X_blobs.astype(np.float32))

    X_roll, _ = make_swiss_roll(n_samples=300, noise=0.05, random_state=42)
    export("swiss_roll", X_roll.astype(np.float32))


if __name__ == "__main__":
    main()
