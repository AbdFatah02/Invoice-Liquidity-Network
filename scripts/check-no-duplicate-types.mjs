#!/usr/bin/env node

/**
 * check-no-duplicate-types.mjs
 *
 * Lightweight check that no consuming package (sdk, cli, indexer, notifications,
 * packages/*) locally redefines a type that already exists in @iln/shared.
 *
 * Usage:  node scripts/check-no-duplicate-types.mjs
 * Exit 0 = clean, exit 1 = duplicates found.
 *
 * This is intentionally regex-based (no AST dependency) so it stays fast
 * and dependency-free. It catches the common patterns:
 *   export type Foo = ...
 *   export interface Foo { ... }
 *   export enum Foo { ... }
 */

import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// ── 1. Extract exported type names from packages/shared/src ────────────────

const ROOT_DIR = resolve(process.env.ILN_REPO_ROOT || join(import.meta.dirname, '..'));
const SHARED_DIR = join(ROOT_DIR, 'packages', 'shared', 'src');

function extractExportedNames(dir) {
  const names = new Set();
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = lstatSync(full);
    if (stat.isDirectory()) {
      for (const name of extractExportedNames(full)) names.add(name);
    } else if (!stat.isSymbolicLink() && /\.(ts|mts|cts)$/.test(entry)) {
      const src = readFileSync(full, 'utf8');
      // Match: export type Foo, export interface Foo, export enum Foo
      // Also matches: export type Foo = (deprecated alias re-exports)
      for (const m of src.matchAll(/^export\s+(type|interface|enum)\s+(\w+)/gm)) {
        names.add(m[2]);
      }
    }
  }
  return names;
}

const sharedNames = extractExportedNames(SHARED_DIR);

if (sharedNames.size === 0) {
  console.error('❌ Could not extract any exported types from packages/shared/src');
  process.exit(2);
}

// ── 2. Scan consuming packages for local definitions with the same names ───

const TOP_LEVEL_CONSUMERS = ['sdk', 'cli', 'indexer', 'notifications'];
const PACKAGE_DIR = join(ROOT_DIR, 'packages');
const PACKAGE_CONSUMERS = readdirSync(PACKAGE_DIR, { withFileTypes: true })
  .filter((entry) => {
    if (!entry.isDirectory() || entry.name === 'shared') return false;
    const manifestPath = join(PACKAGE_DIR, entry.name, 'package.json');
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some(
        (group) => Object.hasOwn(manifest[group] ?? {}, '@iln/shared')
      );
    } catch {
      return false;
    }
  })
  .map((entry) => join(PACKAGE_DIR, entry.name, 'src'));
const CONSUMING_DIRS = [
  ...TOP_LEVEL_CONSUMERS.map((name) => join(ROOT_DIR, name, 'src')),
  join(PACKAGE_DIR, 'sdk', 'src'),
  join(PACKAGE_DIR, 'indexer', 'src'),
  ...PACKAGE_CONSUMERS,
];

// Skip patterns: test files, declaration files, auto-generated files, re-exports from @iln/shared
const SKIP = /\.(test|spec|d)\.(ts|mts|cts|tsx)$/;
const AUTO_GENERATED = /AUTO-GENERATED|auto-generated/i;
// This file defines runtime Zod validation schemas and exports inferred types
// from those schemas. These aliases intentionally parallel shared wire types.
const SCHEMA_DERIVED_TYPES = /packages\/sdk\/src\/schemas\/events\.ts$/;
const SHARED_IMPORT = /from\s+["']@iln\/shared["']/;
const INTENTIONAL_DUPLICATES = new Set([
  // The event parser's XDR projections intentionally omit fields exposed by
  // the fuller shared contract-event interfaces.
  'packages/sdk/src/events.ts:InvoiceDisputedEvent',
  'packages/sdk/src/events.ts:DisputeEvidenceSubmittedEvent',
  'packages/sdk/src/events.ts:DisputeResolvedEvent',
  'packages/sdk/src/events.ts:DisputeAutoResolvedEvent',
]);

function scanDir(dir, sharedNames) {
  const violations = [];
  let filesScanned = 0;

  function walk(current) {
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      return; // directory doesn't exist — skip
    }
    for (const entry of entries) {
      const full = join(current, entry);
      const st = lstatSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (/\.(ts|mts|cts|tsx)$/.test(entry) && !SKIP.test(entry)) {
        filesScanned++;
        const src = readFileSync(full, 'utf8');

        // Skip auto-generated files
        if (AUTO_GENERATED.test(src.slice(0, 200))) continue;
        const relPath = relative(ROOT_DIR, full);

        if (SCHEMA_DERIVED_TYPES.test(relPath)) continue;

        // Skip files that only re-export from @iln/shared
        if (
          SHARED_IMPORT.test(src) &&
          !/^export\s+(type|interface|enum)\s+\w+/m.test(
            src.replace(/^.*from\s+["']@iln\/shared["'].*$/gm, '')
          )
        ) {
          continue;
        }

        // Check for local type definitions matching shared names
        const typeDefs = src.matchAll(/^(?:export\s+)?(type|interface|enum)\s+(\w+)/gm);
        for (const m of typeDefs) {
          if (sharedNames.has(m[2])) {
            if (INTENTIONAL_DUPLICATES.has(`${relPath}:${m[2]}`)) continue;
            // Find the line number
            const idx = m.index;
            const lineNum = src.slice(0, idx).split('\n').length;

            // Check if there's a JSDoc/block comment above explaining
            // why this type is intentionally different from @iln/shared
            const preceding = src.slice(Math.max(0, idx - 800), idx);
            const hasExplanation =
              /intentionally\s+differs/i.test(preceding) ||
              /not\s+a\s+duplicat/i.test(preceding) ||
              /intentionally\s+different/i.test(preceding) ||
              /DB-specific projection/i.test(preceding) ||
              /CLI-specific projection/i.test(preceding) ||
              /SDK-specific/i.test(preceding) ||
              /XDR projection/i.test(preceding) ||
              /intentionally\s+differs/i.test(src.slice(idx, idx + 200));
            if (hasExplanation) continue;

            violations.push({
              file: relPath,
              line: lineNum,
              name: m[2],
              kind: m[1],
            });
          }
        }
      }
    }
  }

  walk(dir);
  return { violations, filesScanned };
}

let totalViolations = [];

for (const dir of CONSUMING_DIRS) {
  const { violations, filesScanned } = scanDir(dir, sharedNames);
  if (violations.length > 0) {
    for (const v of violations) {
      totalViolations.push(v);
    }
  }
}

// ── 3. Report ──────────────────────────────────────────────────────────────

if (totalViolations.length === 0) {
  console.log(
    `✅ No duplicate type definitions found (scanned ${CONSUMING_DIRS.length} package roots against ${sharedNames.size} shared type names).`
  );
  process.exit(0);
}

console.error(
  `\n❌ Found ${totalViolations.length} local type definition(s) that duplicate @iln/shared exports:\n`
);
for (const v of totalViolations) {
  console.error(`  ${v.file}:${v.line}  ${v.kind} ${v.name}`);
}
console.error(
  '\nThese should either:\n' +
    '  1. Import from @iln/shared, or\n' +
    '  2. Be renamed to avoid the collision (e.g. ParsedHorizonEvent instead of ContractEvent).\n' +
    '  3. Add an inline comment explaining why the local definition is intentionally different.\n'
);
process.exit(1);
