import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateCoverage,
  findPlaceholderContractIds,
  REQUIRED_E2E_FILES,
  resolveSkipBudget,
  buildEvidence,
} from '../check-e2e-coverage.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function file(relative, tests) {
  return {
    name: `${REPO_ROOT}/${relative}`,
    assertionResults: tests.map(([title, status]) => ({
      ancestorTitles: [relative.replace('tests/e2e/', '').replace('.test.ts', '')],
      title,
      status,
    })),
  };
}

function report(spec) {
  return {
    success: true,
    testResults: Object.entries(spec).map(([relative, tests]) => file(relative, tests)),
  };
}

/** Every required E2E file executes at least one test. */
function greenSpec() {
  return Object.fromEntries(
    REQUIRED_E2E_FILES.map((relative) => [
      relative,
      [
        ['runs a scenario', 'passed'],
        ['runs a failure scenario', 'passed'],
      ],
    ])
  );
}

describe('evaluateCoverage — success path', () => {
  it('passes when every required file ran real tests and nothing was skipped', () => {
    const verdict = evaluateCoverage(report(greenSpec()), { repoRoot: REPO_ROOT });

    assert.equal(verdict.ok, true, JSON.stringify(verdict.violations));
    assert.deepEqual(verdict.violations, []);
    assert.equal(verdict.summary.skipped, 0);
    assert.equal(verdict.summary.files, REQUIRED_E2E_FILES.length);
    assert.ok(verdict.summary.tests > 0);
  });

  it('accepts absolute report paths when no repo root is given', () => {
    const verdict = evaluateCoverage(report(greenSpec()));
    assert.equal(verdict.ok, true, JSON.stringify(verdict.violations));
  });

  it('honours an explicit skip budget for non-release runs', () => {
    const spec = greenSpec();
    spec['tests/e2e/lifecycle.test.ts'].push(['deferred scenario', 'pending']);

    assert.equal(evaluateCoverage(report(spec), { repoRoot: REPO_ROOT, allowSkips: 0 }).ok, false);
    assert.equal(evaluateCoverage(report(spec), { repoRoot: REPO_ROOT, allowSkips: 1 }).ok, true);
  });
});

describe('resolveSkipBudget — protected branches (#1246)', () => {
  const config = {
    protectedBranches: ['main', 'dev'],
    budgets: { main: 0, dev: 1 },
    defaultBudget: 2,
  };

  it('loads the explicit budget for every protected branch', () => {
    assert.deepEqual(resolveSkipBudget(config, 'refs/heads/main'), {
      branch: 'main',
      budget: 0,
      protected: true,
    });
    assert.deepEqual(resolveSkipBudget(config, 'dev'), {
      branch: 'dev',
      budget: 1,
      protected: true,
    });
  });

  it('fails closed when a newly protected branch has no budget', () => {
    assert.throws(
      () =>
        resolveSkipBudget(
          { ...config, protectedBranches: [...config.protectedBranches, 'release'] },
          'release'
        ),
      /has no explicit skip budget/
    );
  });

  it('uses the default budget for an unprotected replay branch', () => {
    assert.deepEqual(resolveSkipBudget(config, 'feature/replay'), {
      branch: 'feature/replay',
      budget: 2,
      protected: false,
    });
  });

  it('rejects the invalid negative-budget boundary', () => {
    assert.throws(
      () => resolveSkipBudget({ ...config, budgets: { main: -1 } }, 'main'),
      /non-negative integer/
    );
  });
});

describe('buildEvidence — skipped reasons artifact (#1247)', () => {
  it('captures reporter reasons and prerequisite recovery records', () => {
    const spec = greenSpec();
    const raw = report(spec);
    raw.testResults[0].assertionResults[0].status = 'pending';
    raw.testResults[0].assertionResults[0].skipReason = 'RPC restart rehearsal';
    const verdict = evaluateCoverage(raw, { repoRoot: REPO_ROOT, allowSkips: 1 });
    verdict.policy = { branch: 'local', budget: 1, protected: false };
    verdict.files = raw.testResults.map((entry) => ({
      file: entry.name,
      relative: entry.name.slice(REPO_ROOT.length + 1),
      skipped: entry.assertionResults
        .filter((test) => test.status === 'pending')
        .map((test) => ({ name: test.title, reason: test.skipReason })),
    }));
    const evidence = buildEvidence(verdict, [
      { prerequisite: 'stellar rpc', reason: 'connection reset' },
    ]);
    assert.equal(evidence.skippedTests[0].reason, 'RPC restart rehearsal');
    assert.equal(evidence.recordedReasons[0].reason, 'connection reset');
    assert.equal(evidence.owner, 'release engineering');
  });

  it('preserves a null reason at the missing-reason boundary instead of inventing one', () => {
    const evidence = buildEvidence({
      ok: false,
      policy: {},
      summary: {},
      violations: [],
      files: [{ relative: 'x.test.ts', skipped: [{ name: 'x' }] }],
    });
    assert.equal(evidence.skippedTests[0].reason, null);
  });
});

describe('evaluateCoverage — the skip regression this gate exists for (#1243)', () => {
  it('fails when the old RPC-unavailable skip returns', () => {
    const spec = greenSpec();
    spec['tests/e2e/lifecycle.test.ts'] = [
      ['submit invoice via SDK creates a pending invoice', 'pending'],
      ['fund invoice via SDK transfers tokens to escrow', 'pending'],
    ];

    const verdict = evaluateCoverage(report(spec), { repoRoot: REPO_ROOT });

    assert.equal(verdict.ok, false);
    const skipViolation = verdict.violations.find((v) => v.code === 'skipped-tests');
    assert.ok(skipViolation, JSON.stringify(verdict.violations));
    assert.equal(skipViolation.detail.includes('2 skipped'), true);
    assert.match(skipViolation.tests[0].file, /lifecycle\.test\.ts$/);
    assert.equal(verdict.summary.skipped, 2);
  });

  it('fails on a single skipped test — the boundary is zero, not a threshold', () => {
    const spec = greenSpec();
    spec['tests/e2e/governance.test.ts'].push(['propose → vote', 'pending']);

    const verdict = evaluateCoverage(report(spec), { repoRoot: REPO_ROOT });
    assert.equal(verdict.ok, false);
    const skipViolation = verdict.violations.find((v) => v.code === 'skipped-tests');
    assert.ok(skipViolation, JSON.stringify(verdict.violations));
    assert.equal(skipViolation.tests[0].file, 'tests/e2e/governance.test.ts');
    assert.equal(verdict.summary.skipped, 1);
  });

  it('fails when the E2E_ALLOW_SKIP escape hatch is set on a release run', () => {
    const verdict = evaluateCoverage(report(greenSpec()), {
      repoRoot: REPO_ROOT,
      skipEscapeHatchSet: true,
    });

    assert.equal(verdict.ok, false);
    assert.equal(
      verdict.violations.some((v) => v.code === 'skip-escape-hatch'),
      true
    );
  });

  it('allows the escape hatch only where it is explicitly permitted (local runs)', () => {
    const verdict = evaluateCoverage(report(greenSpec()), {
      repoRoot: REPO_ROOT,
      skipEscapeHatchSet: true,
      allowSkipEscapeHatch: true,
    });
    assert.equal(verdict.ok, true);
  });

  it('fails when the run itself was not successful (the old `|| true` defect)', () => {
    const verdict = evaluateCoverage(
      { ...report(greenSpec()), success: false },
      {
        repoRoot: REPO_ROOT,
      }
    );
    assert.equal(verdict.ok, false);
    assert.equal(
      verdict.violations.some((v) => v.code === 'suite-not-successful'),
      true
    );
  });
});

describe('evaluateCoverage — coverage boundaries', () => {
  it('fails when a required E2E file stopped running entirely', () => {
    const spec = greenSpec();
    delete spec['tests/e2e/disaster-recovery.test.ts'];

    const verdict = evaluateCoverage(report(spec), { repoRoot: REPO_ROOT });
    assert.equal(verdict.ok, false);
    assert.equal(
      verdict.violations.some((v) => v.code === 'missing-file'),
      true
    );
  });

  it('fails when a required file runs but collects zero tests', () => {
    const spec = greenSpec();
    spec['tests/e2e/multi-token.test.ts'] = [];

    const verdict = evaluateCoverage(report(spec), { repoRoot: REPO_ROOT });
    assert.equal(verdict.ok, false);
    assert.equal(
      verdict.violations.some((v) => v.code === 'empty-file'),
      true
    );
  });

  it('fails closed on an empty or unparseable report', () => {
    const verdict = evaluateCoverage({ testResults: [] }, { repoRoot: REPO_ROOT });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.summary.tests, 0);
    assert.equal(verdict.violations.length >= REQUIRED_E2E_FILES.length, true);
  });

  it('matches required files whether the report uses absolute or relative paths', () => {
    const verdict = evaluateCoverage(
      {
        success: true,
        testResults: REQUIRED_E2E_FILES.map((relative) => ({
          name: relative,
          assertionResults: [{ ancestorTitles: ['x'], title: 'runs', status: 'passed' }],
        })),
      },
      {}
    );
    assert.equal(verdict.ok, true, JSON.stringify(verdict.violations));
  });

  it('does not double-count a skipped test as both a global and per-file violation budget', () => {
    const spec = greenSpec();
    spec['tests/e2e/multi-token.test.ts'].push(['a', 'pending'], ['b', 'pending']);

    const verdict = evaluateCoverage(report(spec), { repoRoot: REPO_ROOT });
    const global = verdict.violations.find((v) => v.code === 'skipped-tests');
    assert.equal(global.detail.startsWith('2 skipped'), true);
    assert.equal(verdict.summary.skipped, 2);
  });
});
describe('findPlaceholderContractIds — source regression guard for #1242', () => {
  function sandbox() {
    const root = mkdtempSync(join(tmpdir(), 'iln-placeholder-scan-'));
    mkdirSync(join(root, 'tests', 'e2e'), { recursive: true });
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    return root;
  }

  it('flags a reintroduced placeholder in the E2E suite', () => {
    const root = sandbox();
    try {
      writeFileSync(
        join(root, 'tests', 'e2e', 'lifecycle.test.ts'),
        "const contractId = process.env.CONTRACT_ID ?? 'C_DEPLOYED_CONTRACT_ID';\n"
      );

      const findings = findPlaceholderContractIds(['tests/e2e'], root);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].file, 'tests/e2e/lifecycle.test.ts');
      assert.equal(findings[0].line, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags a placeholder reintroduced into an E2E workflow', () => {
    const root = sandbox();
    try {
      writeFileSync(
        join(root, '.github', 'workflows', 'e2e.yml'),
        "          CONTRACT_ID: ${{ env.CONTRACT_ID || 'C_DEPLOYED_CONTRACT_ID' }}\n"
      );

      const findings = findPlaceholderContractIds(['.github/workflows'], root);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].file, '.github/workflows/e2e.yml');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags the dummy contract id written by the deployer', () => {
    const root = sandbox();
    mkdirSync(join(root, 'contract-deployer'), { recursive: true });
    try {
      writeFileSync(
        join(root, 'contract-deployer', 'deploy.sh'),
        'echo "dummy-contract-id-for-local-dev" > .docker-output/contract-id.txt\n'
      );

      assert.equal(findPlaceholderContractIds(['contract-deployer'], root).length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not flag comments, docs, or the guard pattern table itself', () => {
    const root = sandbox();
    mkdirSync(join(root, 'tests', 'e2e', 'support'), { recursive: true });
    try {
      writeFileSync(
        join(root, 'tests', 'e2e', 'support', 'e2e-prerequisites.ts'),
        [
          '// the old default was C_DEPLOYED_CONTRACT_ID and is now rejected',
          '/^C_DEPLOYED_CONTRACT_ID$/,',
          "throw new Error('placeholder');",
        ].join('\n')
      );

      assert.deepEqual(findPlaceholderContractIds(['tests/e2e'], root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes on the real repository sources', () => {
    assert.deepEqual(
      findPlaceholderContractIds(
        ['tests/e2e', '.github/workflows', 'contract-deployer'],
        REPO_ROOT
      ),
      []
    );
  });
});
