/**
 * Label-catalog drift guard. Two checks, one command, run in CI via
 * `check-pr-labels.mjs` (repo state, not PR state):
 *
 * 1. **Missing Area labels.** Every workspace member (a `package.json` or
 *    Cargo `[package]` under `packages/`, `apps/`, `plugins/` or `crates/`,
 *    plus a root crate and `npm/`) must have an area label matching its
 *    member name. A package with no area label passes the PR hygiene gate
 *    silently (Area is an open set in `check-pr-labels.mjs`), so we fail fast.
 *
 * 2. **Unknown labels.** Any repo label that is neither a workspace member
 *    name nor one of the known functional (Type/Priority/workflow) labels is
 *    considered stale — most commonly a GitHub default (`duplicate`, `good
 *    first issue`, ...) or a dependabot-generated language label (`javascript`).
 *    We hard-fail and emit the exact `gh label delete` command to fix it.
 *
 * CLI usage: needs `gh` authenticated (GH_TOKEN) — run from the repo root.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const WORKSPACE_DIRS = ['packages', 'apps', 'plugins', 'crates'];
// Single-directory members, with the manifests that name them. The root counts
// only as a Cargo crate: its package.json is the workspace itself.
const SINGLE_MEMBERS = [
  ['.', ['Cargo.toml']],
  ['npm', ['package.json', 'Cargo.toml']]
];
const ORG_PREFIX = '@mnmal-ai/';

/**
 * Known functional labels that are neither areas nor member names but are
 * intentional repo conventions. These are stable across PRs and should never
 * be deleted, so they must pass the drift check silently.
 */
export const FUNCTIONAL_LABELS = [
  // Priority
  'P0-critical',
  'P1-high',
  'P2-medium',
  'P3-low',
  // Type (used by pr-hygiene)
  'feat',
  'fix',
  'refactor',
  'docs',
  'test',
  'infra',
  // Workflow / status
  'blocked',
  'needs-review',
  'ready-to-merge',
  // Generic
  'repo'
];

/**
 * @param {string} rootDir repo root
 * @returns {string[]} workspace member names without the org prefix, sorted
 */
export function discoverWorkspaceMembers(rootDir) {
  const out = [];
  const add = (dir, manifests) => {
    const name = memberName(dir, manifests);
    if (name !== undefined)
      out.push(name.startsWith(ORG_PREFIX) ? name.slice(ORG_PREFIX.length) : name);
  };
  for (const dir of WORKSPACE_DIRS) {
    const absDir = resolve(rootDir, dir);
    if (!existsSync(absDir)) continue;
    for (const name of readdirSync(absDir).sort())
      add(resolve(absDir, name), ['package.json', 'Cargo.toml']);
  }
  for (const [dir, manifests] of SINGLE_MEMBERS) add(resolve(rootDir, dir), manifests);
  return [...new Set(out)].sort();
}

/** The first manifest's package name, or undefined when none names one. */
function memberName(dir, manifests) {
  for (const manifest of manifests) {
    const file = resolve(dir, manifest);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const name = manifest === 'package.json' ? JSON.parse(text).name : cargoPackageName(text);
    if (typeof name === 'string') return name;
  }
  return undefined;
}

/** `name` from a Cargo.toml's `[package]` table; a workspace-only manifest has none. */
function cargoPackageName(toml) {
  let inPackage = false;
  for (const line of toml.split('\n')) {
    const header = line.trim();
    if (header.startsWith('[')) inPackage = header === '[package]';
    else if (inPackage) {
      const m = /^name\s*=\s*"([^"]+)"/.exec(header);
      if (m) return m[1];
    }
  }
  return undefined;
}

/**
 * @param {{ workspaceMembers: string[], labelNames: string[] }} args
 * @returns {string[]} members with no matching label, sorted
 */
export function findMissingAreaLabels({ workspaceMembers, labelNames }) {
  const labels = new Set(labelNames);
  return workspaceMembers.filter((m) => !labels.has(m)).sort();
}

/**
 * Labels that are neither workspace-member names nor known functional labels.
 * These are drift — stale defaults or dependabot residue.
 * @param {{ workspaceMembers: string[], labelNames: string[] }} args
 * @returns {string[]} unknown labels, sorted
 */
export function findUnknownLabels({ workspaceMembers, labelNames }) {
  const allowed = new Set([...workspaceMembers, ...FUNCTIONAL_LABELS]);
  return labelNames.filter((l) => !allowed.has(l)).sort();
}

function listRepoLabels() {
  const raw = execFileSync('gh', ['label', 'list', '--json', 'name', '--limit', '200'], {
    encoding: 'utf8'
  });
  return JSON.parse(raw).map((l) => l.name);
}

function main() {
  const rootDir = process.argv[2] ?? process.cwd();
  const members = discoverWorkspaceMembers(rootDir);
  const allLabels = listRepoLabels();

  const missingAreas = findMissingAreaLabels({ workspaceMembers: members, labelNames: allLabels });
  const unknownLabels = findUnknownLabels({ workspaceMembers: members, labelNames: allLabels });

  if (missingAreas.length === 0 && unknownLabels.length === 0) {
    process.stdout.write(
      `✅ label catalog OK — ${members.length} workspace members have Area labels, no stale/unknown labels.\n`
    );
    return;
  }

  let exitCode = 0;

  if (missingAreas.length > 0) {
    exitCode = 1;
    process.stdout.write(
      `❌ label catalog drift — workspace members with no Area label (${missingAreas.length}):\n`
    );
    for (const m of missingAreas) {
      process.stdout.write(`  • ${m}\n`);
      process.stdout.write(
        `    gh label create ${m} --color 1d76db --description "<one line, see sibling labels>"\n`
      );
    }
  }

  if (unknownLabels.length > 0) {
    exitCode = 1;
    process.stdout.write(
      `❌ label catalog drift — stale/unknown labels (${unknownLabels.length}):\n`
    );
    for (const l of unknownLabels) {
      process.stdout.write(`  • ${l}\n`);
      process.stdout.write(`    gh label delete --yes "${l}"\n`);
    }
  }

  process.exitCode = exitCode;
}

// Run as CLI only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
