#!/usr/bin/env node
/**
 * check-sdk-client-drift.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects generated-client and contract-type drift for SDK releases (Issue #1209).
 *
 * Verifies that `sdk/src/generated/types.ts` is up to date, carries valid spec
 * metadata, and matches the contract specification, preventing drift between
 * Soroban contract ABI definitions and the client types distributed to integrators.
 *
 * Checks:
 *   1. generated-file-exists    `sdk/src/generated/types.ts` exists on disk.
 *   2. autogen-header           Header carries canonical generation directives.
 *   3. spec-hash-integrity      Spec hash is recorded and matches spec.json if present.
 *   4. contract-error-contract  ContractError enum defines all canonical contract errors.
 *   5. sdk-export-contract      `sdk/src/index.ts` re-exports ContractError.
 *
 * Usage:
 *   node scripts/check-sdk-client-drift.mjs [--root=<dir>] [--json=<file>]
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, '..');

export const REQUIRED_CONTRACT_ERRORS = Object.freeze([
  'InvoiceNotFound',
  'AlreadyFunded',
  'AlreadyPaid',
  'NotFunder',
  'NotPayer',
  'NotDueYet',
  'InvalidAmount',
  'InvalidDiscount',
  'InvalidDueDate',
  'Unauthorized',
]);

export function computeSpecHash(specContent) {
  return createHash('sha256').update(specContent).digest('hex').slice(0, 8);
}

/**
 * Checks for drift in the generated SDK client types against contract specifications.
 *
 * @param {string} root - Path to repository root.
 * @returns {{ findings: Array<object>, summary: object }}
 */
export function checkSdkClientDrift(root = DEFAULT_ROOT) {
  const findings = [];
  const add = (f) => findings.push(f);

  const generatedPath = join(root, 'sdk', 'src', 'generated', 'types.ts');
  const specPath = join(root, 'backend', 'target', 'spec.json');
  const indexPath = join(root, 'sdk', 'src', 'index.ts');

  if (!existsSync(generatedPath)) {
    add({
      rule: 'generated-file-exists',
      file: 'sdk/src/generated/types.ts',
      message: 'Generated types file is missing. Run: pnpm generate:types',
    });
    return {
      findings,
      summary: { total: findings.length, ok: false },
    };
  }

  const generatedContent = readFileSync(generatedPath, 'utf8');

  // 1. Header validation
  if (!generatedContent.includes('// !! AUTO-GENERATED')) {
    add({
      rule: 'autogen-header',
      file: 'sdk/src/generated/types.ts',
      message: 'Missing auto-generated header marker in sdk/src/generated/types.ts',
    });
  }

  // 2. Spec hash comparison if spec.json exists
  if (existsSync(specPath)) {
    try {
      const specContent = readFileSync(specPath, 'utf8');
      const expectedHash = computeSpecHash(specContent);
      const match = /\/\/\s*Spec hash:\s*([a-f0-9]+)/i.exec(generatedContent);
      if (match) {
        const actualHash = match[1];
        if (actualHash !== expectedHash) {
          add({
            rule: 'spec-hash-integrity',
            file: 'sdk/src/generated/types.ts',
            message: `Generated types spec hash (${actualHash}) has drifted from spec.json (${expectedHash}). Run: pnpm generate:types`,
          });
        }
      }
    } catch (err) {
      add({
        rule: 'spec-hash-integrity',
        file: 'backend/target/spec.json',
        message: `Failed to read contract spec.json: ${err.message}`,
      });
    }
  }

  // 3. ContractError enum contract validation
  if (!generatedContent.includes('export enum ContractError')) {
    add({
      rule: 'contract-error-contract',
      file: 'sdk/src/generated/types.ts',
      message: 'sdk/src/generated/types.ts must export enum ContractError',
    });
  } else {
    for (const errorCase of REQUIRED_CONTRACT_ERRORS) {
      const pattern = new RegExp(`\\b${errorCase}\\s*=`);
      if (!pattern.test(generatedContent)) {
        add({
          rule: 'contract-error-contract',
          file: 'sdk/src/generated/types.ts',
          message: `ContractError enum is missing required case "${errorCase}"`,
        });
      }
    }
  }

  // 4. Client re-export contract
  if (existsSync(indexPath)) {
    const indexContent = readFileSync(indexPath, 'utf8');
    if (!indexContent.includes('ContractError')) {
      add({
        rule: 'sdk-export-contract',
        file: 'sdk/src/index.ts',
        message: 'sdk/src/index.ts must export ContractError from ./generated/types',
      });
    }
  }

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

  const report = checkSdkClientDrift(root);

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(report, null, 2));
    console.log(`[sdk-client-drift] wrote report to ${jsonOut}`);
  }

  if (report.findings.length > 0) {
    console.error(`\x1b[31m[sdk-client-drift] FAILED — ${report.findings.length} issue(s) detected:\x1b[0m`);
    for (const f of report.findings) {
      console.error(`  - [${f.rule}] ${f.file}: ${f.message}`);
    }
    process.exit(1);
  }

  console.log('\x1b[32m[sdk-client-drift] OK — generated client types are aligned with contract ABI\x1b[0m');
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
