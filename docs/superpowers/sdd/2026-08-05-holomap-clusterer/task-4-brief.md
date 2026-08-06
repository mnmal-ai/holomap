### Task 4: npm package with the interface and `SubprocessClusterer`

Scaffold the package and move the TypeScript interface plus the subprocess backend across verbatim.

**Files:**
- Create: `npm/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `npm/src/{types,subprocess-clusterer,index}.ts`
- Test: `npm/test/subprocess-clusterer.test.ts`

**Interfaces:**
- Produces: `ClusterParams { nComponents, nNeighbors, minClusterSize, seed }`, `ClusterResult { assignments: readonly number[]; probabilities?: readonly number[] }`, `interface Clusterer { cluster(vectors: readonly Float32Array[], params: ClusterParams): Promise<ClusterResult> }`, `class ClustererError extends Error`, `class SubprocessClusterer implements Clusterer`.

- [ ] **Step 1: Scaffold the package**

`npm/package.json`:

```json
{
  "name": "@mnmal-ai/holomap-clusterer",
  "version": "0.1.0",
  "description": "Deterministic reduce→cluster: holomap UMAP + HDBSCAN. One Clusterer interface, wasm and subprocess backends.",
  "license": "MIT OR Apache-2.0",
  "repository": { "type": "git", "url": "git+https://github.com/mnmal-ai/holomap.git", "directory": "npm" },
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
  "files": ["dist", "wasm"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "check-types": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  }
}
```

`npm/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`npm/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 120_000 }
});
```

The 120 s timeout exists because the wasm backend's reference-corpus run is tens of seconds.

- [ ] **Step 2: Write the types**

`npm/src/types.ts` — copied verbatim from `coda/packages/dynamics/src/clusterer.ts`, which is the production definition:

```ts
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
```

- [ ] **Step 3: Move `SubprocessClusterer` verbatim**

Copy the `SubprocessClusterer` class from `coda/packages/dynamics/src/clusterer.ts` (lines 44–117) into `npm/src/subprocess-clusterer.ts`, changing only the imports:

```ts
import { spawn } from 'node:child_process';
import { type ClusterParams, type ClusterResult, ClustererError, type Clusterer, type ProtocolResponse } from './types.js';
```

**Do not otherwise modify the class.** It is production code; a rewrite during a move is how behaviour gets lost.

`npm/src/index.ts`:

```ts
export * from './types.js';
export { SubprocessClusterer } from './subprocess-clusterer.js';
export { WasmClusterer } from './wasm-clusterer.js';
```

`WasmClusterer` arrives in Task 5; until then this line will not compile, so add it in Task 5 and export only the subprocess backend for now.

- [ ] **Step 4: Write the failing test**

`npm/test/subprocess-clusterer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ClustererError, SubprocessClusterer } from '../src/index.js';

const BIN = new URL('../../target/release/holomap-clusterer', import.meta.url).pathname;

function blobs(): Float32Array[] {
  let state = 42n;
  const next = () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number(state >> 33n) / 0xffffffff - 0.5;
  };
  const out: Float32Array[] = [];
  for (let blob = 0; blob < 3; blob++) {
    for (let i = 0; i < 30; i++) {
      const v = new Float32Array(8);
      v[blob * 2] = 10.0;
      for (let j = 0; j < 8; j++) v[j] += next() * 0.5;
      out.push(v);
    }
  }
  return out;
}

describe('SubprocessClusterer', () => {
  it('separates three blobs', async () => {
    const clusterer = new SubprocessClusterer([BIN]);
    const result = await clusterer.cluster(blobs(), {
      nComponents: 0, nNeighbors: 15, minClusterSize: 5, seed: 42
    });
    const labels = new Set(result.assignments.filter((l) => l >= 0));
    expect(labels.size).toBe(3);
  });

  it('throws ClustererError on an empty argv', () => {
    expect(() => new SubprocessClusterer([])).toThrow(ClustererError);
  });
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `cd npm && pnpm install && pnpm test`
Expected: FAIL — the binary does not exist yet at that path.

- [ ] **Step 6: Build the native binary and re-run**

```bash
cd /mnt/data/Develop/holomap && cargo build --release -p holomap-clusterer
cd npm && pnpm test
```

Expected: PASS, 2 tests.

- [ ] **Step 7: Commit**

```bash
git add npm
git commit -m "feat: npm package with the Clusterer interface and subprocess backend

Interface and SubprocessClusterer move verbatim from coda/packages/dynamics/
src/clusterer.ts — production code that has already survived one backend swap
(clusterer.py -> Rust binary, 2026-06-07). Copied rather than rewritten: a
rewrite during a move is how behaviour gets lost.

probabilities is documented as never populated. hdbscan 0.12's .cluster()
returns labels only; the field exists for protocol forward-compatibility.

Written by [mnmal-ai-claude](https://github.com/mnmal-ai-claude) with [Claude Code](https://claude.com/claude-code)"
```

---

