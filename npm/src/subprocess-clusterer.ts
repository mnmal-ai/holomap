import { spawn } from 'node:child_process';
import { type ClusterParams, type ClusterResult, ClustererError, type Clusterer, type ProtocolResponse } from './types.js';
import { validateClusterInput } from './validation.js';

export class SubprocessClusterer implements Clusterer {
  readonly #argv: readonly string[];

  /** argv[0] = executable, rest = args. E.g. ['.venv/bin/python', 'clusterer.py']. */
  constructor(argv: readonly string[]) {
    if (argv.length === 0) throw new ClustererError('empty clusterer argv');
    this.#argv = argv;
  }

  async cluster(vectors: readonly Float32Array[], params: ClusterParams): Promise<ClusterResult> {
    // Reject the same inputs WasmClusterer rejects, with the same message,
    // before spawning anything. Without this, bad input still gets rejected
    // — the child validates empty input and ragged dimensions itself, and a
    // bad seed either fails child-side JSON deserialisation or, worse, gets
    // forwarded as a real seed and crashes the child — but every one of
    // those paths costs a process spawn and produces a different message
    // than the wasm backend gives for the identical input.
    validateClusterInput(vectors, params);

    const request = JSON.stringify({
      protocol_version: 1,
      vectors: vectors.map((v) => [...v]),
      params: {
        n_components: params.nComponents,
        n_neighbors: params.nNeighbors,
        min_cluster_size: params.minClusterSize,
        seed: params.seed
      }
    });

    const [cmd, ...args] = this.#argv as [string, ...string[]];
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString();
      });
      child.on('error', (e) =>
        settle(() => reject(new ClustererError(`spawn failed: ${e.message}`)))
      );
      // A non-zero exit is a crash regardless of what the child managed to
      // print first. This condition used to also require empty stdout, so any
      // output at all turned a crash into a resolve — `JSON.parse` then failed
      // on whatever the child had printed and the caller saw "malformed
      // output" instead of "the child died". `hdbscan` 0.12 has exactly that
      // shape: a `HDBSCAN_WARNING:` line to STDOUT, then a panic.
      //
      // Salvaging partial stdout from a failed child is never right by
      // default here: `main.rs` reports every protocol-level error as a
      // Response on stdout and still exits 0, so a non-zero exit only ever
      // means abnormal termination — there is no success case to lose.
      child.on('close', (code, signal) => {
        if (code !== 0 || signal !== null) {
          // Panics land on stderr; hdbscan's pre-panic warning lands on
          // stdout. Prefer stderr, fall back to stdout so the only diagnostic
          // a stdout-only child produced isn't the thing we discard.
          const how = signal !== null ? `killed by ${signal}` : `exited ${code}`;
          const detail = (err.trim().length > 0 ? err : out).trim().slice(0, 500);
          settle(() =>
            reject(new ClustererError(detail.length > 0 ? `clusterer ${how}: ${detail}` : `clusterer ${how}`))
          );
          return;
        }
        settle(() => resolve(out));
      });
      child.stdin.write(`${request}\n`);
      child.stdin.end();
    });

    const lastLine = stdout.trim().split('\n').at(-1);
    if (lastLine === undefined || lastLine.length === 0) {
      throw new ClustererError('clusterer produced no output');
    }
    const response = JSON.parse(lastLine) as ProtocolResponse;
    if (response.error !== undefined && response.error !== null) {
      throw new ClustererError(response.error);
    }
    if (response.assignments.length !== vectors.length) {
      throw new ClustererError(
        `assignment count ${response.assignments.length} != input count ${vectors.length}`
      );
    }
    const result: ClusterResult = { assignments: response.assignments };
    if (response.probabilities !== undefined) {
      return { ...result, probabilities: response.probabilities };
    }
    return result;
  }
}
