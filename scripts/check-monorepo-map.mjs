#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

function usage() {
  console.error('Usage: node scripts/check-monorepo-map.mjs [--repo-root <path>]');
}

function parseArgs() {
  let repoRoot = process.cwd();
  const args = process.argv.slice(2);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--repo-root') {
      const next = args[index + 1];
      if (!next) {
        usage();
        process.exit(2);
      }
      repoRoot = resolve(next);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
  }

  return { repoRoot };
}

function readWorkspacePatterns(repoRoot) {
  const workspacePath = resolve(repoRoot, 'pnpm-workspace.yaml');
  if (!existsSync(workspacePath)) {
    throw new Error(`pnpm-workspace.yaml not found at ${workspacePath}`);
  }

  const content = readFileSync(workspacePath, 'utf8');
  const patterns = [...content.matchAll(/^\s*-\s*["']?([^"'\n]+)["']?\s*$/gm)]
    .map((match) => match[1].trim())
    .filter(Boolean);

  return patterns;
}

function expandPattern(baseDir, pattern) {
  if (!pattern.includes('*')) {
    const absolute = resolve(baseDir, pattern);
    return existsSync(absolute) ? [absolute] : [];
  }

  const prefix = pattern.replace(/\/\*.*$/, '').replace(/\*.*$/, '');
  const base = resolve(baseDir, prefix || '.');

  if (!existsSync(base)) {
    return [];
  }

  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => resolve(base, entry.name));
}

function collectWorkspaceEntries(repoRoot) {
  const patterns = readWorkspacePatterns(repoRoot);
  const entries = new Set();

  for (const pattern of patterns) {
    for (const dir of expandPattern(repoRoot, pattern)) {
      entries.add(relative(repoRoot, dir).replace(/\\/g, '/').replace(/\/$/, ''));
    }
  }

  return [...entries].sort();
}

function collectDocumentedEntries(repoRoot) {
  const mapPath = resolve(repoRoot, 'docs/monorepo-map.md');
  if (!existsSync(mapPath)) {
    throw new Error(`Monorepo map not found at ${mapPath}`);
  }

  const content = readFileSync(mapPath, 'utf8');
  const rows = content.split('\n');
  const entries = new Set();

  for (const rawLine of rows) {
    if (!rawLine.startsWith('|')) continue;

    const cells = rawLine
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
      .filter(Boolean);

    if (cells.length === 0) continue;

    const pathCell = cells[0];
    // Workspace paths are consistently rendered as inline code in map tables.
    // Use that formatting instead of a hard-coded allowlist of root packages,
    // so a newly-added top-level workspace cannot evade drift detection.
    if (!pathCell.startsWith('`') || !pathCell.endsWith('`')) continue;
    const value = pathCell.replace(/^`|`$/g, '').trim();
    const cleaned = value.replace(/\/$/, '');
    if (!cleaned || cleaned === 'Path') continue;
    entries.add(cleaned);
  }

  return [...entries].sort();
}

function main() {
  const { repoRoot } = parseArgs();
  const workspaceEntries = collectWorkspaceEntries(repoRoot);
  const documentedEntries = collectDocumentedEntries(repoRoot);

  const undocumented = workspaceEntries.filter((entry) => !documentedEntries.includes(entry));
  const stale = documentedEntries.filter((entry) => !workspaceEntries.includes(entry));

  if (undocumented.length === 0 && stale.length === 0) {
    console.log('✓ Monorepo map is in sync with pnpm-workspace.yaml.');
    process.exit(0);
  }

  console.error('✗ Monorepo map drift detected.');

  if (undocumented.length > 0) {
    console.error('  Undocumented workspace entries missing from docs/monorepo-map.md:');
    for (const entry of undocumented) {
      console.error(`    - ${entry}`);
    }
  }

  if (stale.length > 0) {
    console.error('  Entries in docs/monorepo-map.md that are no longer in pnpm-workspace.yaml:');
    for (const entry of stale) {
      console.error(`    - ${entry}`);
    }
  }

  console.error('\nUpdate docs/monorepo-map.md to keep the map in sync with the workspace layout.');
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
