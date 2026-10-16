#!/usr/bin/env node
/**
 * check-e2e-scope.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight heuristic CI guard for the E2E test-scope rules documented in
 * docs/e2e-test-scope.md.
 *
 * Rule (see docs): a per-package test file must stay single-package. If it needs
 * to exercise more than one *other* stack package's client, it belongs in the
 * root `tests/e2e/` cross-package suite instead.
 *
 * Heuristic: scan the per-package test directories; for each test file, collect
 * the set of *distinct* stack "client" packages it imports. If that set has more
 * than one member (and none of them is the file's own package), flag it.
 *
 * Support packages (mocks, test-utils, shared, scripts, telemetry, eslint-config)
 * are intentionally ignored — depending on those is not cross-package.
 *
 * Exit code: 0 when clean, 1 when one or more files should be relocated.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/** Stack "client" packages whose presence in a per-package test implies a
 *  cross-package dependency. */
const CLIENT_PACKAGES = new Set([
  '@iln/sdk',
  '@iln/invoice-sdk',
  '@invoice-liquidity/cli',
  '@iln/cli',
  'iln-indexer',
  '@invoice-liquidity/indexer',
  '@invoice-liquidity/notifications',
  '@iln/react',
  '@invoice-liquidity/frontend',
  '@iln/frontend',
]);

/** Packages that are test plumbing, not product "clients". */
const SUPPORT_PACKAGES = new Set([
  '@iln/mock-backend',
  '@iln/test-utils',
  '@iln/shared',
  '@iln/scripts',
  '@iln/opentelemetry',
  '@iln/eslint-config',
]);

/** Per-package test roots to scan (root `tests/` is the cross-package suite and
 *  is intentionally excluded). */
const SCAN_ROOTS = [
  'sdk',
  'cli',
  'indexer',
  'notifications',
  'backend',
  'oracle-service',
  'workers',
  'packages',
  'examples',
];

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
const IMPORT_RE =
  /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveOwnPackage(filePath) {
  let dir = dirname(filePath);
  while (dir !== ROOT) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        return JSON.parse(readFileSync(pkg, 'utf8')).name;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function packageNameOf(specifier) {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.slice(0, 2).join('/');
  }
  return specifier.split('/')[0];
}

function collectTestFiles(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (TEST_FILE_RE.test(entry)) out.push(full);
    }
  };
  walk(root);
  return out;
}

function importedClients(filePath, ownPackage) {
  const source = readFileSync(filePath, 'utf8');
  const clients = new Set();
  let match;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(source)) !== null) {
    const spec = match[1] ?? match[2];
    if (!spec) continue;
    if (!spec.startsWith('.') && !spec.startsWith('/')) {
      const pkg = packageNameOf(spec);
      if (SUPPORT_PACKAGES.has(pkg)) continue;
      if (CLIENT_PACKAGES.has(pkg) && pkg !== ownPackage) clients.add(pkg);
    }
  }
  return clients;
}

function main() {
  const violations = [];

  for (const root of SCAN_ROOTS) {
    const absRoot = join(ROOT, root);
    if (!existsSync(absRoot)) continue;
    const targets = root === 'packages' || root === 'examples'
      ? readdirSync(absRoot)
          .map((d) => join(absRoot, d))
          .filter((d) => {
            try {
              return statSync(d).isDirectory();
            } catch {
              return false;
            }
          })
      : [absRoot];

    for (const target of targets) {
      for (const file of collectTestFiles(target)) {
        const own = resolveOwnPackage(file);
        const clients = importedClients(file, own);
        if (clients.size > 1) {
          violations.push({ file: file.replace(ROOT + '/', ''), clients: [...clients], own });
        }
      }
    }
  }

  if (violations.length === 0) {
    console.log('✓ E2E scope check passed: no per-package test imports multiple stack clients.');
    process.exit(0);
  }

  console.error('✗ E2E scope check failed: the following per-package tests import more than');
  console.error('  one other stack package client and likely belong in tests/e2e/ instead.');
  console.error('  See docs/e2e-test-scope.md for the scope rules.\n');
  for (const v of violations) {
    console.error(`  - ${v.file}`);
    console.error(`      imports: ${v.clients.join(', ')}`);
  }
  console.error('\n  Fix: move cross-package scenarios into tests/e2e/ (the root cross-package');
  console.error('  suite) or split the test so each file stays single-package.');
  process.exit(1);
}

main();
