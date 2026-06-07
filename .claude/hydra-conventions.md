<!-- hydra-conventions vsynoptic-0.2.4 — plugin-owned; do not edit. Edit your own CLAUDE.md instead. -->

# Hydra interaction conventions

You are an agent consuming a Hydra `hydra-claude` coordinator. Follow these rules.

## MCP first

Use the `hydra` MCP tools (`hydra_schema`, `hydra_query`, `hydra_mutate`, `hydra_recall`, `hydra_nl`) for all Hydra interactions. Call `hydra_schema` first on cold-start to discover types and mutations. Fall back to HTTP only when MCP is confirmed unreachable.

## Qualified frame keys

Every query/mutate/subscribe key is `<namespace>/<TypeOrMutation>` — e.g. `claude/Todo`, `claude/createTodo`. There is no `namespace` sidecar.

## Filters live in `where`

Top-level `params` are not filters. Operators: `eq`, `neq`, `gt|gte|lt|lte`, `between`, `in|nin`, `contains`, `startsWith|endsWith`. Example:

```json
{ "claude/Todo": { "params": { "where": { "status": { "eq": "open" } }, "limit": 10 }, "fields": { "id": true, "title": true } } }
```

Retrieval-tuned handle fields (`name`, `title`, `topic`, `synopsis`, `description`) are indexed and filter freely. Long-form fields (`body`, `summary`, `notes`, `rationale`) are deliberately unindexed — a structural filter on them rejects with `unindexed_field` unless you pass `params._allowTableScan: true`. For content search, prefer `hydra_recall` (semantic) over scanning prose. `eq: null` never matches (SQL three-valued logic) — there is no is-null operator; project the field and filter client-side.

## Server-managed metadata

`createdAt`, `updatedAt`, `createdBy`, `updatedBy` are server-filled — never send them on create/update (rejected with `client_supplied_server_field`). Read them via the `_metadata` projection.

## Batched mutations

An array value under one op-key is one atomic transaction; each element is a full `{ params, fields }` frame:

```json
{ "claude/createTodo": [ { "params": { "title": "a" }, "fields": { "id": true } }, { "params": { "title": "b" }, "fields": { "id": true } } ] }
```

Do NOT put the array inside `params` — that writes garbage rows.

## Context store conventions

Write context as it happens, no prompt needed: **Decision** when one is made; **Todo** when a gap surfaces (close with `archived: true`); **SessionLog** at every stable milestone (with a retrieval-tuned `synopsis`); **AnchorIntent** at session boot if stale and on any focus shift. Per-project rows carry a `project` field set to the repo basename; cross-cutting rows use `project: null`.

## Cold-start

Each session begins with an injected synoptic view (Concepts, Agent Memory, Open Work, Agent Rules). Read it before acting. Re-query AgentRules after `/compact` (compression evicts them).
