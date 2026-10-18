import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fileProvenance,
  summarizeResults,
  evaluateEvidence,
  buildEvidenceBundle,
} from '../build-e2e-evidence-bundle.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = () => '2026-10-16T00:00:00.000Z';

function vitestReport({ passed = 2, failed = 0, skipped = 0, success = true } = {}) {
  const assertions = [
    ...Array.from({ length: passed }, (_, i) => ({ title: `passes ${i}`, status: 'passed' })),
    ...Array.from({ length: failed }, (_, i) => ({ title: `fails ${i}`, status: 'failed' })),
    ...Array.from({ length: skipped }, (_, i) => ({ title: `skips ${i}`, status: 'skipped' })),
  ];
  return {
    success,
    numTotalTestSuites: 1,
    numTotalTests: assertions.length,
    numPassedTests: passed,
    numFailedTests: failed,
    numPendingTests: skipped,
    numTodoTests: 0,
    testResults: [
      {
        name: join(REPO_ROOT, 'tests/e2e/lifecycle.test.ts'),
        status: failed > 0 ? 'failed' : 'passed',
        assertionResults: assertions,
      },
    ],
  };
}

function ownership(asOf = '2026-10-16') {
  return {
    control: 'e2e-environment-ownership',
    owners: { primary: 'release-engineering', secondary: 'x', escalation: 'y' },
    rotation: {
      interval_days: 90,
      min_remaining_days: 14,
      credentials: [
        {
          name: 'deployer',
          location: 'secret E2E_DEPLOYER_SECRET_KEY',
          rotation_days: 90,
          last_rotated: '2026-10-01',
          next_rotation_due: '2026-12-30',
        },
      ],
    },
    runbook: 'docs/runbooks/e2e-environment-ownership.md',
    __asOf: asOf,
  };
}

function build(overrides = {}) {
  const { asOf = '2026-10-16', ...rest } = overrides;
  return buildEvidenceBundle({
    results: vitestReport(),
    ownership: ownership(asOf),
    ownershipOptions: { asOf, rootDir: REPO_ROOT },
    gate: { ran: true, exit_code: 0 },
    rpcWait: { attempts: 2, ready: true },
    metadata: { commit: 'abc123', run_id: '42' },
    provenance: [],
    now: NOW,
    rootDir: REPO_ROOT,
    ...rest,
  });
}

describe('summarizeResults', () => {
  it('normalises a vitest JSON report', () => {
    const summary = summarizeResults(vitestReport({ passed: 3, failed: 1, skipped: 2 }), REPO_ROOT);

    assert.equal(summary.total_tests, 6);
    assert.equal(summary.passed, 3);
    assert.equal(summary.failed, 1);
    assert.equal(summary.skipped, 2);
    assert.equal(summary.suites.length, 1);
    assert.equal(summary.suites[0].name, 'tests/e2e/lifecycle.test.ts');
    assert.equal(summary.suites[0].failed, 1);
  });

  it('returns null for a missing report', () => {
    assert.equal(summarizeResults(undefined), null);
    assert.equal(summarizeResults(null), null);
  });
});

describe('evaluateEvidence', () => {
  const greenSummary = summarizeResults(vitestReport(), REPO_ROOT);
  const greenGate = { ran: true, exit_code: 0 };

  it('accepts a fully green run', () => {
    const result = evaluateEvidence({ summary: greenSummary, gate: greenGate, rpcWait: { ready: true } });
    assert.equal(result.ok, true, JSON.stringify(result.violations));
  });

  it('flags skipped tests (the control was bypassed)', () => {
    const summary = summarizeResults(vitestReport({ skipped: 1 }), REPO_ROOT);
    const result = evaluateEvidence({ summary, gate: { ran: true, exit_code: 0 } });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.code === 'skipped-tests'));
  });

  it('flags failed tests, an unrun gate and an unready RPC', () => {
    const result = evaluateEvidence({
      summary: summarizeResults(vitestReport({ failed: 1, success: false }), REPO_ROOT),
      gate: { ran: false, exit_code: 0 },
      rpcWait: { attempts: 60, ready: false },
    });

    const codes = result.violations.map((v) => v.code);
    assert.ok(codes.includes('failed-tests'));
    assert.ok(codes.includes('unsuccessful-report'));
    assert.ok(codes.includes('coverage-gate-not-run'));
    assert.ok(codes.includes('rpc-not-ready'));
  });

  it('flags a missing report and zero tests', () => {
    assert.ok(
      evaluateEvidence({ summary: null, gate: { ran: true, exit_code: 0 } }).violations.some(
        (v) => v.code === 'missing-results'
      )
    );
    assert.ok(
      evaluateEvidence({
        summary: summarizeResults({ ...vitestReport(), numTotalTests: 0, numPassedTests: 0 }),
        gate: { ran: true, exit_code: 0 },
      }).violations.some((v) => v.code === 'no-tests')
    );
  });
});

describe('buildEvidenceBundle', () => {
  it('produces a complete, provenance-stamped bundle for a green run', () => {
    const result = build();

    assert.equal(result.ok, true, JSON.stringify(result.violations));
    assert.equal(result.bundle.schema_version, 1);
    assert.equal(result.bundle.control, 'e2e-release-evidence');
    assert.equal(result.bundle.generated_at, '2026-10-16T00:00:00.000Z');
    assert.equal(result.bundle.metadata.commit, 'abc123');
    assert.equal(result.bundle.results.skipped, 0);
    assert.equal(result.bundle.environment_ownership.owner, 'release-engineering');
    assert.equal(result.bundle.rpc_wait.attempts, 2);
    assert.equal(result.bundle.verdict.ok, true);
  });

  it('records an overdue environment rotation as a violation', () => {
    const result = build({ asOf: '2027-01-15' });

    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.code === 'environment-ownership-failed'));
  });

  it('records a non-zero coverage gate as a violation', () => {
    const result = build({ gate: { ran: true, exit_code: 1 } });

    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.code === 'coverage-gate-failed'));
  });

  it('records missing results as a violation', () => {
    const result = build({ results: undefined });

    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.code === 'missing-results'));
  });
});

describe('fileProvenance', () => {
  it('returns a stable sha256 and size for an existing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-bundle-'));
    try {
      const file = join(dir, 'results.json');
      writeFileSync(file, '{"ok":true}');
      const provenance = fileProvenance(file, dir);

      assert.equal(provenance.bytes, 11);
      assert.match(provenance.sha256, /^[0-9a-f]{64}$/);

      assert.equal(fileProvenance(join(dir, 'missing.json'), dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
