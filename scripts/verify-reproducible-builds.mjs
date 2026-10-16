#!/usr/bin/env node
/**
 * Verification of reproducible builds for SDK and CLI release artifacts (Issue #1078).
 *
 * Ensures that building and packaging `@iln/sdk` and `@invoice-liquidity/cli`
 * produces bit-for-bit identical release tarballs across independent builds.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');

export function getSourceDateEpoch(rootDir = ROOT_DIR) {
  if (process.env.SOURCE_DATE_EPOCH) {
    return process.env.SOURCE_DATE_EPOCH;
  }
  try {
    const timestamp = execSync('git log -1 --pretty=%ct', {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (timestamp && /^\d+$/.test(timestamp)) {
      return timestamp;
    }
  } catch {
    // Not a git repo or git not available
  }
  return '1700000000';
}

export function hashFile(filePath) {
  const fileBuffer = readFileSync(filePath);
  return createHash('sha256').update(fileBuffer).digest('hex');
}

export async function verifyPackageReproducibility(packageDir, packageName, options = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const epoch = options.sourceDateEpoch ?? getSourceDateEpoch(rootDir);
  const tempBase = join(tmpdir(), `repro-verify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dirA = join(tempBase, 'build-a');
  const dirB = join(tempBase, 'build-b');

  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });

  const env = {
    ...process.env,
    SOURCE_DATE_EPOCH: epoch,
  };

  try {
    // Build 1
    execSync(`pnpm --filter ${packageName} build`, {
      cwd: rootDir,
      env,
      stdio: options.verbose ? 'inherit' : 'pipe',
    });
    execSync(`pnpm pack --pack-destination "${dirA}"`, {
      cwd: join(rootDir, packageDir),
      env,
      stdio: options.verbose ? 'inherit' : 'pipe',
    });

    // Build 2
    execSync(`pnpm --filter ${packageName} build`, {
      cwd: rootDir,
      env,
      stdio: options.verbose ? 'inherit' : 'pipe',
    });
    execSync(`pnpm pack --pack-destination "${dirB}"`, {
      cwd: join(rootDir, packageDir),
      env,
      stdio: options.verbose ? 'inherit' : 'pipe',
    });

    const fileA = readdirSync(dirA).find((f) => f.endsWith('.tgz'));
    const fileB = readdirSync(dirB).find((f) => f.endsWith('.tgz'));

    if (!fileA || !fileB) {
      throw new Error(`Failed to generate release tarball for ${packageName}`);
    }

    const pathA = join(dirA, fileA);
    const pathB = join(dirB, fileB);

    const hashA = hashFile(pathA);
    const hashB = hashFile(pathB);

    const match = hashA === hashB;

    return {
      packageName,
      packageDir,
      artifactName: fileA,
      hashA,
      hashB,
      match,
    };
  } finally {
    if (existsSync(tempBase)) {
      rmSync(tempBase, { recursive: true, force: true });
    }
  }
}

export async function verifyReproducibleBuilds(targets = [
  { packageDir: 'sdk', packageName: '@iln/sdk' },
  { packageDir: 'cli', packageName: '@invoice-liquidity/cli' },
], options = {}) {
  const results = [];
  let allMatched = true;

  console.log(`[reproducible-builds] Verifying ${targets.length} package artifacts with SOURCE_DATE_EPOCH=${options.sourceDateEpoch ?? getSourceDateEpoch()}...`);

  for (const target of targets) {
    console.log(`[reproducible-builds] Building and packing ${target.packageName} twice...`);
    const result = await verifyPackageReproducibility(target.packageDir, target.packageName, options);
    results.push(result);

    if (result.match) {
      console.log(`✔ [reproducible-builds] ${target.packageName} (${result.artifactName}) is reproducible:`);
      console.log(`   SHA256: ${result.hashA}`);
    } else {
      allMatched = false;
      console.error(`✖ [reproducible-builds] Mismatch in ${target.packageName} builds:`);
      console.error(`   Build A: ${result.hashA}`);
      console.error(`   Build B: ${result.hashB}`);
    }
  }

  return {
    success: allMatched,
    results,
  };
}

// Direct execution
if (process.argv[1] === __filename) {
  const verbose = process.argv.includes('--verbose');
  verifyReproducibleBuilds(undefined, { verbose })
    .then(({ success }) => {
      if (!success) {
        process.exit(1);
      }
      console.log('✔ [reproducible-builds] All package release artifacts verified reproducible.');
    })
    .catch((err) => {
      console.error('Fatal error verifying reproducible builds:', err);
      process.exit(1);
    });
}
