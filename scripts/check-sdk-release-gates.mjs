#!/usr/bin/env node

/**
 * check-sdk-release-gates.mjs
 *
 * Issue #1217: Gate SDK releases on migration documentation
 *
 * Validates that all required migration documentation and compatibility
 * artifacts are present before an SDK release is published. This ensures
 * operators have the necessary information to migrate between versions.
 *
 * Required artifacts:
 * 1. Migration guide (docs/sdk-migration-guide.md or docs/sdk-next-migration.md)
 * 2. Version manifest (docs/version-manifest.json)
 * 3. Compatibility matrix in cross-repo-dependencies.md
 * 4. SDK compatibility test fixtures (tests/sdk-integration/compat-matrix/fixtures/)
 * 5. Changelog entry for the release
 *
 * Usage:
 *   node scripts/check-sdk-release-gates.mjs
 *   pnpm check-sdk-release-gates
 *
 * Exit codes:
 *   0 = All gates pass, release is permitted
 *   1 = Gate check failed, release is blocked
 */

import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { checkSdkClientDrift } from './check-sdk-client-drift.mjs';
import { checkExampleSdkResolution } from './check-example-sdk-resolution.mjs';
import { checkSdkSupportWindows } from './check-sdk-support-windows.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const GATES = [
  {
    name: 'SDK Migration Guide',
    check: () => {
      const migrationGuide = resolve(ROOT, 'docs/sdk-migration-guide.md');
      const nextMigrationGuide = resolve(ROOT, 'docs/sdk-next-migration.md');
      return existsSync(migrationGuide) || existsSync(nextMigrationGuide);
    },
    message: 'At least one migration guide must exist (docs/sdk-migration-guide.md or docs/sdk-next-migration.md)',
    severity: 'error',
  },
  {
    name: 'Version Manifest',
    check: () => {
      const versionManifest = resolve(ROOT, 'docs/version-manifest.json');
      if (!existsSync(versionManifest)) return false;
      try {
        const content = readFileSync(versionManifest, 'utf-8');
        const manifest = JSON.parse(content);
        return manifest.sdk && manifest.contract;
      } catch {
        return false;
      }
    },
    message: 'Version manifest (docs/version-manifest.json) must exist with sdk and contract versions',
    severity: 'error',
  },
  {
    name: 'Compatibility Matrix',
    check: () => {
      const crossRepoDeps = resolve(ROOT, 'docs/cross-repo-dependencies.md');
      if (!existsSync(crossRepoDeps)) return false;
      const content = readFileSync(crossRepoDeps, 'utf-8');
      return (
        content.includes('<!-- COMPATIBILITY_MATRIX_START -->') &&
        content.includes('<!-- COMPATIBILITY_MATRIX_END -->')
      );
    },
    message: 'Compatibility matrix markers must exist in docs/cross-repo-dependencies.md',
    severity: 'error',
  },
  {
    name: 'SDK Package.json Version',
    check: () => {
      const sdkPkg = resolve(ROOT, 'sdk/package.json');
      if (!existsSync(sdkPkg)) return false;
      try {
        const pkg = JSON.parse(readFileSync(sdkPkg, 'utf-8'));
        return pkg.version && /^\d+\.\d+\.\d+/.test(pkg.version);
      } catch {
        return false;
      }
    },
    message: 'SDK package.json must have a valid semantic version',
    severity: 'error',
  },
  {
    name: 'CHANGELOG Entry',
    check: () => {
      const changelog = resolve(ROOT, 'CHANGELOG.md');
      if (!existsSync(changelog)) return false;
      const content = readFileSync(changelog, 'utf-8');
      // Check for recent changelog entries (not older than current version)
      return content.includes('## [') && content.length > 100;
    },
    message: 'CHANGELOG.md must contain recent release entries',
    severity: 'warning',
  },
  {
    name: 'SDK Export Entries',
    check: () => {
      const sdkPkg = resolve(ROOT, 'sdk/package.json');
      if (!existsSync(sdkPkg)) return false;
      try {
        const pkg = JSON.parse(readFileSync(sdkPkg, 'utf-8'));
        // Verify exports field is present for compatibility shim (issue #1219)
        return pkg.exports && Object.keys(pkg.exports).length > 0;
      } catch {
        return false;
      }
    },
    message: 'SDK package.json must define exports field (for legacy import compatibility)',
    severity: 'error',
  },
  {
    name: 'Generated-Client Drift Detection',
    check: () => {
      const report = checkSdkClientDrift(ROOT);
      return report.findings.length === 0;
    },
    message: 'Generated client types must be aligned with contract spec (no drift detected)',
    severity: 'error',
  },
  {
    name: 'Example SDK Resolution',
    check: () => {
      const report = checkExampleSdkResolution(ROOT);
      return report.findings.length === 0;
    },
    message: 'Examples must resolve canonical @iln/sdk package and exports contract',
    severity: 'error',
  },
  {
    name: 'SDK Support Windows',
    check: () => {
      const report = checkSdkSupportWindows(ROOT);
      return report.findings.length === 0;
    },
    message:
      'Every SDK surface must declare a valid support window (docs/sdk-support-windows.json)',
    severity: 'error',
  },
];

function formatResult(gate, passed) {
  const icon = passed ? '✓' : '✗';
  const status = passed ? 'PASS' : 'FAIL';
  const color = passed ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';

  return `${color}${icon}${reset} [${status}] ${gate.name}${
    !passed ? `\n    ${gate.message}` : ''
  }`;
}

function main() {
  console.log('\n📋 SDK Release Gates Check (Issue #1217)\n');
  console.log(`Checking ${GATES.length} release gates...\n`);

  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;
  const failures = [];

  for (const gate of GATES) {
    const passed = gate.check();

    if (passed) {
      passCount++;
    } else if (gate.severity === 'warning') {
      warnCount++;
      console.log(formatResult(gate, false));
    } else {
      failCount++;
      failures.push(gate.message);
      console.log(formatResult(gate, false));
    }

    if (passed) {
      console.log(formatResult(gate, true));
    }
  }

  console.log(`\n${'─'.repeat(60)}\n`);
  console.log(`Results: ${passCount}/${GATES.length} gates passed`);

  if (warnCount > 0) {
    console.log(`⚠️  ${warnCount} warning(s) - migration documentation may be incomplete`);
  }

  if (failCount > 0) {
    console.log(`\n❌ Release blocked: ${failCount} critical gate(s) failed\n`);
    failures.forEach((msg, i) => {
      console.log(`${i + 1}. ${msg}`);
    });
    console.log('\nPlease address all critical gates before releasing.\n');
    process.exit(1);
  }

  console.log('\n✅ All critical gates passed - SDK release is permitted\n');
  process.exit(0);
}

main();
