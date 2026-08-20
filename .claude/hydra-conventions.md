<!-- hydra-conventions vsynoptic-1.10.0+c6ea5fdc — plugin-owned; do not edit. Edit your own CLAUDE.md instead. -->

# Hydra interaction conventions

You are an agent consuming a Hydra `hydra-claude` coordinator. Follow these rules.

## MCP first

Use the `hydra` MCP tools (`hydra_schema`, `hydra_query`, `hydra_mutate`, `hydra_recall`, `hydra_nl`) for all Hydra interactions. Call `hydra_schema` first on cold-start to discover types and mutations. Fall back to HTTP only when MCP is confirmed unreachable.

## Qualified frame keys

Every query/mutate/subscribe key is `<namespace>/<TypeOrMutation>` — e.g. `cortext/Todo`, `cortext/createTodo`. There is no `namespace` sidecar.

`hydra_recall` is the exception: it takes `namespace` as its own argument, and it is **required** — pass it explicitly. Hydra ≥3.19 rejects an omitted namespace with `code: 'missing_namespace'` rather than falling back to a default. The old fallback was the retired `claude` namespace, so omitting it used to return an empty result from a namespace that no longer resolves — a silent miss that now fails loudly.

## Filters live in `where`

Top-level `params` are not filters. Operators: `eq`, `neq`, `gt|gte|lt|lte`, `between`, `in|nin`, `contains`, `startsWith|endsWith`. Example:

```json
{ "cortext/Todo": { "params": { "where": { "status": { "eq": "open" } }, "limit": 10 }, "fields": { "id": true, "title": true } } }
```

Retrieval-tuned handle fields (`name`, `title`, `topic`, `synopsis`, `description`) are indexed and filter freely. Long-form fields (`body`, `summary`, `notes`, `rationale`) are deliberately unindexed — a structural filter on them rejects with `unindexed_field` unless you pass `params._allowTableScan: true`. For content search, prefer `hydra_recall` (semantic) over scanning prose. **`eq: null` works** — it is the is-null filter. Verified across all three field kinds: `sessionId` (crossRef), `project` (promoted scalar) and `note` (unindexed, with `_allowTableScan`) each return only rows where the field is null, and it discriminates — 37 of 762 Todos, not all 762. pg emits `IS NULL` for a null operand and the memory evaluator treats null and undefined as equal. This entry previously said the opposite and told you to project the field and filter client-side; that was false and cost a full table read every time someone followed it. Note crossRefs accept only `eq`, `in` and `nin` — `neq` is rejected with `unknown_operator`.

## Server-managed metadata

`createdAt`, `updatedAt`, `createdBy`, `updatedBy` are server-filled — never send them on create/update (rejected with `client_supplied_server_field`). Read them via the `_metadata` projection.

## Batched mutations

An array value under one op-key is one atomic transaction; each element is a full `{ params, fields }` frame:

```json
{ "cortext/createTodo": [ { "params": { "title": "a" }, "fields": { "id": true } }, { "params": { "title": "b" }, "fields": { "id": true } } ] }
```

Do NOT put the array inside `params` — that writes garbage rows.

## Check `errors` before interpreting `data`

**A `200` is not success, and an empty `data` is not a true negative.** Hydra returns a partial-success envelope: one frame in a multi-frame query can fail while its siblings succeed, so the status code cannot carry the answer. A rejected frame comes back with **its key absent from `data`** and the reason in `errors`:

```
HTTP 200
data:   { "cortext/Todo": [...] }          <- the other frame is simply GONE
errors: [{ code: "unknown_operator",
           message: "operator 'in' is not valid for field 'trace' (kind=crossRef)",
           path: ["coda/Claim", "where", "trace", "in"] }]
```

So `data[key] ?? []` reads a rejected query as "nothing recorded". Read `errors` first; the server names the field, the kind and the path.

**The distinction `data[key] ?? []` destroys** is presence, not emptiness:

| | `data` | meaning |
|---|---|---|
| **rejected** | key **absent** | the query never ran; `errors` says why |
| **true negative** | key present, value `[]` | the query ran and matched nothing |

`?? []` renders both as `[]`. So the check that actually holds is a positive one — **assert that every frame key you asked for came back** — and it needs no reading of `errors` at all, which makes it belt-and-braces rather than a restatement. A missing key is a fact; an empty result that surprises you is only a heuristic.

This cost a full session once: an empty `data` was read as "no claims on these traces", a correct diagnosis was abandoned, and a bug was filed against a defect that did not exist.

## Who you are, and who else is

**Your agent identity is bound to the REPO, not to your session.** Concurrent sessions in one repo sign with the same key, and `AgentMessage` has **no sender field** — the sender is `_metadata.createdBy`, which the server derives from that key. So on the wire you are indistinguishable from every other session here.

This has cost real work twice. A correction was sent to the session that had *not* made the error, while the one doing the work never saw it. A reply asked who owned two Todos that a session with the same kid had filed hours earlier.

Two things follow, and the second matters more than the first.

**Stamp what you send.** Your cold-start names your session; carry it as a tag:

```json
{ "cortext/sendAgentMessage": { "params": { "to": "peer@host", "subject": "...", "body": "...", "tags": ["session:1a2b3c4d"] } } }
```

`tags` is indexed, so this is filterable. Delivery stays repo-scoped deliberately — a message addressed to one session would land in a dead mailbox once that session ended, and in both failures above the intended session had already stopped being the active one. Only provenance is session-scoped, never delivery.

**Say what you DID, not what you read.** The stamp is advisory: it is client-supplied, so a reader cannot verify it, and nothing stops it being omitted. What actually establishes that a message came from a session that did the work is the message *carrying* the work — a measurement, a file and line, a command and its output. A reply that only restates what it was sent is indistinguishable from one written by a session that has lost its context, because that is exactly what such a session produces.

Do not write "the agent said X earlier" into any protocol. While kid is repo-scoped and sessions are not, it is unsound.

## Context store conventions

Write context as it happens, no prompt needed: **Decision** when one is made; **Todo** when a gap surfaces (close with `archived: true`); **SessionLog** at every stable milestone (with a retrieval-tuned `synopsis`); **AnchorIntent** at session boot if stale and on any focus shift. Per-project rows carry a `project` field set to the repo basename; cross-cutting rows use `project: null`.

## Agent memory

**The Hydra `cortext` context store is the memory system of record. Ignore the harness's disk `MEMORY.md`.** Claude Code injects a default "auto memory" description pointing at a cwd-derived path; that is the harness's generic default, not this fleet's arrangement, and following it writes memory somewhere nothing reads.

Memory is scoped by the `project` field on each row (repo basename), **not** by which directory the file sits in. Cross-cutting rows use `project: null`.

**Reading:** the cold-start injection above is the source of truth — look for `## Agent Memory (from cortext/Memory — N total, M top)`, or `## Agent Memory (hybrid recall — RRF, unified)` when server-side recall is available. For anything not in that block, `hydra_recall` (semantic) beats scanning prose.

**Writing:** `cortext/createMemory`. Check for an existing row covering the same fact and update it rather than creating a duplicate.

## Cold-start

Each session begins with an injected synoptic view (Concepts, Agent Memory, Open Work, Agent Rules). Read it before acting. Re-query AgentRules after `/compact` (compression evicts them).
