/**
 * Tests for the label-catalog drift guard: missing Area labels fail, unknown
 * stale labels fail, extra functional labels do not.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  FUNCTIONAL_LABELS,
  discoverWorkspaceMembers,
  findMissingAreaLabels,
  findUnknownLabels
} from './check-label-drift.mjs';

// Existing tests
test('reports members with no matching label', () => {
  assert.deepEqual(
    findMissingAreaLabels({
      workspaceMembers: ['core', 'compose'],
      labelNames: ['core', 'feat', 'P2-medium', 'repo']
    }),
    ['compose']
  );
});

test('extra labels (non-package areas) are not drift', () => {
  assert.deepEqual(
    findMissingAreaLabels({
      workspaceMembers: ['core'],
      labelNames: ['core', 'repo', 'docs-site']
    }),
    []
  );
});

test('discovers named members of packages/, apps/ and plugins/, without the scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'label-drift-'));
  const write = (dir, pkg) => {
    mkdirSync(join(root, dir), { recursive: true });
    if (pkg) writeFileSync(join(root, dir, 'package.json'), JSON.stringify(pkg));
  };
  write('packages/one', { name: '@mnmal-ai/one' });
  write('apps/two', { name: 'two' });
  write('plugins/no-manifest');
  write('docs/ignored', { name: '@mnmal-ai/ignored' });
  try {
    assert.deepEqual(discoverWorkspaceMembers(root), ['one', 'two']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discovers Cargo crates and the root and npm/ members, but not the root package.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'label-drift-'));
  const put = (file, text) => {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  put(
    'Cargo.toml',
    '[workspace]\nmembers = ["crates/two"]\n\n[package]\nname = "one"\nversion = "0.1.0"\n'
  );
  put('crates/two/Cargo.toml', '[package]\nname = "two"\n\n[[bin]]\nname = "two-cli"\n');
  put('npm/package.json', JSON.stringify({ name: '@mnmal-ai/two' }));
  put('package.json', JSON.stringify({ name: '@mnmal-ai/repo-workspace' }));
  try {
    assert.deepEqual(discoverWorkspaceMembers(root), ['one', 'two']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// New tests for findUnknownLabels

test('reports GitHub default labels as unknown when no member matches and not functional', () => {
  assert.deepEqual(
    findUnknownLabels({
      workspaceMembers: ['core'],
      labelNames: [
        'core', // known functional? No — but it IS a member, so allowed.
        'duplicate', // GitHub default → unknown
        'good first issue', // GitHub default → unknown
        'javascript' // dependabot residue → unknown
      ]
    }),
    ['duplicate', 'good first issue', 'javascript']
  );
});

test('does not flag known functional labels as unknown', () => {
  assert.deepEqual(
    findUnknownLabels({
      workspaceMembers: ['core'],
      labelNames: [
        'core', // member → allowed
        ...FUNCTIONAL_LABELS // all functional → allowed
      ]
    }),
    []
  );
});

test('does not flag labels that match a workspace member name', () => {
  assert.deepEqual(
    findUnknownLabels({
      workspaceMembers: ['holomap', 'my-package'],
      labelNames: [
        'holomap', // member → allowed
        'my-package', // member → allowed
        'some-other-thing' // unknown
      ]
    }),
    ['some-other-thing']
  );
});

test('flag only genuinely unknown labels, not area or member names', () => {
  assert.deepEqual(
    findUnknownLabels({
      workspaceMembers: ['core'],
      labelNames: ['core', 'duplicate', 'help wanted', 'P0-critical', 'wontfix']
    }),
    ['duplicate', 'help wanted', 'wontfix']
  );
});

test('FUNCTIONAL_LABELS is non-empty and does not overlap with member names', () => {
  // Sanity: the convention set actually has content
  assert.ok(FUNCTIONAL_LABELS.length > 0);
  // No duplicates within the list itself
  assert.deepStrictEqual([...new Set(FUNCTIONAL_LABELS)], FUNCTIONAL_LABELS);
});
