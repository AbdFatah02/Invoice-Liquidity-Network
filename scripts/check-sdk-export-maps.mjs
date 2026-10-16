#!/usr/bin/env node
/**
 * check-sdk-export-maps.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Enforces a consistent `exports` contract across every SDK surface
 * (issue #1210).
 *
 * The three SDK surfaces (`sdk/` → @iln/sdk, `packages/sdk/` → @iln/sdk-next,
 * `packages/react/` → @iln/react) are consumed through their export maps by
 * Node (CJS + ESM), bundlers (browser/import) and TypeScript
 * (`node16`/`nodenext`/`bundler` resolution). The maps had drifted apart:
 * some listed `types` last (TypeScript resolves the first matching condition,
 * so a `types` entry after a runtime condition can be shadowed), and some
 * top-level `main`/`module`/`types` fields disagreed with `exports["."]`.
 *
 * Invariants enforced (all error-level, exit 1 on any finding):
 *   1. exports-present     the package declares `exports` with a `"."` entry.
 *   2. condition-contract  `exports["."]` exposes `types`, `import` and
 *                          `require` — the shared contract every surface keeps.
 *   3. types-first         when an export condition object declares `types`,
 *                          it is the first key (TypeScript resolution order).
 *   4. target-relative     every export target is a relative `./…` path.
 *   5. legacy-field-drift  top-level `main`/`module`/`types` (when present)
 *                          equal the matching `exports["."]` conditions, so
 *                          resolvers that ignore `exports` see the same files.
 *   6. example-specifier   an example that depends on `@iln/sdk` uses a
 *                          `file:`/`workspace:` specifier that resolves to the
 *                          canonical `sdk/` package — never a version range
 *                          that would fetch an absent npm release.
 *
 * Usage:
 *   node scripts/check-sdk-export-maps.mjs [--root=<dir>] [--json=<file>]
 *
 * --json writes a machine-readable report (uploaded as a CI artifact by
 * .github/workflows/sdk-export-maps.yml). See docs/runbooks/sdk-export-maps.md.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, '..');

/** Every SDK surface whose export map must honour the shared contract. */
export const SDK_SURFACES = Object.freeze([
  { dir: 'sdk', pkg: '@iln/sdk' },
  { dir: 'packages/sdk', pkg: '@iln/sdk-next' },
  { dir: 'packages/react', pkg: '@iln/react' },
]);

/** Conditions every `exports["."]` entry must keep, in this order. */
export const REQUIRED_CONDITIONS = Object.freeze(['types', 'import', 'require']);

/** Legacy top-level fields and the `exports["."]` condition each mirrors. */
const LEGACY_FIELDS = Object.freeze([
  ['main', 'require'],
  ['module', 'import'],
  ['types', 'types'],
]);

function toPosix(p) {
  return p.split(sep).join('/');
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function isConditionObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates one package manifest's export map against the shared contract.
 *
 * @param {object} pkg parsed package.json
 * @param {string} file posix-relative manifest path (reporting only)
 * @param {(msg: string) => void} add finding sink
 */
function checkManifest(pkg, file, add) {
  if (!isConditionObject(pkg.exports)) {
    add({
      rule: 'exports-present',
      file,
      message: 'package.json must declare an "exports" map with a "." entry',
    });
    return;
  }

  const root = pkg.exports['.'];
  if (root === undefined) {
    add({
      rule: 'exports-present',
      file,
      message: 'exports map must contain a "." entry',
    });
    return;
  }

  if (!isConditionObject(root)) {
    add({
      rule: 'exports-present',
      file,
      message:
        'exports["."] must be a condition object (not a bare path) so types/import/require can all be declared',
    });
    return;
  }

  for (const condition of REQUIRED_CONDITIONS) {
    if (root[condition] === undefined) {
      add({
        rule: 'condition-contract',
        file,
        message: `exports["."] is missing the required "${condition}" condition`,
      });
    }
  }

  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    if (typeof entry === 'string') {
      if (!entry.startsWith('./')) {
        add({
          rule: 'target-relative',
          file,
          message: `exports["${subpath}"] target "${entry}" must be a relative "./…" path`,
        });
      }
      continue;
    }
    if (!isConditionObject(entry)) {
      add({
        rule: 'target-relative',
        file,
        message: `exports["${subpath}"] must be a string or a condition object`,
      });
      continue;
    }

    const keys = Object.keys(entry);
    if (keys.includes('types') && keys[0] !== 'types') {
      add({
        rule: 'types-first',
        file,
        message: `exports["${subpath}"] lists "types" at position ${
          keys.indexOf('types') + 1
        }; it must be the first condition so TypeScript resolves declarations`,
      });
    }

    for (const [condition, target] of Object.entries(entry)) {
      if (typeof target !== 'string' || !target.startsWith('./')) {
        add({
          rule: 'target-relative',
          file,
          message: `exports["${subpath}"].${condition} target "${target}" must be a relative "./…" path`,
        });
      }
    }
  }

  for (const [field, condition] of LEGACY_FIELDS) {
    const legacy = pkg[field];
    const fromExports = root[condition];
    if (typeof legacy === 'string' && typeof fromExports === 'string' && legacy !== fromExports) {
      add({
        rule: 'legacy-field-drift',
        file,
        message: `top-level "${field}" is "${legacy}" but exports["."].${condition} is "${fromExports}" — resolvers that ignore exports would load different files`,
      });
    }
  }
}

/**
 * Validates example manifests so their SDK specifier resolves in-repo.
 *
 * @param {string} root repository root
 * @param {(msg: string) => void} add finding sink
 */
function checkExamples(root, add) {
  const examplesDir = join(root, 'examples');
  if (!existsSync(examplesDir)) return;

  for (const entry of readdirSync(examplesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(examplesDir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;

    const file = toPosix(relative(root, manifestPath));
    let pkg;
    try {
      pkg = readJson(manifestPath);
    } catch (err) {
      add({ rule: 'example-specifier', file, message: `Invalid JSON: ${err.message}` });
      continue;
    }

    const spec = { ...pkg.dependencies, ...pkg.devDependencies }['@iln/sdk'];
    if (spec === undefined) continue;

    if (typeof spec !== 'string' || !(spec.startsWith('file:') || spec.startsWith('workspace:'))) {
      add({
        rule: 'example-specifier',
        file,
        message: `"@iln/sdk": "${spec}" must be a file:/workspace: specifier resolving to the in-repo sdk/ package (no published release exists for a bare version range)`,
      });
      continue;
    }

    if (spec.startsWith('file:')) {
      const targetDir = resolve(dirname(manifestPath), spec.slice('file:'.length));
      const targetManifest = join(targetDir, 'package.json');
      if (!existsSync(targetManifest)) {
        add({
          rule: 'example-specifier',
          file,
          message: `"@iln/sdk": "${spec}" resolves to a missing package at ${toPosix(
            relative(root, targetDir)
          )}`,
        });
        continue;
      }
      let target;
      try {
        target = readJson(targetManifest);
      } catch (err) {
        add({ rule: 'example-specifier', file, message: `Could not read ${spec}: ${err.message}` });
        continue;
      }
      if (target.name !== '@iln/sdk') {
        add({
          rule: 'example-specifier',
          file,
          message: `"@iln/sdk": "${spec}" resolves to package "${target.name}", expected "@iln/sdk"`,
        });
      }
    }
  }
}

/**
 * Validates export-map consistency across every SDK surface.
 *
 * @param {string} [root] repository root
 * @returns {{ findings: Array<object>, summary: object }}
 */
export function checkSdkExportMaps(root = DEFAULT_ROOT) {
  const findings = [];
  const add = (finding) => findings.push(finding);

  for (const surface of SDK_SURFACES) {
    const manifestPath = join(root, surface.dir, 'package.json');
    if (!existsSync(manifestPath)) {
      add({
        rule: 'exports-present',
        file: `${surface.dir}/package.json`,
        message: `SDK surface manifest missing for ${surface.pkg}`,
      });
      continue;
    }

    let pkg;
    try {
      pkg = readJson(manifestPath);
    } catch (err) {
      add({
        rule: 'exports-present',
        file: `${surface.dir}/package.json`,
        message: `Invalid JSON: ${err.message}`,
      });
      continue;
    }

    if (pkg.name !== surface.pkg) {
      add({
        rule: 'exports-present',
        file: `${surface.dir}/package.json`,
        message: `expected package name "${surface.pkg}", found "${pkg.name}"`,
      });
    }

    checkManifest(pkg, `${surface.dir}/package.json`, add);
  }

  checkExamples(root, add);

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));

  return {
    findings,
    summary: {
      total: findings.length,
      ok: findings.length === 0,
      surfaces: SDK_SURFACES.map((s) => s.pkg),
      checkedAt: new Date().toISOString(),
    },
  };
}

function main() {
  let root = DEFAULT_ROOT;
  let jsonOut = null;

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--root=')) root = resolve(arg.slice('--root='.length));
    else if (arg.startsWith('--json=')) jsonOut = resolve(arg.slice('--json='.length));
  }

  const report = checkSdkExportMaps(root);

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(report, null, 2));
    console.log(`[sdk-export-maps] wrote JSON report to ${jsonOut}`);
  }

  if (report.findings.length > 0) {
    console.error(
      `\x1b[31m[sdk-export-maps] FAILED — ${report.findings.length} finding(s):\x1b[0m`
    );
    for (const f of report.findings) {
      console.error(`  - [${f.rule}] ${f.file}: ${f.message}`);
    }
    process.exit(1);
  }

  console.log(
    `\x1b[32m[sdk-export-maps] OK — ${report.summary.surfaces.join(
      ', '
    )} share one export contract\x1b[0m`
  );
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
