import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkSdkClientDrift,
  computeSpecHash,
  REQUIRED_CONTRACT_ERRORS,
} from '../check-sdk-client-drift.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../check-sdk-client-drift.mjs');
const REPO_ROOT = resolve(dirname(SCRIPT), '..');

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function scaffoldHealthyGeneratedTypes(root, options = {}) {
  const specContent = JSON.stringify([{ type: 'SCSpecEntryUDTErrorEnumV0', name: 'ContractError' }]);
  const specHash = computeSpecHash(specContent);

  if (options.withSpec) {
    write(root, 'backend/target/spec.json', specContent);
  }

  write(
    root,
    'sdk/src/generated/types.ts',
    `// !! AUTO-GENERATED — do not edit by hand.\n` +
      `// Re-generate with: pnpm generate:types\n` +
      `// Source: backend/target/spec.json\n` +
      `// Spec hash: ${specHash}\n\n` +
      `export enum ContractError {\n` +
      `  InvoiceNotFound = 1,\n` +
      `  AlreadyFunded = 2,\n` +
      `  AlreadyPaid = 3,\n` +
      `  NotFunder = 4,\n` +
      `  NotPayer = 5,\n` +
      `  NotDueYet = 6,\n` +
      `  InvalidAmount = 7,\n` +
      `  InvalidDiscount = 8,\n` +
      `  InvalidDueDate = 9,\n` +
      `  Unauthorized = 10,\n` +
      `}\n`
  );

  write(root, 'sdk/src/index.ts', `export { ContractError } from './generated/types';\n`);
}

function runCli(root, ...args) {
  return spawnSync(process.execPath, [SCRIPT, `--root=${root}`, ...args], { encoding: 'utf8' });
}

let testRoot;
beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'client-drift-'));
  scaffoldHealthyGeneratedTypes(testRoot, { withSpec: true });
});
afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('success', () => {
  it('passes a healthy workspace with aligned generated types and contract spec', () => {
    const report = checkSdkClientDrift(testRoot);
    assert.deepEqual(report.findings, []);
    assert.equal(report.summary.ok, true);
  });

  it('exits 0 from CLI and writes report JSON', () => {
    const out = join(testRoot, 'drift-report.json');
    const res = runCli(testRoot, `--json=${out}`);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /\[sdk-client-drift\] OK/);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(report.summary.total, 0);
    assert.equal(report.summary.ok, true);
  });

  it('the repository generated types pass drift checks (regression guard for #1209)', () => {
    const report = checkSdkClientDrift(REPO_ROOT);
    assert.deepEqual(
      report.findings.map((f) => `${f.rule} ${f.file}: ${f.message}`),
      []
    );
    assert.equal(report.summary.ok, true);
  });
});

describe('failure', () => {
  it('flags missing generated types file', () => {
    rmSync(join(testRoot, 'sdk/src/generated/types.ts'));
    const report = checkSdkClientDrift(testRoot);
    const rules = report.findings.map((f) => f.rule);
    assert.ok(rules.includes('generated-file-exists'));
  });

  it('flags missing autogen header', () => {
    write(
      testRoot,
      'sdk/src/generated/types.ts',
      `export enum ContractError { InvoiceNotFound = 1 }\n`
    );
    const report = checkSdkClientDrift(testRoot);
    const rules = report.findings.map((f) => f.rule);
    assert.ok(rules.includes('autogen-header'));
  });

  it('flags spec hash drift when spec.json changed without regenerating types', () => {
    write(testRoot, 'backend/target/spec.json', JSON.stringify({ changed: 'new-abi-spec' }));
    const report = checkSdkClientDrift(testRoot);
    const rules = report.findings.map((f) => f.rule);
    assert.ok(rules.includes('spec-hash-integrity'));
  });

  it('flags missing ContractError enum or missing error cases', () => {
    write(
      testRoot,
      'sdk/src/generated/types.ts',
      `// !! AUTO-GENERATED\nexport enum ContractError {\n  InvoiceNotFound = 1,\n}\n`
    );
    const report = checkSdkClientDrift(testRoot);
    const rules = report.findings.map((f) => f.rule);
    assert.ok(rules.includes('contract-error-contract'));
  });

  it('flags missing ContractError export in sdk/src/index.ts', () => {
    write(testRoot, 'sdk/src/index.ts', `export const OTHER = 1;\n`);
    const report = checkSdkClientDrift(testRoot);
    const rules = report.findings.map((f) => f.rule);
    assert.ok(rules.includes('sdk-export-contract'));
  });

  it('exits 1 from CLI on drift detection failure', () => {
    rmSync(join(testRoot, 'sdk/src/generated/types.ts'));
    const res = runCli(testRoot);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /FAILED/);
  });
});

describe('replay / restart', () => {
  it('produces an identical drift report on repeated executions', () => {
    const report1 = checkSdkClientDrift(testRoot);
    const report2 = checkSdkClientDrift(testRoot);
    assert.deepEqual(report1.findings, report2.findings);
    assert.equal(report1.summary.total, report2.summary.total);
  });

  it('recovers cleanly after types are regenerated', () => {
    write(testRoot, 'backend/target/spec.json', JSON.stringify({ changed: true }));
    let report = checkSdkClientDrift(testRoot);
    assert.equal(report.summary.ok, false);

    // Regenerate / re-sync types
    scaffoldHealthyGeneratedTypes(testRoot, { withSpec: true });
    report = checkSdkClientDrift(testRoot);
    assert.equal(report.summary.ok, true);
    assert.deepEqual(report.findings, []);
  });
});

describe('boundary conditions', () => {
  it('tolerates absent backend/target/spec.json gracefully when submodule unbuilt', () => {
    rmSync(join(testRoot, 'backend'), { recursive: true, force: true });
    const report = checkSdkClientDrift(testRoot);
    assert.deepEqual(report.findings, []);
    assert.equal(report.summary.ok, true);
  });

  it('verifies all 10 canonical contract errors are checked', () => {
    assert.equal(REQUIRED_CONTRACT_ERRORS.length, 10);
    assert.ok(REQUIRED_CONTRACT_ERRORS.includes('Unauthorized'));
    assert.ok(REQUIRED_CONTRACT_ERRORS.includes('InvoiceNotFound'));
  });
});
