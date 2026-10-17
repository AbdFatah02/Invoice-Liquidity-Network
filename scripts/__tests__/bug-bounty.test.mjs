/**
 * Issue #1080 — Bug bounty program configuration regression test.
 *
 * Asserts that:
 * 1. docs/bug-bounty.md exists with complete severity taxonomy, scope,
 *    intake SLA (48h), and reward matrix ($100 - $25,000).
 * 2. SECURITY.md cross-references docs/bug-bounty.md and details the
 *    bounty program.
 * 3. docs/vulnerability-disclosure.md links to the bug bounty program.
 * 4. docs/_meta.json registers "bug-bounty".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('bug bounty documentation exists and defines reward matrix and scope', () => {
  const docPath = join(ROOT, 'docs', 'bug-bounty.md');
  assert.ok(existsSync(docPath), 'docs/bug-bounty.md must exist');

  const content = readFileSync(docPath, 'utf8');
  assert.ok(content.includes('Bug Bounty Program'), 'Must have Bug Bounty title');
  assert.ok(content.includes('Critical'), 'Must define Critical severity');
  assert.ok(content.includes('High'), 'Must define High severity');
  assert.ok(content.includes('Medium'), 'Must define Medium severity');
  assert.ok(content.includes('Low'), 'Must define Low severity');
  assert.ok(content.includes('25') && content.includes('000'), 'Must define top reward tier');
  assert.ok(content.includes('48'), 'Must define 48h acknowledgment SLA');
  assert.ok(content.includes('Safe Harbour'), 'Must define safe harbour commitments');
});

test('SECURITY.md links to docs/bug-bounty.md and outlines the bounty program', () => {
  const secPath = join(ROOT, 'SECURITY.md');
  assert.ok(existsSync(secPath), 'SECURITY.md must exist');

  const content = readFileSync(secPath, 'utf8');
  assert.ok(content.includes('docs/bug-bounty.md'), 'SECURITY.md must link to docs/bug-bounty.md');
  assert.ok(content.includes('Bug Bounty Program'), 'SECURITY.md must describe Bug Bounty Program');
  assert.ok(
    content.includes('25,000') || content.includes('25 000'),
    'SECURITY.md must mention reward tiers up to $25,000'
  );
});

test('docs/vulnerability-disclosure.md references docs/bug-bounty.md', () => {
  const vulnPath = join(ROOT, 'docs', 'vulnerability-disclosure.md');
  assert.ok(existsSync(vulnPath), 'docs/vulnerability-disclosure.md must exist');

  const content = readFileSync(vulnPath, 'utf8');
  assert.ok(
    content.includes('bug-bounty.md'),
    'docs/vulnerability-disclosure.md must link to bug-bounty.md'
  );
});

test('docs/_meta.json registers bug-bounty navigation entry', () => {
  const metaPath = join(ROOT, 'docs', '_meta.json');
  assert.ok(existsSync(metaPath), 'docs/_meta.json must exist');

  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  assert.ok(meta['bug-bounty'], 'docs/_meta.json must include "bug-bounty"');
});
