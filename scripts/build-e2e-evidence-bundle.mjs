#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MANIFEST as DEFAULT_OWNERSHIP_MANIFEST,
  formatReport as formatOwnershipReport,
  validateEnvironmentOwnership,
} from './check-e2e-environment-rotation.mjs';

export const BUNDLE_SCHEMA_VERSION = 1;
export const BUNDLE_CONTROL = 'e2e-release-evidence';
export const DEFAULT_RESULTS = '.artifacts/e2e-results.json';
export const DEFAULT_OUT = '.artifacts/e2e-evidence-bundle.json';

/** Parse `--flag=value` / `--flag` arguments into a plain object. */
export function parseArgs(argv) {
  const args = {};
  for (const token of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(token);
    if (!match) continue;
    const [, key, value] = match;
    args[key] = value === undefined ? true : value;
  }
  return args;
}

function toRepoRelative(path, rootDir) {
  if (!rootDir) return path;
  return relative(rootDir, path).replaceAll('\\', '/');
}

/**
 * Normalise a machine-readable vitest JSON report into the small summary the
 * release evidence bundle records. Returns `null` for a missing/invalid report.
 */
export function summarizeResults(results, rootDir) {
  if (!results || typeof results !== 'object' || Array.isArray(results)) return null;
  const suites = Array.isArray(results.testResults) ? results.testResults : [];
  const assertions = (suite) =>
    Array.isArray(suite?.assertionResults) ? suite.assertionResults : [];
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

  return {
    success: Boolean(results.success),
    total_suites: number(results.numTotalTestSuites) || suites.length,
    total_tests: number(results.numTotalTests),
    passed: number(results.numPassedTests),
    failed: number(results.numFailedTests),
    skipped: number(results.numPendingTests),
    todo: number(results.numTodoTests),
    suites: suites.map((suite) => ({
      name: rootDir && typeof suite.name === 'string' ? toRepoRelative(suite.name, rootDir) : (suite.name ?? 'unknown'),
      status: suite.status ?? 'unknown',
      tests: assertions(suite).length,
      failed: assertions(suite).filter((a) => a.status === 'failed').length,
      skipped: assertions(suite).filter((a) =>
        ['skipped', 'pending', 'todo'].includes(a.status)
      ).length,
    })),
  };
}

/**
 * Decide whether an E2E run is releasable and collect every reason it is not.
 *
 * @returns {{ ok: boolean, violations: Array<{code:string,message:string}> }}
 */
export function evaluateEvidence({ summary, gate, ownership, rpcWait }) {
  const violations = [];
  const fail = (code, message) => violations.push({ code, message });

  if (!summary) {
    fail('missing-results', 'no valid vitest JSON report was found');
  } else {
    if (summary.total_tests === 0) fail('no-tests', 'the E2E suite ran zero tests');
    if (summary.failed > 0) {
      fail('failed-tests', `${summary.failed} E2E test(s) failed`);
    }
    if (summary.skipped > 0) {
      fail(
        'skipped-tests',
        `${summary.skipped} E2E test(s) were skipped — the fail-closed prerequisite control was bypassed`
      );
    }
    if (!summary.success) {
      fail('unsuccessful-report', 'the vitest report marked the run as unsuccessful');
    }
  }

  if (!gate || gate.ran !== true) {
    fail('coverage-gate-not-run', 'the E2E coverage gate did not run');
  } else if (Number(gate.exit_code) !== 0) {
    fail('coverage-gate-failed', `the E2E coverage gate exited ${gate.exit_code}`);
  }

  if (ownership && ownership.ok !== true) {
    const codes = (ownership.violations ?? []).map((v) => v.code).join(', ');
    fail('environment-ownership-failed', `E2E environment ownership/rotation failed: ${codes}`);
  }

  if (rpcWait && rpcWait.ready === false) {
    fail('rpc-not-ready', 'the Stellar RPC never became ready before the suite ran');
  }

  return { ok: violations.length === 0, violations };
}

/** SHA-256 (hex) and byte size of a file, or `null` when it does not exist. */
export function fileProvenance(path, rootDir) {
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  return {
    path: toRepoRelative(path, rootDir),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}

/**
 * Assemble a release evidence bundle from already-read inputs. Pure with respect
 * to the filesystem so it can be unit-tested deterministically.
 */
export function buildEvidenceBundle({
  results,
  ownership,
  ownershipOptions,
  gate,
  rpcWait,
  metadata,
  provenance,
  now = () => new Date().toISOString(),
  rootDir,
}) {
  const summary = summarizeResults(results, rootDir);
  const ownershipResult = ownership
    ? validateEnvironmentOwnership(ownership, ownershipOptions)
    : null;
  const evaluation = evaluateEvidence({ summary, gate, ownership: ownershipResult, rpcWait });

  const bundle = {
    schema_version: BUNDLE_SCHEMA_VERSION,
    control: BUNDLE_CONTROL,
    generated_at: now(),
    metadata: metadata ?? {},
    environment_ownership: ownershipResult
      ? {
          ok: ownershipResult.ok,
          owner: ownershipResult.summary.owner,
          as_of: ownershipResult.summary.as_of,
          credentials: ownershipResult.summary.credentials,
        }
      : null,
    rpc_wait: rpcWait ?? null,
    coverage_gate: gate ?? null,
    results: summary,
    provenance: (provenance ?? []).filter(Boolean),
    verdict: evaluation,
  };

  return { ok: evaluation.ok, violations: evaluation.violations, bundle };
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text === '' ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Human-readable report for the console. */
export function formatBundleReport(result) {
  const lines = [];
  if (result.ok) {
    lines.push('✓ E2E release evidence bundle is complete');
  } else {
    lines.push(
      `✗ E2E release evidence bundle is incomplete (${result.violations.length} violation${
        result.violations.length === 1 ? '' : 's'
      })`
    );
  }
  for (const violation of result.violations) {
    lines.push(`  [${violation.code}] ${violation.message}`);
  }
  const summary = result.bundle.results;
  if (summary) {
    lines.push(
      `  results: ${summary.passed}/${summary.total_tests} passed, ` +
        `${summary.failed} failed, ${summary.skipped} skipped, ${summary.total_suites} suite(s)`
    );
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = typeof args.root === 'string' ? resolve(args.root) : process.cwd();

  const resultsRel = typeof args.results === 'string' ? args.results : DEFAULT_RESULTS;
  const outRel = typeof args.out === 'string' ? args.out : DEFAULT_OUT;
  const ownershipRel =
    typeof args.ownership === 'string' ? args.ownership : DEFAULT_OWNERSHIP_MANIFEST;
  const rpcWaitRel = typeof args['rpc-wait'] === 'string' ? args['rpc-wait'] : undefined;
  const coverageReportRel =
    typeof args['coverage-report'] === 'string' ? args['coverage-report'] : undefined;

  const resultsPath = resolve(rootDir, resultsRel);
  const ownershipPath = resolve(rootDir, ownershipRel);
  const rpcWaitPath = rpcWaitRel ? resolve(rootDir, rpcWaitRel) : undefined;
  const coverageReportPath = coverageReportRel ? resolve(rootDir, coverageReportRel) : undefined;

  const results = readJsonIfExists(resultsPath);
  const ownership = readJsonIfExists(ownershipPath);
  const rpcWait = rpcWaitPath ? readJsonIfExists(rpcWaitPath) : undefined;
  const coverageReport = coverageReportPath ? readJsonIfExists(coverageReportPath) : undefined;

  const gate = {
    ran: results !== undefined || coverageReport !== undefined,
    exit_code:
      args['coverage-exit'] !== undefined ? Number(args['coverage-exit']) : 0,
    report: coverageReport?.summary ?? coverageReport ?? null,
  };

  const metadata = {
    repository: typeof args.repo === 'string' ? args.repo : process.env.GITHUB_REPOSITORY,
    commit: typeof args.commit === 'string' ? args.commit : git(['rev-parse', 'HEAD'], rootDir),
    ref:
      typeof args.ref === 'string'
        ? args.ref
        : process.env.GITHUB_REF_NAME ?? git(['rev-parse', '--abbrev-ref', 'HEAD'], rootDir),
    run_id: typeof args['run-id'] === 'string' ? args['run-id'] : process.env.GITHUB_RUN_ID,
    run_attempt:
      typeof args['run-attempt'] === 'string' ? args['run-attempt'] : process.env.GITHUB_RUN_ATTEMPT,
    actor: typeof args.actor === 'string' ? args.actor : process.env.GITHUB_ACTOR,
    workflow: typeof args.workflow === 'string' ? args.workflow : process.env.GITHUB_WORKFLOW,
    event: typeof args.event === 'string' ? args.event : process.env.GITHUB_EVENT_NAME,
    generated_by: 'scripts/build-e2e-evidence-bundle.mjs',
  };

  const provenance = [
    fileProvenance(resultsPath, rootDir),
    fileProvenance(ownershipPath, rootDir),
    rpcWaitPath ? fileProvenance(rpcWaitPath, rootDir) : null,
    coverageReportPath ? fileProvenance(coverageReportPath, rootDir) : null,
  ];

  const result = buildEvidenceBundle({
    results,
    ownership,
    ownershipOptions: { rootDir },
    gate,
    rpcWait,
    metadata,
    provenance,
    rootDir,
  });

  const outPath = resolve(rootDir, outRel);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result.bundle, null, 2));

  console.log(formatBundleReport(result));
  console.log(`  bundle: ${outRel}`);
  if (ownership) {
    console.log(formatOwnershipReport(validateEnvironmentOwnership(ownership, { asOf: undefined, rootDir })));
  }

  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
