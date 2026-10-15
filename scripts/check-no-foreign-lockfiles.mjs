#!/usr/bin/env node

/**
 * Fails if any npm (`package-lock.json`) or yarn (`yarn.lock`) lockfile is
 * present anywhere in the repo. This is a pnpm workspace and must have
 * exactly one lockfile: the root `pnpm-lock.yaml`.
 *
 * Usage: node scripts/check-no-foreign-lockfiles.mjs
 */

import { readdirSync, lstatSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(process.env.ILN_REPO_ROOT || resolve(__dirname, '..'));

// These lockfiles indicate that an installer other than pnpm has been run.
// Keep the pnpm lockfile at the workspace root as the sole allowed lockfile.
const FORBIDDEN_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);
const IGNORED_DIR_NAMES = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.next']);

function walk(dir, found) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = lstatSync(fullPath);
    if (stats.isSymbolicLink()) {
      // Never follow links outside the checkout, but reject a linked lockfile
      // itself so a symlink cannot disguise a forbidden package-manager file.
      if (FORBIDDEN_NAMES.has(entry)) found.push(fullPath);
    } else if (stats.isDirectory()) {
      if (IGNORED_DIR_NAMES.has(entry)) continue;
      walk(fullPath, found);
    } else if (FORBIDDEN_NAMES.has(entry)) {
      found.push(fullPath);
    }
  }
}

const found = [];
walk(rootDir, found);

if (found.length > 0) {
  console.error('Found forbidden lockfile(s). This repo uses pnpm exclusively:\n');
  for (const filePath of found) {
    console.error(`  - ${filePath.replace(rootDir + '\\', '').replace(rootDir + '/', '')}`);
  }
  console.error('\nRemove them and use pnpm-lock.yaml at the repo root instead.');
  process.exit(1);
}

console.log('No foreign lockfiles found.');
