import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

const WORKER = `
import { parentPort } from 'node:worker_threads';
import { WasmClusterer } from '${new URL('../src/index.ts', import.meta.url).pathname}';
const vectors = [];
for (let blob = 0; blob < 3; blob++)
  for (let i = 0; i < 30; i++) {
    const v = new Float32Array(8);
    v[blob * 2] = 10.0;
    v[7] = i * 0.01;
    vectors.push(v);
  }
const r = await new WasmClusterer().cluster(vectors,
  { nComponents: 0, nNeighbors: 15, minClusterSize: 5, seed: 42 });
parentPort.postMessage(r.assignments);
`;

// Node's --experimental-strip-types resolves import specifiers literally
// (https://nodejs.org/api/typescript.html) — a `./foo.js` specifier is never
// remapped to a sibling `foo.ts`. This repo's src/ uses `.js` specifiers per
// NodeNext moduleResolution (correct for the tsc-emitted dist/ output, and
// already handled by vitest's own Vite-based resolver for every other test
// in this suite). Only this test runs raw node against the .ts source
// directly, so it alone needs the one-line extension-remap loader below.
const LOADER = new URL('./ts-extension-loader.mjs', import.meta.url).pathname;

describe('worker_threads', () => {
  it('loads and runs inside a Worker with no top-level side effects', async () => {
    const assignments = await new Promise<number[]>((resolve, reject) => {
      const w = new Worker(WORKER, {
        eval: true,
        execArgv: ['--experimental-strip-types', '--import', LOADER]
      });
      w.on('message', resolve);
      w.on('error', reject);
    });
    expect(new Set(assignments.filter((l) => l >= 0)).size).toBe(3);
  });
});
