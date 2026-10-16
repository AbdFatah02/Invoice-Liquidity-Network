import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkExampleSdkResolution,
  CANONICAL_SDK_NAME,
  REQUIRED_EXPORTS,
} from '../check-example-sdk-resolution.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../check-example-sdk-resolution.mjs'
);
const REPO_ROOT = resolve(dirname(SCRIPT), '..');

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function scaffoldHealthyWorkspace(root) {
  write(root, 'sdk/package.json', {
    name: '@iln/sdk',
    version: '0.1.0',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.mjs',
        require: './dist/index.cjs',
      },
      './legacy': {
        types: './dist/legacy-imports.d.ts',
        import: './dist/legacy-imports.mjs',
        require: './dist/legacy-imports.cjs',
      },
    },
  });
  write(
    root,
    'sdk/src/index.ts',
    `export class ILNSdk {}\nexport const ILN_TESTNET = {};\nexport function createKeypairSigner() {}\nexport const SDK_VERSION = '0.1.0';\nexport enum ContractError {}\n`
  );
  write(root, 'examples/javascript-example/package.json', {
    name: 'iln-javascript-example',
    version: '1.0.0',
    dependencies: {
      '@iln/sdk': 'file:../../sdk',
    },
  });
  write(root, 'examples/javascript-example/index.js', `const { ILNSdk } = require('@iln/sdk');\n`);
  write(root, 'examples/lp-automation/package.json', {
    name: 'lp-automation',
    version: '1.0.0',
    dependencies: {
      '@iln/sdk': 'file:../../sdk',
    },
  });
}

function runCli(root, ...args) {
  return spawnSync(process.execPath, [SCRIPT, `--root=${root}`, ...args], { encoding: 'utf8' });
}

let testRoot;
beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'example-sdk-res-'));
  scaffoldHealthyWorkspace(testRoot);
});
afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('success', () => {
  it('passes a healthy workspace with canonical SDK resolution in examples', () => {
    const report = checkExampleSdkResolution(testRoot);
    assert.deepEqual(report.findings, []);
    assert.equal(report.summary.ok, true);
  });

  it('exits 0 from the CLI and writes a structured JSON report', () => {
    const out = join(testRoot, 'report.json');
    const res = runCli(testRoot, `--json=${out}`);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /\[example-sdk-resolution\] OK/);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(report.summary.total, 0);
    assert.equal(report.summary.ok, true);
  });

  it('passes against the actual repository (regression guard for #1214)', () => {
    const report = checkExampleSdkResolution(REPO_ROOT);
    assert.deepEqual(
      report.findings.map((f) => `${f.rule} ${f.file}: ${f.message}`),
      []
    );
    assert.equal(report.summary.ok, true);
  });
});

describe('failure', () => {
  it('flags an example that declares a legacy SDK name', () => {
    write(testRoot, 'examples/javascript-example/package.json', {
      name: 'iln-javascript-example',
      dependencies: {
        '@invoice-liquidity/sdk': 'file:../../sdk', // sdk-name-check: allow-legacy
      },
    });
    const report = checkExampleSdkResolution(testRoot);
    const rules = report.findings.map((f) => f.rule);
    assert.ok(rules.includes('example-dependency'));
  });

  it('flags an invalid resolution path that points to a non-existent directory', () => {
    write(testRoot, 'examples/javascript-example/package.json', {
      name: 'iln-javascript-example',
      dependencies: {
        '@iln/sdk': 'file:../../non-existent-sdk',
      },
    });
    const report = checkExampleSdkResolution(testRoot);
    const rules = report.findings.map((f) => f.rule);
    assert.ok(rules.includes('resolution-path'));
  });

  it('flags a resolution path pointing to the wrong package manifest', () => {
    write(testRoot, 'other-lib/package.json', { name: '@iln/other', version: '0.1.0' });
    write(testRoot, 'examples/javascript-example/package.json', {
      name: 'iln-javascript-example',
      dependencies: {
        '@iln/sdk': 'file:../../other-lib',
      },
    });
    const report = checkExampleSdkResolution(testRoot);
    const rules = report.findings.map((f) => f.rule);
    assert.ok(rules.includes('resolution-path'));
  });

  it('flags missing required symbol in SDK exports', () => {
    write(testRoot, 'sdk/src/index.ts', `export const SDK_VERSION = '0.1.0';\n`);
    const report = checkExampleSdkResolution(testRoot);
    const rules = report.findings.map((f) => f.rule);
    assert.ok(rules.includes('symbol-contract'));
  });

  it('exits 1 from CLI when a violation is present', () => {
    write(testRoot, 'examples/javascript-example/package.json', {
      name: 'iln-javascript-example',
      dependencies: {
        '@iln/sdk': 'file:../../bad-path',
      },
    });
    const res = runCli(testRoot);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /FAILED/);
  });
});

describe('replay / restart', () => {
  it('produces an identical report on repeated runs over the same workspace', () => {
    const reportA = checkExampleSdkResolution(testRoot);
    const reportB = checkExampleSdkResolution(testRoot);
    assert.deepEqual(reportA.findings, reportB.findings);
    assert.equal(reportA.summary.total, reportB.summary.total);
  });

  it('cleans up and recovers when broken configuration is corrected', () => {
    write(testRoot, 'examples/javascript-example/package.json', {
      name: 'iln-javascript-example',
      dependencies: { '@iln/sdk': 'file:../../bad' },
    });
    let report = checkExampleSdkResolution(testRoot);
    assert.equal(report.summary.ok, false);

    // Fix path
    write(testRoot, 'examples/javascript-example/package.json', {
      name: 'iln-javascript-example',
      dependencies: { '@iln/sdk': 'file:../../sdk' },
    });
    report = checkExampleSdkResolution(testRoot);
    assert.equal(report.summary.ok, true);
    assert.deepEqual(report.findings, []);
  });
});

describe('boundary conditions', () => {
  it('tolerates an empty examples directory gracefully', () => {
    rmSync(join(testRoot, 'examples'), { recursive: true, force: true });
    mkdirSync(join(testRoot, 'examples'), { recursive: true });
    const report = checkExampleSdkResolution(testRoot);
    assert.deepEqual(report.findings, []);
    assert.equal(report.summary.ok, true);
  });

  it('ignores examples without any SDK dependency or script', () => {
    write(testRoot, 'examples/unrelated/package.json', {
      name: 'unrelated',
      dependencies: { lodash: '^4.17.21' },
    });
    const report = checkExampleSdkResolution(testRoot);
    assert.deepEqual(report.findings, []);
    assert.equal(report.summary.ok, true);
  });

  it('verifies all expected canonical exports are recognized', () => {
    assert.equal(CANONICAL_SDK_NAME, '@iln/sdk');
    assert.deepEqual(REQUIRED_EXPORTS, [
      'ILNSdk',
      'ILN_TESTNET',
      'createKeypairSigner',
      'SDK_VERSION',
    ]);
  });
});
