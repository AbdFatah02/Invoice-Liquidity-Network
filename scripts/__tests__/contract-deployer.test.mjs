import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const deployScript = join(repoRoot, 'contract-deployer', 'deploy.sh');
const roots = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'iln-deployer-'));
  roots.push(root);
  mkdirSync(join(root, 'target', 'wasm32v1-none', 'release'), { recursive: true });
  writeFileSync(join(root, 'target', 'wasm32v1-none', 'release', 'invoice_liquidity.wasm'), 'wasm');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const calls = join(root, 'stellar-calls.log');
  writeFileSync(join(bin, 'stellar'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`);
  chmodSync(join(bin, 'stellar'), 0o755);
  return { root, bin, calls };
}

function run(root, bin, variables) {
  return spawnSync('bash', [deployScript], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...variables },
  });
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

test('dry run does not call Stellar CLI or create output files', () => {
  const { root, bin, calls } = fixture();
  const result = run(root, bin, { DRY_RUN: 'true', NETWORK: 'testnet', SOURCE: 'deployer' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY RUN: would deploy WASM/);
  assert.equal(existsSync(calls), false);
  assert.equal(existsSync(join(root, '.docker-output')), false);
});

test('retry with a recorded contract ID restores output without redeploying', () => {
  const { root, bin, calls } = fixture();
  const contractId = 'CA_RECORDED_CONTRACT_ID';
  const result = run(root, bin, { EXISTING_CONTRACT_ID: contractId });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(root, '.docker-output', 'contract-id.txt'), 'utf8').trim(),
    contractId
  );
  assert.doesNotMatch(readFileSync(calls, 'utf8'), /contract deploy/);
});

test('fails closed instead of writing a placeholder contract ID (#1242)', () => {
  const root = mkdtempSync(join(tmpdir(), 'iln-deployer-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);

  const result = run(root, bin, {});

  assert.equal(result.status, 1);
  assert.match(result.stderr, /no built WASM found/);
  assert.match(result.stderr, /cargo build --target wasm32v1-none --release/);
  // The regression this guards: a placeholder must never reach downstream suites.
  assert.equal(existsSync(join(root, '.docker-output', 'contract-id.txt')), false);
});
