#!/usr/bin/env node
/**
 * check-e2e-coverage.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Release gate proving the cross-package E2E suite actually executed (#1243).
 *
 * Audit finding: `.github/workflows/e2e.yml` guarded releases with
 *
 *   output=$(pnpm test:e2e 2>&1 || true)
 *   skip_count=$(echo "$output" | grep -o "[0-9]* skipped" | head -1 ...)
 *
 * Three defects made that control inert:
 *   1. the vitest reporter never emits `"<n> skipped"` in that shape, so
 *      `skip_count` was always `0` and the check could never fail;
 *   2. `|| true` swallowed the suite's exit code, so a red run read as green;
 *   3. it re-ran the whole suite instead of inspecting the run CI already did.
 *
 * This gate consumes the machine-readable vitest JSON report from the real run
 * and fails closed:
 *   - any skipped test in the E2E suite is a failure (invariant I1/#1244: an
 *     unreachable dependency must be an actionable failure, never a skip);
 *   - any expected E2E file that produced zero tests is a failure (a file that
 *     silently stopped running is a regression, not a pass);
 *   - `E2E_ALLOW_SKIP=1` in the environment is itself a failure on release
 *     branches, so the local escape hatch cannot green a release;
 *   - the suite must report a success state.
 *
 * Usage:
 *   node scripts/check-e2e-coverage.mjs --report=.artifacts/e2e-results.json
 *   node scripts/check-e2e-coverage.mjs --report=... --allow-skips=0
 *   node scripts/check-e2e-coverage.mjs --report=... --json  # machine-readable verdict
 *
 * Exit codes: 0 gate passed, 1 gate failed (regression detected), 2 usage error.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

/** Files that must contribute executed tests to every E2E run. */
export const REQUIRED_E2E_FILES = [
  'tests/e2e/lifecycle.test.ts',
  'tests/e2e/disaster-recovery.test.ts',
  'tests/e2e/multi-token.test.ts',
  'tests/e2e/governance.test.ts',
  'tests/e2e/prerequisites.test.ts',
];

function normalizeReport(report) {
  const testResults = Array.isArray(report?.testResults) ? report.testResults : [];
  return testResults.map((file) => {
    const name = String(file.name ?? file.testFilePath ?? 'unknown').replace(/\\/g, '/');
    const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    const tests = assertions.map((assertion) => ({
      name: [assertion.ancestorTitles, assertion.title].filter(Boolean).join(' > '),
      status: assertion.status,
      reason:
        assertion.skipReason ??
        assertion.meta?.skipReason ??
        (Array.isArray(assertion.failureMessages) ? assertion.failureMessages[0] : undefined),
    }));
    return {
      file: name,
      status: file.status,
      // Collection/hook failures (e.g. the fail-closed prerequisite error) live on
      // the file result, not on an assertion, and are what an operator needs to see.
      error: typeof file.message === 'string' ? file.message.trim() : undefined,
      tests,
      skipped: tests.filter((test) => test.status === 'pending' || test.status === 'skipped'),
      passed: tests.filter((test) => test.status === 'passed'),
      failed: tests.filter((test) => test.status === 'failed'),
    };
  });
}

/** Source roots scanned for placeholder contract IDs (#1242). */
export const PLACEHOLDER_SCAN_ROOTS = ['tests/e2e', '.github/workflows', 'contract-deployer'];
export const PLACEHOLDER_SOURCE_PATTERNS = [
  /C_DEPLOYED_CONTRACT_ID/,
  /C_MOCK_CONTRACT_ID_REPLACE_ME/,
  /C_[A-Z0-9_]*REPLACE_ME/,
  /C_[A-Z]+_CONTRACT_ID\b/,
  /dummy-contract-id/,
];
/**
 * Files that legitimately name the rejected placeholders: the guard's own
 * pattern table and the regression tests that assert they are rejected.
 */
export const PLACEHOLDER_SCAN_ALLOWLIST = [
  'tests/e2e/support/e2e-prerequisites.ts',
  'tests/e2e/prerequisites.test.ts',
  'scripts/check-e2e-coverage.mjs',
  'scripts/provision-e2e-contract.mjs',
];
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.yml', '.yaml', '.sh']);

function collectSourceFiles(root) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root)) {
    const full = resolve(root, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) out.push(...collectSourceFiles(full));
    else if (SCANNED_EXTENSIONS.has(extname(entry))) out.push(full);
  }
  return out;
}

/**
 * Source-level regression check for #1242: no E2E/workflow/deployer file may
 * reference a placeholder contract ID, so one cannot be reintroduced by a later
 * change (or by a "just this once" merge).
 *
 * Comments and the guard's own pattern literals are ignored — only executable
 * usage counts.
 */
export function findPlaceholderContractIds(roots, cwd = process.cwd()) {
  const findings = [];
  const seen = new Set();

  for (const root of roots) {
    for (const file of collectSourceFiles(resolve(cwd, root))) {
      const relative = file.slice(cwd.length + 1);
      if (PLACEHOLDER_SCAN_ALLOWLIST.includes(relative)) continue;

      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const trimmed = line.trim();
          // Documentation of the finding, not a use of the placeholder.
          if (
            trimmed.startsWith('//') ||
            trimmed.startsWith('#') ||
            trimmed.startsWith('*') ||
            trimmed.startsWith('/^C_')
          ) {
            return;
          }

          for (const pattern of PLACEHOLDER_SOURCE_PATTERNS) {
            if (!pattern.test(trimmed)) continue;
            const key = `${relative}:${index + 1}:${trimmed}`;
            if (seen.has(key)) continue;
            seen.add(key);
            findings.push({ file: relative, line: index + 1, match: trimmed });
          }
        });
    }
  }

  return findings;
}

function relativeToRepo(file, repoRoot) {
  if (!repoRoot) return file;
  const normalizedRoot = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`;
  return file.startsWith(normalizedRoot) ? file.slice(normalizedRoot.length) : file;
}

/**
 * Evaluate the gate. Pure so it can be unit-tested for success, failure,
 * restart/replay and boundary conditions.
 */
export function evaluateCoverage(report, options = {}) {
  const {
    allowSkips = 0,
    requiredFiles = REQUIRED_E2E_FILES,
    repoRoot = null,
    allowSkipEscapeHatch = false,
    skipEscapeHatchSet = false,
    success = report?.success !== false,
  } = options;

  const files = normalizeReport(report).map((file) => ({
    ...file,
    relative: relativeToRepo(file.file, repoRoot),
  }));

  const violations = [];

  if (!success) {
    violations.push({
      code: 'suite-not-successful',
      detail:
        'the vitest run reported a non-success state; the skip gate must inspect a green run, ' +
        'not a tolerated failure',
    });
  }

  const totalSkipped = files.reduce((sum, file) => sum + file.skipped.length, 0);
  if (totalSkipped > allowSkips) {
    violations.push({
      code: 'skipped-tests',
      detail: `${totalSkipped} skipped test(s) exceed the allowed budget of ${allowSkips}`,
      tests: files
        .filter((file) => file.skipped.length > 0)
        .map((file) => ({ file: file.relative, names: file.skipped.map((test) => test.name) })),
    });
  }

  // The first line of a file-level failure is usually the actionable prerequisite
  // message; surface it so the gate output alone is enough to act on.
  for (const file of files) {
    if (!file.error) continue;
    violations.push({
      code: 'file-error',
      detail: `${file.relative}: ${file.error.split('\n')[0]}`,
    });
  }

  for (const required of requiredFiles) {
    const match = files.find(
      (file) => file.relative.endsWith(required) || file.relative === required
    );
    if (!match) {
      violations.push({
        code: 'missing-file',
        detail: `${required} produced no test results; it must run on every E2E invocation`,
      });
      continue;
    }
    if (match.tests.length === 0) {
      violations.push({
        code: 'empty-file',
        detail: `${required} ran but collected zero tests`,
      });
    }
  }

  if (skipEscapeHatchSet && !allowSkipEscapeHatch) {
    violations.push({
      code: 'skip-escape-hatch',
      detail:
        'E2E_ALLOW_SKIP is set. The skip escape hatch is for local, non-release runs only and ' +
        'must never be present on a release branch.',
    });
  }

  const totalTests = files.reduce((sum, file) => sum + file.tests.length, 0);
  const totalPassed = files.reduce((sum, file) => sum + file.passed.length, 0);

  return {
    ok: violations.length === 0,
    violations,
    summary: {
      files: files.length,
      tests: totalTests,
      passed: totalPassed,
      skipped: totalSkipped,
      failed: files.reduce((sum, file) => sum + file.failed.length, 0),
    },
  };
}

/** Resolve the versioned budget, failing closed when a protected branch is omitted. */
export function resolveSkipBudget(config, branch) {
  if (
    !config ||
    !Array.isArray(config.protectedBranches) ||
    !config.budgets ||
    typeof config.budgets !== 'object'
  ) {
    throw new Error('skip budget config must define protectedBranches[] and budgets{}');
  }
  const normalized = String(branch || '').replace(/^refs\/heads\//, '');
  if (!normalized) throw new Error('branch is required to enforce protected-branch skip budgets');
  const protectedBranch = config.protectedBranches.includes(normalized);
  if (protectedBranch && !Object.hasOwn(config.budgets, normalized)) {
    throw new Error(`protected branch "${normalized}" has no explicit skip budget`);
  }
  const budget = Object.hasOwn(config.budgets, normalized)
    ? config.budgets[normalized]
    : config.defaultBudget;
  if (!Number.isInteger(budget) || budget < 0) {
    throw new Error(`skip budget for branch "${normalized}" must be a non-negative integer`);
  }
  return { branch: normalized, budget, protected: protectedBranch };
}

export function buildEvidence(verdict, recordedReasons = []) {
  return {
    control: 'e2e-skip-budget',
    owner: 'release engineering',
    recovery: 'docs/runbooks/e2e-prerequisites.md',
    generatedAt: new Date().toISOString(),
    policy: verdict.policy,
    summary: verdict.summary,
    ok: verdict.ok,
    violations: verdict.violations,
    skippedTests: verdict.files.flatMap((file) =>
      file.skipped.map((test) => ({
        file: file.relative,
        name: test.name,
        reason: test.reason ?? null,
      }))
    ),
    recordedReasons,
  };
}

function parseArgs(argv) {
  const options = {
    report: null,
    allowSkips: 0,
    json: false,
    allowSkipEscapeHatch: false,
    scanSources: false,
    sourceOnly: false,
    branch: null,
    budgets: null,
    evidence: null,
    skipReasons: null,
  };

  for (const arg of argv) {
    if (arg.startsWith('--report=')) options.report = arg.slice('--report='.length);
    else if (arg.startsWith('--branch=')) options.branch = arg.slice('--branch='.length);
    else if (arg.startsWith('--budgets=')) options.budgets = arg.slice('--budgets='.length);
    else if (arg.startsWith('--evidence=')) options.evidence = arg.slice('--evidence='.length);
    else if (arg.startsWith('--skip-reasons='))
      options.skipReasons = arg.slice('--skip-reasons='.length);
    else if (arg.startsWith('--allow-skips='))
      options.allowSkips = Number(arg.slice('--allow-skips='.length));
    else if (arg === '--json') options.json = true;
    else if (arg === '--allow-skip-escape-hatch') options.allowSkipEscapeHatch = true;
    else if (arg === '--scan-sources') options.scanSources = true;
    else if (arg === '--source-scan-only') {
      options.scanSources = true;
      options.sourceOnly = true;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else return { error: `Unknown argument: ${arg}` };
  }

  if (!Number.isInteger(options.allowSkips) || options.allowSkips < 0) {
    return { error: '--allow-skips must be a non-negative integer' };
  }
  return options;
}

/** Placeholder contract IDs found in the E2E/CI/deployer sources (#1242). */
function reportSourceScan(json) {
  const findings = findPlaceholderContractIds(PLACEHOLDER_SCAN_ROOTS);
  if (json) {
    console.log(JSON.stringify({ placeholderContractIds: findings }, null, 2));
  } else if (findings.length === 0) {
    console.log(
      '✓ Placeholder contract ID scan passed: no C_*_REPLACE_ME / C_DEPLOYED_CONTRACT_ID / ' +
        'dummy contract IDs in the E2E suite, CI workflows or deployer.'
    );
  } else {
    console.error(
      `✗ Found ${findings.length} placeholder contract ID reference(s). Placeholders must never ` +
        'reach the E2E suite or CI (they are not deployed contracts).\n' +
        '  recovery: provision a real contract with `node scripts/provision-e2e-contract.mjs` ' +
        'and read the ID from the environment.\n'
    );
    for (const finding of findings) {
      console.error(`  - ${finding.file}:${finding.line}: ${finding.match}`);
    }
  }
  return findings.length === 0 ? 0 : 1;
}

function main(argv) {
  const options = parseArgs(argv);

  if (options.help) {
    console.log(
      'usage: node scripts/check-e2e-coverage.mjs --report=<vitest json> [--allow-skips=N] [--json]\n' +
        '       ... --budgets=e2e-skip-budgets.json --branch=<protected branch>\n' +
        '       node scripts/check-e2e-coverage.mjs --source-scan-only'
    );
    return 0;
  }
  if (options.error) {
    console.error(`✗ ${options.error}`);
    return 2;
  }
  if (options.scanSources) {
    const scanCode = reportSourceScan(options.json);
    if (options.sourceOnly) return scanCode;
    if (scanCode !== 0) return scanCode;
  }
  if (!options.report) {
    console.error(
      '✗ --report=<path to vitest json report> is required. Generate it with:\n' +
        '  pnpm exec vitest run tests/e2e --reporter=json --outputFile=.artifacts/e2e-results.json'
    );
    return 2;
  }

  const reportPath = resolve(process.cwd(), options.report);
  if (!existsSync(reportPath)) {
    console.error(
      `✗ No E2E report at ${reportPath}. The gate fails closed: without a machine-readable ` +
        'report there is no evidence that the lifecycle suite executed.'
    );
    return 1;
  }

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (error) {
    console.error(`✗ Could not parse the E2E report at ${reportPath}: ${error.message}`);
    return 1;
  }

  let branchPolicy;
  if (options.budgets) {
    try {
      const config = JSON.parse(readFileSync(resolve(process.cwd(), options.budgets), 'utf8'));
      branchPolicy = resolveSkipBudget(
        config,
        options.branch || process.env.GITHUB_BASE_REF || process.env.GITHUB_REF_NAME
      );
      options.allowSkips = branchPolicy.budget;
    } catch (error) {
      console.error(`✗ Could not enforce protected-branch skip budget: ${error.message}`);
      return 1;
    }
  }

  const verdict = evaluateCoverage(report, {
    allowSkips: options.allowSkips,
    skipEscapeHatchSet: Boolean(process.env.E2E_ALLOW_SKIP),
    allowSkipEscapeHatch: options.allowSkipEscapeHatch,
    success: report.success !== false,
  });
  verdict.policy = branchPolicy ?? {
    branch: options.branch ?? 'local',
    budget: options.allowSkips,
    protected: false,
  };
  // Retained for the evidence artifact, but kept out of the console-oriented summary.
  verdict.files = normalizeReport(report).map((file) => ({
    ...file,
    relative: relativeToRepo(file.file, process.cwd()),
  }));
  const recordedReasons = [];
  if (options.skipReasons && existsSync(options.skipReasons)) {
    for (const line of readFileSync(options.skipReasons, 'utf8').split('\n').filter(Boolean)) {
      try {
        recordedReasons.push(JSON.parse(line));
      } catch {
        recordedReasons.push({ reason: `Unparseable skip reason record: ${line}` });
      }
    }
  }
  if (
    verdict.summary.skipped > 0 &&
    recordedReasons.length === 0 &&
    verdict.files.flatMap((file) => file.skipped).every((test) => !test.reason)
  ) {
    verdict.violations.push({
      code: 'missing-skip-reason',
      detail: 'skipped tests have no reporter reason or E2E_SKIP_REASONS_FILE record',
    });
    verdict.ok = false;
  }
  if (options.evidence) {
    const evidencePath = resolve(process.cwd(), options.evidence);
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(
      evidencePath,
      `${JSON.stringify(buildEvidence(verdict, recordedReasons), null, 2)}\n`
    );
  }

  if (options.json) {
    console.log(JSON.stringify(verdict, null, 2));
  } else if (verdict.ok) {
    console.log(
      `✓ E2E coverage gate passed: ${verdict.summary.tests} tests across ${verdict.summary.files} ` +
        `file(s), ${verdict.summary.skipped} skipped (budget ${verdict.policy.budget} on ` +
        `${verdict.policy.branch}; owner: release engineering — see docs/runbooks/e2e-prerequisites.md).`
    );
  } else {
    console.error(
      '✗ E2E coverage gate FAILED: the cross-package E2E suite did not fully execute.\n' +
        '  control: E2E prerequisites are fail-closed (#1241, #1242, #1243, #1244)\n' +
        '  owner:   release engineering\n' +
        '  recovery: provision a real contract (`node scripts/provision-e2e-contract.mjs`), start ' +
        'the node, and re-run — see docs/runbooks/e2e-prerequisites.md\n'
    );
    for (const violation of verdict.violations) {
      console.error(`  - [${violation.code}] ${violation.detail}`);
      for (const entry of violation.tests ?? []) {
        console.error(`      ${entry.file}: ${entry.names.join('; ')}`);
      }
    }
    console.error(
      `\n  ${verdict.summary.passed} passed / ${verdict.summary.skipped} skipped / ` +
        `${verdict.summary.failed} failed across ${verdict.summary.files} file(s).`
    );
  }

  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('check-e2e-coverage.mjs')) {
  process.exit(main(process.argv.slice(2)));
}

export { main, parseArgs, normalizeReport };
