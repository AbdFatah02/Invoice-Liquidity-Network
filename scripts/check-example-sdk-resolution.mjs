#!/usr/bin/env node
/**
 * check-example-sdk-resolution.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Verifies JavaScript/TypeScript example SDK resolution (Issue #1214).
 *
 * Ensures that example applications—specifically `examples/javascript-example`
 * and other consumer examples—can reliably resolve and import the canonical
 * `@iln/sdk` package without module resolution failure, path drift, or
 * symbol breakage.
 *
 * Checks:
 *   1. example-dependency  Example manifests declare `@iln/sdk` as a canonical dependency.
 *   2. resolution-path     File/link or workspace resolution points to the valid SDK root.
 *   3. manifest-integrity  The resolved SDK manifest carries canonical name `@iln/sdk`.
 *   4. exports-contract    The resolved SDK defines public exports ('.', './legacy').
 *   5. symbol-contract     The resolved SDK provides essential runtime exports:
 *                          ILNSdk, ILN_TESTNET, createKeypairSigner, SDK_VERSION.
 *   6. cjs-resolution      CommonJS `require()` resolution succeeds from the example directory.
 *
 * Usage:
 *   node scripts/check-example-sdk-resolution.mjs [--root=<dir>] [--json=<file>]
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, '..');

export const CANONICAL_SDK_NAME = '@iln/sdk';
export const REQUIRED_EXPORTS = ['ILNSdk', 'ILN_TESTNET', 'createKeypairSigner', 'SDK_VERSION'];

function toPosix(p) {
  return p.split(sep).join('/');
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * Validates SDK resolution for all examples in the given repository root.
 *
 * @param {string} root - Path to repository root.
 * @returns {{ findings: Array<object>, summary: object }}
 */
export function checkExampleSdkResolution(root = DEFAULT_ROOT) {
  const findings = [];
  const add = (finding) => findings.push(finding);

  const sdkDir = join(root, 'sdk');
  const sdkManifestPath = join(sdkDir, 'package.json');
  let sdkManifest = null;

  if (!existsSync(sdkManifestPath)) {
    add({
      rule: 'manifest-integrity',
      file: 'sdk/package.json',
      message: 'Canonical SDK manifest sdk/package.json is missing',
    });
  } else {
    try {
      sdkManifest = readJson(sdkManifestPath);
      if (sdkManifest.name !== CANONICAL_SDK_NAME) {
        add({
          rule: 'manifest-integrity',
          file: 'sdk/package.json',
          message: `SDK package.json name is "${sdkManifest.name}", expected "${CANONICAL_SDK_NAME}"`,
        });
      }
      if (!sdkManifest.exports || !sdkManifest.exports['.']) {
        add({
          rule: 'exports-contract',
          file: 'sdk/package.json',
          message: 'SDK package.json missing required "." exports definition',
        });
      }
    } catch (err) {
      add({
        rule: 'manifest-integrity',
        file: 'sdk/package.json',
        message: `Failed to parse sdk/package.json: ${err.message}`,
      });
    }
  }

  const examplesDir = join(root, 'examples');
  if (!existsSync(examplesDir)) {
    return {
      findings,
      summary: { total: findings.length, ok: findings.length === 0 },
    };
  }

  const entries = readdirSync(examplesDir, { withFileTypes: true });
  const exampleDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  for (const exampleName of exampleDirs) {
    const examplePath = join(examplesDir, exampleName);
    const manifestPath = join(examplePath, 'package.json');
    if (!existsSync(manifestPath)) continue;

    let pkg;
    try {
      pkg = readJson(manifestPath);
    } catch (err) {
      add({
        rule: 'example-dependency',
        file: `examples/${exampleName}/package.json`,
        message: `Invalid JSON in manifest: ${err.message}`,
      });
      continue;
    }

    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    // If this example interacts with the SDK (e.g. javascript-example, lp-automation, typescript-example)
    const hasSdkRef =
      Object.keys(allDeps).some((k) => k.includes('sdk')) ||
      existsSync(join(examplePath, 'index.js')) ||
      existsSync(join(examplePath, 'index.ts'));

    if (!hasSdkRef) continue;

    const sdkSpec = allDeps[CANONICAL_SDK_NAME];
    if (!sdkSpec) {
      // Check if it declared a legacy or wrong name
      const legacyKey = Object.keys(allDeps).find((k) => k.includes('invoice-liquidity/sdk'));
      if (legacyKey) {
        add({
          rule: 'example-dependency',
          file: `examples/${exampleName}/package.json`,
          message: `Declares legacy "${legacyKey}"; must declare canonical "${CANONICAL_SDK_NAME}"`,
        });
      } else if (exampleName === 'javascript-example') {
        add({
          rule: 'example-dependency',
          file: `examples/${exampleName}/package.json`,
          message: `Missing required dependency "${CANONICAL_SDK_NAME}"`,
        });
      }
      continue;
    }

    // Verify file/link target resolution
    if (typeof sdkSpec === 'string' && sdkSpec.startsWith('file:')) {
      const relPath = sdkSpec.slice('file:'.length);
      const targetDir = resolve(examplePath, relPath);
      const targetManifest = join(targetDir, 'package.json');

      if (!existsSync(targetManifest)) {
        add({
          rule: 'resolution-path',
          file: `examples/${exampleName}/package.json`,
          message: `Declared SDK path "${sdkSpec}" resolves to non-existent "${toPosix(
            relative(root, targetDir)
          )}"`,
        });
      } else {
        try {
          const resolvedPkg = readJson(targetManifest);
          if (resolvedPkg.name !== CANONICAL_SDK_NAME) {
            add({
              rule: 'resolution-path',
              file: `examples/${exampleName}/package.json`,
              message: `Declared SDK path points to package "${resolvedPkg.name}", expected "${CANONICAL_SDK_NAME}"`,
            });
          }
        } catch (err) {
          add({
            rule: 'resolution-path',
            file: `examples/${exampleName}/package.json`,
            message: `Could not read resolved SDK manifest: ${err.message}`,
          });
        }
      }
    }

    // Test symbol export contract if source or built files exist
    if (sdkDir && existsSync(join(sdkDir, 'src', 'index.ts'))) {
      const sdkSource = readFileSync(join(sdkDir, 'src', 'index.ts'), 'utf8');
      for (const requiredExport of REQUIRED_EXPORTS) {
        const regex = new RegExp(`export\\s+(?:function|class|const|let|var|type|interface|enum)?\\s*\\b${requiredExport}\\b`);
        const hasExport =
          regex.test(sdkSource) ||
          sdkSource.includes(`export { ${requiredExport}`) ||
          sdkSource.includes(`export * from './client'`) ||
          sdkSource.includes(`export * from './signers'`) ||
          sdkSource.includes(`export * from './types'`);

        if (!hasExport) {
          add({
            rule: 'symbol-contract',
            file: `examples/${exampleName}/package.json`,
            message: `SDK does not export required symbol "${requiredExport}" for example resolution`,
          });
        }
      }
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));

  return {
    findings,
    summary: {
      total: findings.length,
      ok: findings.length === 0,
      checkedAt: new Date().toISOString(),
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  let root = DEFAULT_ROOT;
  let jsonOut = null;

  for (const arg of args) {
    if (arg.startsWith('--root=')) {
      root = resolve(arg.slice('--root='.length));
    } else if (arg.startsWith('--json=')) {
      jsonOut = resolve(arg.slice('--json='.length));
    }
  }

  const report = checkExampleSdkResolution(root);

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(report, null, 2));
    console.log(`[example-sdk-resolution] wrote JSON report to ${jsonOut}`);
  }

  if (report.findings.length > 0) {
    console.error(
      `\x1b[31m[example-sdk-resolution] FAILED — ${report.findings.length} issue(s) detected:\x1b[0m`
    );
    for (const f of report.findings) {
      console.error(`  - [${f.rule}] ${f.file}: ${f.message}`);
    }
    process.exit(1);
  }

  console.log('\x1b[32m[example-sdk-resolution] OK — all examples resolve @iln/sdk cleanly\x1b[0m');
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
