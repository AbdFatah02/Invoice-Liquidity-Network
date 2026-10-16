#!/usr/bin/env node
/**
 * check-sdk-support-windows.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Enforces the SDK versioning and support-window policy (issue #1211).
 *
 * Every SDK surface must declare a support window in
 * docs/sdk-support-windows.json, that window must agree with the surface's
 * published version, and docs/sdk-versioning.md must describe the surface.
 * Without this guard a release can ship a version that no document or
 * manifest claims to support — the "audited gap": a version with no declared
 * support window and no way for CI to notice when a window silently expires.
 *
 * Checks (all error-level, exit 1 on any finding):
 *   1. manifest-shape     docs/sdk-support-windows.json parses and every entry
 *                         carries the required fields.
 *   2. surface-coverage   every SDK surface (and only the SDK surfaces) has an
 *                         entry, named after the package that directory ships.
 *   3. version-drift      an entry's `version` equals the surface's
 *                         package.json version.
 *   4. window-validity    `introduced`/`eol` are ISO dates and `eol` is after
 *                         `introduced`.
 *   5. support-status     `status` is one of active/preview/deprecated/eol; an
 *                         active surface's window must not have closed.
 *   6. documented         docs/sdk-versioning.md mentions every surface's
 *                         package name and version.
 *
 * Usage:
 *   node scripts/check-sdk-support-windows.mjs [--root=<dir>] [--json=<file>]
 *
 * --json writes a machine-readable report (uploaded as a CI artifact by
 * .github/workflows/sdk-support-windows.yml). See
 * docs/runbooks/sdk-support-windows.md.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SDK_SURFACES } from './check-sdk-export-maps.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, '..');

export const SUPPORT_MANIFEST = 'docs/sdk-support-windows.json';
export const VERSIONING_DOC = 'docs/sdk-versioning.md';
export const STATUSES = Object.freeze(['active', 'preview', 'deprecated', 'eol']);

const REQUIRED_FIELDS = ['package', 'directory', 'version', 'channel', 'status', 'introduced'];

function toPosix(p) {
  return p.split(sep).join('/');
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function isIsoDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Validates the SDK support-window manifest and documentation.
 *
 * @param {string} [root] repository root
 * @param {object} [options]
 * @param {string} [options.today] override "today" (ISO date) for deterministic tests
 * @returns {{ findings: Array<object>, summary: object }}
 */
export function checkSdkSupportWindows(root = DEFAULT_ROOT, { today = todayUtc() } = {}) {
  const findings = [];
  const add = (rule, file, message) => findings.push({ rule, file, message });

  const manifestPath = join(root, SUPPORT_MANIFEST);
  if (!existsSync(manifestPath)) {
    add('manifest-shape', SUPPORT_MANIFEST, 'support-window manifest is missing');
    return { findings, summary: { total: 1, ok: false, checkedAt: new Date().toISOString() } };
  }

  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (err) {
    add('manifest-shape', SUPPORT_MANIFEST, `invalid JSON: ${err.message}`);
    return { findings, summary: { total: 1, ok: false, checkedAt: new Date().toISOString() } };
  }

  if (!Array.isArray(manifest.surfaces)) {
    add('manifest-shape', SUPPORT_MANIFEST, 'manifest must define a "surfaces" array');
    return { findings, summary: { total: 1, ok: false, checkedAt: new Date().toISOString() } };
  }

  const versioningDoc = join(root, VERSIONING_DOC);
  const docText = existsSync(versioningDoc) ? readFileSync(versioningDoc, 'utf8') : null;
  if (docText === null) {
    add('documented', VERSIONING_DOC, 'versioning documentation is missing');
  }

  const byPackage = new Map();
  manifest.surfaces.forEach((entry, index) => {
    const where = `${SUPPORT_MANIFEST}#surfaces[${index}]`;
    if (entry === null || typeof entry !== 'object') {
      add('manifest-shape', where, 'entry must be an object');
      return;
    }
    for (const field of REQUIRED_FIELDS) {
      if (entry[field] === undefined || entry[field] === '') {
        add('manifest-shape', where, `missing required field "${field}"`);
      }
    }
    if (typeof entry.package === 'string') byPackage.set(entry.package, entry);
  });

  for (const surface of SDK_SURFACES) {
    const entry = byPackage.get(surface.pkg);
    const manifestFile = SUPPORT_MANIFEST;

    if (!entry) {
      add(
        'surface-coverage',
        manifestFile,
        `no support window declared for ${surface.pkg} (${surface.dir}/)`
      );
      continue;
    }

    if (entry.directory !== surface.dir) {
      add(
        'surface-coverage',
        manifestFile,
        `${surface.pkg} declares directory "${entry.directory}", expected "${surface.dir}"`
      );
    }

    const pkgPath = join(root, surface.dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = readJson(pkgPath);
        if (entry.version !== pkg.version) {
          add(
            'version-drift',
            manifestFile,
            `${surface.pkg} support window declares version "${entry.version}" but ${surface.dir}/package.json is "${pkg.version}"`
          );
        }
      } catch (err) {
        add('version-drift', `${surface.dir}/package.json`, `invalid JSON: ${err.message}`);
      }
    }

    if (!isIsoDate(entry.introduced)) {
      add('window-validity', manifestFile, `${surface.pkg} "introduced" is not an ISO date`);
    }
    if (entry.eol !== null && entry.eol !== undefined && !isIsoDate(entry.eol)) {
      add('window-validity', manifestFile, `${surface.pkg} "eol" is neither null nor an ISO date`);
    }
    if (isIsoDate(entry.introduced) && isIsoDate(entry.eol) && entry.eol <= entry.introduced) {
      add(
        'window-validity',
        manifestFile,
        `${surface.pkg} "eol" (${entry.eol}) must be after "introduced" (${entry.introduced})`
      );
    }

    if (!STATUSES.includes(entry.status)) {
      add(
        'support-status',
        manifestFile,
        `${surface.pkg} status "${entry.status}" must be one of ${STATUSES.join(', ')}`
      );
    } else if ((entry.status === 'active' || entry.status === 'preview') && isIsoDate(entry.eol)) {
      if (entry.eol < today) {
        add(
          'support-status',
          manifestFile,
          `${surface.pkg} is "${entry.status}" but its support window closed on ${entry.eol} (today is ${today}) — mark it "eol" or extend the window`
        );
      }
    } else if (entry.status === 'eol' && isIsoDate(entry.eol) && entry.eol > today) {
      add(
        'support-status',
        manifestFile,
        `${surface.pkg} is marked "eol" but its window runs until ${entry.eol}`
      );
    }

    if (docText !== null && typeof entry.version === 'string') {
      if (!docText.includes(entry.package)) {
        add('documented', VERSIONING_DOC, `versioning docs do not mention ${entry.package}`);
      }
      if (!docText.includes(entry.version)) {
        add(
          'documented',
          VERSIONING_DOC,
          `versioning docs do not mention ${entry.package} version ${entry.version}`
        );
      }
    }
  }

  for (const entry of manifest.surfaces) {
    if (
      entry &&
      typeof entry.package === 'string' &&
      !SDK_SURFACES.some((s) => s.pkg === entry.package)
    ) {
      add(
        'surface-coverage',
        SUPPORT_MANIFEST,
        `unknown surface "${entry.package}" — remove it or add it to SDK_SURFACES`
      );
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));

  return {
    findings,
    summary: {
      total: findings.length,
      ok: findings.length === 0,
      surfaces: manifest.surfaces.map((e) => e.package).filter(Boolean),
      today,
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

  const report = checkSdkSupportWindows(root);

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(report, null, 2));
    console.log(`[sdk-support-windows] wrote JSON report to ${jsonOut}`);
  }

  if (report.findings.length > 0) {
    console.error(
      `\x1b[31m[sdk-support-windows] FAILED — ${report.findings.length} finding(s):\x1b[0m`
    );
    for (const f of report.findings) {
      console.error(`  - [${f.rule}] ${f.file}: ${f.message}`);
    }
    process.exit(1);
  }

  console.log(
    `\x1b[32m[sdk-support-windows] OK — ${report.summary.surfaces.length} surface(s) declare a valid support window\x1b[0m`
  );
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
