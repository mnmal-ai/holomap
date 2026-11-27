import { spawn, type ChildProcess } from 'node:child_process';
import { type ClusterParams, type ClusterResult, ClustererError, type Clusterer, type ProtocolResponse } from './types.js';
import { validateClusterInput } from './validation.js';

interface PendingRequest {
  resolve: (line: string) => void;
  reject: (err: Error) => void;
}

export class SubprocessClusterer implements Clusterer {
  readonly #argv: readonly string[];
  #child: ChildProcess | undefined;
  #buf = '';
  #stderr = '';
  #warningLines: string[] = [];
  #pending: PendingRequest | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #closing = false;

  /** argv[0] = executable, rest = args. E.g. ['.venv/bin/python', 'clusterer.py']. */
  constructor(argv: readonly string[]) {
    if (argv.length === 0) throw new ClustererError('empty clusterer argv');
    this.#argv = argv;
  }

  /**
   * Tear down the persistent child. The instance is unusable after close().
   */
  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#failPending(new ClustererError('clusterer closed'));
    const child = this.#child;
    this.#child = undefined;
    if (!child) return;
    this.#detach(child);
    try { child.kill(); } catch { /* already gone */ }
    this.#buf = '';
    this.#stderr = '';
    this.#warningLines = [];
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

    // Serialize requests through the single child: the wire protocol is one
    // request per stdin line, answered in order, and main.rs processes
    // stdin sequentially — concurrent writers on one pipe would race.
    const task = this.#queue.then(() => this.#roundTrip(vectors, params));
    this.#queue = task.catch(() => {});
    return task;
  }

  async #ensureChild(): Promise<ChildProcess> {
    if (this.#closing) throw new ClustererError('clusterer is closed');
    if (this.#child) return this.#child;
    const [cmd, ...args] = this.#argv as [string, ...string[]];
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    this.#buf = '';
    this.#stderr = '';
    this.#warningLines = [];
    // Don't let a lingering child keep the parent's event loop alive.
    child.unref();
    child.stdout.on('data', (d: Buffer) => this.#onStdout(d));
    child.stderr.on('data', (d: Buffer) => { this.#stderr += d.toString(); });
    child.on('error', (e) => {
      this.#child = undefined;
      this.#failPending(new ClustererError(`spawn failed: ${e.message}`));
    });
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
      const how = signal !== null ? `killed by ${signal}` : `exited ${code}`;
      const detail = (this.#stderr.trim().length > 0 ? this.#stderr : this.#warningLines.join('\n')).trim().slice(0, 500);
      const wasPending = this.#pending !== undefined;
      this.#child = undefined;
      this.#warningLines = [];
      this.#stderr = '';
      this.#buf = '';
      if (wasPending) {
        // In-band protocol responses are only valid on exit 0 — see main.rs.
        // A clean exit with a pending request means the child died silently.
        const msg = code === 0 && signal === null
          ? `clusterer exited ${code} without responding`
          : (detail.length > 0 ? `clusterer ${how}: ${detail}` : `clusterer ${how}`);
        this.#failPending(new ClustererError(msg));
      }
    });
    // Kill the child on process exit so a forgotten close() cannot leave a
    // detached peripheral behind. unref() above keeps the child out of the
    // event loop, so this is the only thing that guarantees the child dies
    // with the parent.
    process.once('exit', () => {
      if (this.#child === child) {
        try { child.kill(); } catch { /* already gone */ }
        this.#child = undefined;
      }
    });
    return child;
  }

  #detach(child: ChildProcess): void {
    child.stdin?.end();
    child.removeAllListeners();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }

  #onStdout(d: Buffer): void {
    this.#buf += d.toString();
    let idx: number;
    while ((idx = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, idx);
      this.#buf = this.#buf.slice(idx + 1);
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      // Non-protocol stdout (e.g. hdbscan's warnings) is not a response.
      try {
        JSON.parse(trimmed);
      } catch {
        if (this.#warningLines.length < 100) this.#warningLines.push(trimmed);
        continue;
      }
      const p = this.#pending;
      if (p) {
        this.#pending = undefined;
        p.resolve(trimmed);
      }
    }
  }

  #failPending(err: Error): void {
    const p = this.#pending;
    this.#pending = undefined;
    if (p) p.reject(err);
  }

  async #roundTrip(vectors: readonly Float32Array[], params: ClusterParams): Promise<ClusterResult> {
    const child = await this.#ensureChild();
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
    // Set the pending slot BEFORE writing: the response can arrive in the
    // same tick as the write callback, and a response dispatched while the
    // slot is empty would be silently discarded, hanging the caller.
    const linePromise = new Promise<string>((resolve, reject) => {
      this.#pending = { resolve, reject };
    });
    const stdin = child.stdin!;
    await new Promise<void>((resolve, reject) => {
      stdin.write(`${request}\n`, (err: Error | null | undefined) => {
        if (err) reject(new ClustererError(`clusterer closed stdin: ${err.message}`));
        else resolve();
      });
    });
    const line = await linePromise;
    const response = JSON.parse(line) as ProtocolResponse;
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
