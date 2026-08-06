import { readFileSync } from 'node:fs';

/**
 * Reference-corpus loader, mirroring `load_fixture` in
 * `crates/holomap-clusterer/tests/fixture_regression.rs`.
 *
 * Env-gated on `HOLOMAP_CLUSTERER_FIXTURE` for the same reason the Rust side
 * is: the corpus is 9.4 MB and lives outside this repo. Unset, callers skip.
 *
 * The TSV has 6 tab-separated columns; col 5 (index 4) is the text, used to
 * exclude the 76 synthetic perf fixtures, and col 6 (index 5) is a JSON array
 * of 1024 bge-m3 floats.
 *
 * The synthetic-row exclusion is not optional and not a detail. Coda's MVD §5
 * found those near-duplicates form the densest regions in the whole corpus and
 * dominate a naive clustering — they have to go before the clusterer sees the
 * data. The two filter prefixes are duplicated from the Rust loader by hand;
 * if either side changes, `expectedRows` below stops matching and the caller
 * fails loudly rather than silently clustering a different corpus.
 */
export const FIXTURE_ROWS = 723;
export const FIXTURE_DIMS = 1024;

export function fixturePath(): string | undefined {
  return process.env.HOLOMAP_CLUSTERER_FIXTURE;
}

export function loadFixture(path: string): Float32Array[] {
  const out: Float32Array[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 6) continue;
    const text = cols[4]!;
    if (text.startsWith('Seed session ') || text.startsWith('perf-seed-memory-')) continue;

    const raw = cols[5]!.trim().replace(/^\[|\]$/g, '');
    const parts = raw.split(',');
    const v = new Float32Array(parts.length);
    // Float32Array assignment does the f64 -> f32 rounding, matching what the
    // Rust loader's `parse::<f32>()` produces for the same decimal text.
    for (let i = 0; i < parts.length; i++) v[i] = Number(parts[i]);
    out.push(v);
  }

  if (out.length !== FIXTURE_ROWS) {
    throw new Error(
      `fixture has ${out.length} rows after filtering, expected ${FIXTURE_ROWS} — ` +
        `the synthetic-row filter is out of sync with the Rust loader, or this is a different export`
    );
  }
  if (out[0]!.length !== FIXTURE_DIMS) {
    throw new Error(`fixture is ${out[0]!.length}-dimensional, expected ${FIXTURE_DIMS}`);
  }
  return out;
}

/**
 * L2-normalise the way a JavaScript consumer does without deciding to.
 *
 * Every JS number is a double, so `sum` accumulates in f64 over the f32
 * values and only re-rounds on store. That is the `normalised/f64` regime in
 * the Rust suite, and it is what coda's production `l2normalize` produces —
 * confirmed by coda reproducing 34 clusters / 27.2% once it replicated its
 * own function literally instead of paraphrasing it.
 *
 * Do NOT "simplify" this to operate on the pre-cast values. That change is
 * what produced a wrong number once already, and it looks like a cleanup.
 */
export function l2normalize(vectors: readonly Float32Array[]): Float32Array[] {
  return vectors.map((v) => {
    let sum = 0;
    for (const x of v) sum += x * x;
    const norm = Math.sqrt(sum);
    if (norm === 0) return new Float32Array(v);
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
    return out;
  });
}

export function clusterCount(assignments: readonly number[]): number {
  return new Set(assignments.filter((l) => l >= 0)).size;
}

export function noiseCount(assignments: readonly number[]): number {
  return assignments.filter((l) => l === -1).length;
}
