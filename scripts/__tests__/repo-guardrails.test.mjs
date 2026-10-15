import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

const roots = [];
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'iln-guardrails-'));
  roots.push(root);
  return root;
};
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function run(script, root) {
  return spawnSync(process.execPath, [join(TEST_DIR, '..', script)], {
    encoding: 'utf8',
    env: { ...process.env, ILN_REPO_ROOT: root },
  });
}

test('foreign lockfile check catches npm, yarn, and bun files nested in the workspace', () => {
  const root = makeRepo();
  mkdirSync(join(root, 'packages', 'new-workspace'), { recursive: true });
  writeFileSync(join(root, 'packages', 'new-workspace', 'bun.lock'), '');

  const result = run('check-no-foreign-lockfiles.mjs', root);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /packages\/new-workspace\/bun\.lock/, JSON.stringify(result));
});

test('foreign lockfile check detects a linked lockfile without traversing linked directories', () => {
  const root = makeRepo();
  const target = join(root, 'real-lock');
  writeFileSync(target, '');
  symlinkSync(target, join(root, 'package-lock.json'));

  const result = run('check-no-foreign-lockfiles.mjs', root);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /package-lock\.json/);
});

test('duplicate type check includes newly added packages/*/src workspaces', () => {
  const root = makeRepo();
  mkdirSync(join(root, 'packages', 'shared', 'src', 'nested'), { recursive: true });
  mkdirSync(join(root, 'packages', 'new-consumer', 'src', 'nested'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'new-consumer', 'package.json'),
    JSON.stringify({ dependencies: { '@iln/shared': 'workspace:*' } })
  );
  writeFileSync(join(root, 'packages', 'shared', 'src', 'nested', 'types.ts'), 'export interface InvoiceRecord {}\n');
  writeFileSync(join(root, 'packages', 'new-consumer', 'src', 'nested', 'types.ts'), 'export interface InvoiceRecord {}\n');

  const result = run('check-no-duplicate-types.mjs', root);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /packages\/new-consumer\/src\/nested\/types\.ts/);
});

test('duplicate type check follows TypeScript source file links without traversing linked directories', () => {
  const root = makeRepo();
  mkdirSync(join(root, 'packages', 'shared', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'new-consumer', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'new-consumer', 'package.json'),
    JSON.stringify({ dependencies: { '@iln/shared': 'workspace:*' } })
  );
  writeFileSync(join(root, 'packages', 'shared', 'src', 'types.ts'), 'export type PaymentState = "open";\n');
  const linkedSource = join(root, 'linked-types.ts');
  writeFileSync(linkedSource, 'export type PaymentState = "open";\n');
  symlinkSync(linkedSource, join(root, 'packages', 'new-consumer', 'src', 'linked-types.ts'));

  const result = run('check-no-duplicate-types.mjs', root);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /packages\/new-consumer\/src\/linked-types\.ts/);
});
