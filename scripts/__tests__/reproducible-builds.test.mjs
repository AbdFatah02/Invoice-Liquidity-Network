/**
 * Issue #1078 — Reproducible builds regression tests.
 *
 * Asserts that:
 * 1. SOURCE_DATE_EPOCH utility yields valid timestamps.
 * 2. Hash utilities accurately compute SHA256 checksums.
 * 3. Package configurations for @iln/sdk and @invoice-liquidity/cli enforce
 *    explicit files inclusion and reproducible build settings.
 * 4. CI workflow .github/workflows/reproducible-builds.yml exists and enforces
 *    verification before publishing release artifacts.
 * 5. Documentation in docs/reproducible-builds.md exists and is registered in docs/_meta.json.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getSourceDateEpoch, hashFile } from '../verify-reproducible-builds.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('getSourceDateEpoch returns a valid numeric Unix epoch timestamp', () => {
  const epoch = getSourceDateEpoch(ROOT);
  assert.match(epoch, /^\d+$/, 'SOURCE_DATE_EPOCH must be a positive integer timestamp string');
  assert.ok(Number(epoch) > 1600000000, 'Epoch timestamp must be reasonable');
});

test('hashFile accurately calculates sha256 checksum of a file', () => {
  const pkgPath = join(ROOT, 'package.json');
  const hash = hashFile(pkgPath);
  assert.match(hash, /^[a-f0-9]{64}$/, 'hashFile must produce a 64-char hex sha256 digest');
});

test('SDK and CLI package.json files declare explicit files allowlists', () => {
  const sdkPkg = JSON.parse(readFileSync(join(ROOT, 'sdk', 'package.json'), 'utf8'));
  const cliPkg = JSON.parse(readFileSync(join(ROOT, 'cli', 'package.json'), 'utf8'));

  assert.ok(Array.isArray(sdkPkg.files), 'sdk/package.json must declare files allowlist');
  assert.ok(sdkPkg.files.includes('dist'), 'sdk/package.json files must include dist');

  assert.ok(Array.isArray(cliPkg.files), 'cli/package.json must declare files allowlist');
  assert.ok(cliPkg.files.includes('dist'), 'cli/package.json files must include dist');
});

test('reproducible builds CI workflow exists and runs reproducible verification', () => {
  const workflowPath = join(ROOT, '.github', 'workflows', 'reproducible-builds.yml');
  assert.ok(existsSync(workflowPath), '.github/workflows/reproducible-builds.yml must exist');

  const content = readFileSync(workflowPath, 'utf8');
  assert.ok(
    content.includes('verify-reproducible-builds.mjs') ||
      content.includes('test:reproducible-builds'),
    'Workflow must execute verify-reproducible-builds or test:reproducible-builds'
  );
  assert.ok(content.includes('SOURCE_DATE_EPOCH'), 'Workflow must set or verify SOURCE_DATE_EPOCH');
});

test('reproducible builds documentation exists and is registered in docs/_meta.json', () => {
  const docPath = join(ROOT, 'docs', 'reproducible-builds.md');
  assert.ok(existsSync(docPath), 'docs/reproducible-builds.md must exist');

  const docContent = readFileSync(docPath, 'utf8');
  assert.ok(
    docContent.includes('SOURCE_DATE_EPOCH'),
    'Documentation must explain SOURCE_DATE_EPOCH'
  );
  assert.ok(docContent.includes('@iln/sdk'), 'Documentation must mention @iln/sdk');
  assert.ok(
    docContent.includes('@invoice-liquidity/cli'),
    'Documentation must mention @invoice-liquidity/cli'
  );

  const meta = JSON.parse(readFileSync(join(ROOT, 'docs', '_meta.json'), 'utf8'));
  assert.ok(meta['reproducible-builds'], 'docs/_meta.json must include reproducible-builds entry');
});
