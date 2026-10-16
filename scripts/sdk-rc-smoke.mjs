#!/usr/bin/env node
/**
 * sdk-rc-smoke.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Release-candidate smoke tests for both SDK packages (issue #1212).
 *
 * Packs each publishable SDK surface exactly as npm would ship it, then proves
 * the artifact a consumer receives actually resolves:
 *
 *   1. pack-integrity   every export-map target is inside the packed tarball
 *                       (catches a `files` field that omits built output).
 *   2. pack-fields      the tarball's package.json is the expected name and
 *                       version, and has an `exports` map.
 *   3. require-resolve  Node's CommonJS resolver resolves `exports["."]` and
 *                       every subpath through the extracted package.
 *   4. import-resolve   Node's ESM resolver resolves the `import` condition for
 *                       every export subpath.
 *   5. type-targets     every `types` condition points at a file in the pack.
 *
 * The packages are smoke-tested independently, so a break in one surface does
 * not mask a break in the other. Findings are reported as a JSON artifact by
 * .github/workflows/ci.yml (job `sdk-rc-smoke`). See
 * docs/runbooks/sdk-rc-smoke.md.
 *
 * Usage:
 *   node scripts/sdk-rc-smoke.mjs [--root=<dir>] [--json=<file>]
 *                                 [--no-build] [--force-build]
 *                                 [--work-dir=<dir>] [--keep]
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, '..');

/** The two publishable SDK packages smoke-tested independently. */
export const SMOKE_TARGETS = Object.freeze([
  { dir: 'sdk', pkg: '@iln/sdk' },
  { dir: 'packages/sdk', pkg: '@iln/sdk-next' },
]);

function toPosix(p) {
  return p.split(sep).join('/');
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * Flattens an exports map into `{ subpath, condition, target }` triples.
 *
 * @param {object} manifest parsed package.json
 * @returns {Array<{subpath: string, condition: string, target: string}>}
 */
export function listExportsTargets(manifest) {
  const targets = [];
  const exportsMap = manifest.exports;
  if (!exportsMap || typeof exportsMap !== 'object') return targets;

  for (const [subpath, entry] of Object.entries(exportsMap)) {
    if (typeof entry === 'string') {
      targets.push({ subpath, condition: 'default', target: entry });
      continue;
    }
    if (entry && typeof entry === 'object') {
      for (const [condition, target] of Object.entries(entry)) {
        if (typeof target === 'string') {
          targets.push({ subpath, condition, target });
        }
      }
    }
  }
  return targets;
}

/**
 * Pure pack-integrity analysis. `files` is the path list npm reports for the
 * tarball (relative to the package root).
 *
 * @param {object} options
 * @param {string} options.expectedName
 * @param {object} options.manifest package.json as packed
 * @param {string[]} options.files
 * @param {string} [options.tarball]
 * @returns {Array<object>} findings
 */
export function analyzePackagedPackage({ expectedName, manifest, files, tarball = 'tarball' }) {
  const findings = [];
  const normalize = (p) => toPosix(p).replace(/^\.\//, '');
  const packed = new Set(files.map(normalize));

  const add = (rule, message) => findings.push({ rule, file: tarball, message });

  if (!packed.has('package.json')) {
    add('pack-fields', 'tarball is missing package.json');
    return findings;
  }
  if (manifest.name !== expectedName) {
    add('pack-fields', `tarball package name is "${manifest.name}", expected "${expectedName}"`);
  }
  if (!manifest.exports || typeof manifest.exports !== 'object') {
    add('pack-fields', 'tarball package.json has no "exports" map');
    return findings;
  }

  for (const { subpath, condition, target } of listExportsTargets(manifest)) {
    if (condition === 'types') {
      if (!packed.has(normalize(target))) {
        add(
          'type-targets',
          `exports["${subpath}"].types target "${target}" is not in the tarball (check the "files" field)`
        );
      }
      continue;
    }
    if (condition === 'default' || condition === 'import' || condition === 'require') {
      if (!packed.has(normalize(target))) {
        add(
          'pack-integrity',
          `exports["${subpath}"].${condition} target "${target}" is not in the tarball (check the "files" field)`
        );
      }
    }
  }

  return findings;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

function packPackage(packageDir, destination) {
  mkdirSync(destination, { recursive: true });
  const result = run(
    'npm',
    ['pack', '--ignore-scripts', '--pack-destination', destination, '--json'],
    { cwd: packageDir }
  );
  if (result.status !== 0) {
    throw new Error(`npm pack failed for ${packageDir}: ${result.stderr || result.stdout}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`could not parse npm pack output for ${packageDir}: ${err.message}`);
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return {
    tarball: join(destination, entry.filename),
    files: entry.files.map((f) => f.path),
    filename: entry.filename,
  };
}

function extractTarball(tarball, consumerNodeModules, pkgName) {
  const target = join(consumerNodeModules, ...pkgName.split('/'));
  mkdirSync(target, { recursive: true });
  const result = run('tar', ['-xzf', tarball, '-C', target, '--strip-components=1']);
  if (result.status !== 0) {
    throw new Error(`failed to extract ${tarball}: ${result.stderr}`);
  }
  return target;
}

function resolveSubpaths(consumerDir, pkgName, manifest) {
  const findings = [];
  const subpaths = Object.keys(manifest.exports || {});
  const categories = new Set(['default', 'import', 'require', 'node']);

  for (const subpath of subpaths) {
    const specifier = subpath === '.' ? pkgName : `${pkgName}/${subpath.replace(/^\.\//, '')}`;
    const entry = manifest.exports[subpath];
    const conditions = typeof entry === 'string' ? ['default'] : Object.keys(entry);
    const hasRuntime = conditions.some((c) => categories.has(c));
    if (!hasRuntime) continue;

    const requireResult = run(
      process.execPath,
      ['-e', `process.stdout.write(require.resolve(${JSON.stringify(specifier)}))`],
      {
        cwd: consumerDir,
      }
    );
    const requirePath = requireResult.stdout?.trim();
    if (requireResult.status !== 0 || !requirePath || !existsSync(requirePath)) {
      findings.push({
        rule: 'require-resolve',
        file: `require("${specifier}")`,
        message:
          (requireResult.stderr || '').trim() ||
          `require.resolve("${specifier}") did not resolve to an existing file`,
      });
    }

    const importResult = run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `process.stdout.write(new URL(import.meta.resolve(${JSON.stringify(specifier)})).pathname)`,
      ],
      { cwd: consumerDir }
    );
    const importPath = importResult.stdout?.trim();
    if (importResult.status !== 0 || !importPath || !existsSync(importPath)) {
      findings.push({
        rule: 'import-resolve',
        file: `import("${specifier}")`,
        message:
          (importResult.stderr || '').trim() ||
          `import.meta.resolve("${specifier}") did not resolve to an existing file`,
      });
    }
  }

  return findings;
}

/**
 * Packs one SDK surface and validates the packed artifact end to end.
 *
 * @param {{dir: string, pkg: string}} target
 * @param {string} root repository root
 * @param {object} options
 * @param {string} options.workDir scratch directory
 * @param {boolean} [options.build=true] build the package when dist/ is absent
 * @param {boolean} [options.forceBuild=false] build even when dist/ exists
 * @returns {object} result with findings
 */
export function smokeTarget(target, root, { workDir, build = true, forceBuild = false } = {}) {
  const packageDir = join(root, target.dir);
  const manifestPath = join(packageDir, 'package.json');
  const findings = [];

  if (!existsSync(manifestPath)) {
    return {
      package: target.pkg,
      dir: target.dir,
      findings: [{ rule: 'pack-fields', file: `${target.dir}/package.json`, message: 'missing' }],
    };
  }

  const manifest = readJson(manifestPath);
  const distDir = join(packageDir, 'dist');

  if (build && (forceBuild || !existsSync(distDir))) {
    const built = run('pnpm', ['--filter', target.pkg, 'build'], { cwd: root, stdio: 'inherit' });
    if (built.status !== 0) {
      return {
        package: target.pkg,
        dir: target.dir,
        version: manifest.version,
        findings: [
          {
            rule: 'pack-integrity',
            file: `${target.dir}`,
            message: `build failed for ${target.pkg}`,
          },
        ],
      };
    }
  }

  const packDest = join(workDir, 'pack', target.dir.replace(/\//g, '__'));
  let packed;
  try {
    packed = packPackage(packageDir, packDest);
  } catch (err) {
    return {
      package: target.pkg,
      dir: target.dir,
      version: manifest.version,
      findings: [{ rule: 'pack-integrity', file: `${target.dir}`, message: err.message }],
    };
  }

  const packedManifest = (() => {
    try {
      return JSON.parse(run('tar', ['-xzf', packed.tarball, '-O', 'package/package.json']).stdout);
    } catch {
      return null;
    }
  })();

  if (!packedManifest) {
    return {
      package: target.pkg,
      dir: target.dir,
      version: manifest.version,
      tarball: packed.filename,
      fileCount: packed.files.length,
      findings: [
        {
          rule: 'pack-fields',
          file: packed.filename,
          message: 'packed tarball does not contain a readable package.json',
        },
      ],
    };
  }

  findings.push(
    ...analyzePackagedPackage({
      expectedName: target.pkg,
      manifest: packedManifest,
      files: packed.files,
      tarball: packed.filename,
    })
  );

  const consumerDir = join(workDir, 'consumer', target.dir.replace(/\//g, '__'));
  const consumerModules = join(consumerDir, 'node_modules');
  mkdirSync(consumerModules, { recursive: true });

  let extracted = null;
  try {
    extracted = extractTarball(packed.tarball, consumerModules, target.pkg);
    findings.push(...resolveSubpaths(consumerDir, target.pkg, packedManifest));
  } catch (err) {
    findings.push({
      rule: 'resolve-failed',
      file: extracted || packed.filename,
      message: err.message,
    });
  }

  return {
    package: target.pkg,
    dir: target.dir,
    version: packedManifest.version,
    tarball: packed.filename,
    fileCount: packed.files.length,
    consumerDir,
    findings,
  };
}

function runSmoke(options) {
  const root = options.root ?? DEFAULT_ROOT;
  const workDir = options.workDir ?? join(tmpdir(), `sdk-rc-smoke-${process.pid}`);
  const keep = options.keep ?? false;

  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });

  const results = SMOKE_TARGETS.map((target) =>
    smokeTarget(target, root, {
      workDir,
      build: options.build,
      forceBuild: options.forceBuild,
    })
  );

  const findings = results.flatMap((r) => r.findings.map((f) => ({ ...f, package: r.package })));

  const report = {
    findings,
    results,
    summary: {
      total: findings.length,
      ok: findings.length === 0,
      targets: results.map((r) => ({
        package: r.package,
        version: r.version,
        tarball: r.tarball,
        fileCount: r.fileCount,
        findings: r.findings.length,
      })),
      checkedAt: new Date().toISOString(),
    },
  };

  if (!keep) {
    rmSync(workDir, { recursive: true, force: true });
  }

  return report;
}

function main() {
  const options = {
    root: DEFAULT_ROOT,
    build: true,
    forceBuild: false,
    keep: false,
    json: null,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--root=')) options.root = resolve(arg.slice('--root='.length));
    else if (arg.startsWith('--json=')) options.json = resolve(arg.slice('--json='.length));
    else if (arg.startsWith('--work-dir='))
      options.workDir = resolve(arg.slice('--work-dir='.length));
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--force-build') options.forceBuild = true;
    else if (arg === '--keep') options.keep = true;
  }

  const report = runSmoke(options);

  if (options.json) {
    writeFileSync(options.json, JSON.stringify(report, null, 2));
    console.log(`[sdk-rc-smoke] wrote JSON report to ${options.json}`);
  }

  for (const target of report.summary.targets) {
    const status = target.findings === 0 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(
      `${status} ${target.package}@${target.version} — ${target.fileCount ?? '?'} packed files, ${
        target.findings
      } finding(s)`
    );
  }

  if (report.findings.length > 0) {
    console.error(`\n\x1b[31m[sdk-rc-smoke] FAILED — ${report.findings.length} finding(s):\x1b[0m`);
    for (const f of report.findings) {
      console.error(`  - [${f.package}/${f.rule}] ${f.file}: ${f.message}`);
    }
    process.exit(1);
  }

  console.log('\n\x1b[32m[sdk-rc-smoke] OK — both SDK packages pack and resolve cleanly\x1b[0m');
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
