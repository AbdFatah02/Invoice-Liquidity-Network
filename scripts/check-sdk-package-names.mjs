#!/usr/bin/env node
/**
 * check-sdk-package-names.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Enforces the canonical SDK package names (issue #1218).
 *
 *   sdk/            → @iln/sdk        (stable, production SDK)
 *   packages/sdk/   → @iln/sdk-next   (experimental browser-first rewrite)
 *
 * The SDK was historically documented as `@invoice-liquidity/sdk`, a name no
 * workspace package carries. References to it resolve to nothing: a
 * `pnpm --filter @invoice-liquidity/sdk` matches zero projects (silently
 * skipping the job), a rollup `external` entry under that name lets the real
 * `@iln/sdk` get bundled, and an install snippet under that name pulls a
 * package this repository does not release.
 *
 * Checks (all error-level, exit 1 on any finding):
 *   1. manifest-name      sdk/ and packages/sdk/ carry their canonical names.
 *   2. legacy-dependency  no package.json depends on a legacy SDK name.
 *   3. path-mismatch      a file:/link: dependency on sdk/ or packages/sdk/ is
 *                         declared under the name that directory publishes.
 *   4. dual-declaration   a package does not list the SDK in both
 *                         `dependencies` and `peerDependencies` (two SDK
 *                         instances at runtime).
 *   5. peer-range         a peerDependencies range on the SDK accepts the
 *                         SDK's current version.
 *   6. legacy-reference   no tracked source/doc/workflow text mentions a legacy
 *                         SDK name, except historical files (changelogs,
 *                         history/) and lines carrying the pragma
 *                         `sdk-name-check: allow-legacy`.
 *   7. table-mismatch     a markdown table row of the form
 *                         | `sdk/` | `<name>` | names the package that
 *                         directory actually publishes.
 *
 * Usage:
 *   node scripts/check-sdk-package-names.mjs [--root=<dir>] [--json=<file>]
 *
 * --json writes a machine-readable report (uploaded as a CI artifact by
 * .github/workflows/sdk-package-names.yml). See docs/runbooks/sdk-package-names.md.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CANONICAL_PACKAGES = Object.freeze({
  sdk: '@iln/sdk',
  'packages/sdk': '@iln/sdk-next',
});

/** Names the SDK has been (incorrectly) published or documented under. */
export const LEGACY_NAMES = Object.freeze([
  '@invoice-liquidity/sdk',
  '@invoice-liquidity/sdk-next',
]);

export const ALLOW_PRAGMA = 'sdk-name-check: allow-legacy';

const SDK_NAMES = new Set(Object.values(CANONICAL_PACKAGES));

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'target',
  '__fixtures__',
  '.pnpm-store',
]);

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.json',
  '.yml',
  '.yaml',
]);

/** Files that legitimately mention legacy names (history, or this guard). */
const ALLOWED_PATHS = [
  /(^|\/)CHANGELOG\.md$/,
  /^history\//,
  /^release-audit\//,
  /^pnpm-lock\.yaml$/,
  /^scripts\/check-sdk-package-names\.mjs$/,
  /^scripts\/__tests__\/check-sdk-package-names\.test\.mjs$/,
];

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

// A legacy name followed by an identifier character is a different package
// (e.g. `@invoice-liquidity/sdkx`); `/subpath`, `@version`, quotes are matches.
const LEGACY_RE = new RegExp(
  `(${[...LEGACY_NAMES]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')})(?![A-Za-z0-9_-])`,
  'g'
);

const LEGACY_DEP_KEY_RE = new RegExp(
  `^[ \\t]*"(?:${LEGACY_NAMES.map(escapeRegExp).join(
    '|'
  )})"[ \\t]*:[ \\t]*"(?:file|link|workspace|npm|[~^>=<*\\d])[^"\\n]*",?[ \\t]*$`,
  'gm'
);

export function findLegacyReferences(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes(ALLOW_PRAGMA)) return;
    LEGACY_RE.lastIndex = 0;
    let m;
    while ((m = LEGACY_RE.exec(line)) !== null) {
      hits.push({ line: i + 1, column: m.index + 1, name: m[1] });
    }
  });
  return hits;
}

function toPosix(p) {
  return p.split(sep).join('/');
}

function walk(root, dir = root, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(root, join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(toPosix(relative(root, join(dir, entry.name))));
    }
  }
  return out;
}

function extname(p) {
  const i = p.lastIndexOf('.');
  return i === -1 ? '' : p.slice(i);
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? m.slice(1).map(Number) : null;
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Minimal semver range check covering the forms used in this repo:
 * `*`, `x.y.z`, `^x.y.z`, `~x.y.z`, `>=x.y.z`, `workspace:*|^|~`, and
 * `||`-joined alternatives.
 */
export function rangeAccepts(range, version) {
  const v = parseVersion(version);
  if (!v) return false;
  return range.split('||').some((raw) => {
    let r = raw.trim();
    if (r.startsWith('workspace:')) r = r.slice('workspace:'.length);
    if (r === '' || r === '*' || r === '^' || r === '~' || r === 'latest') return true;
    const op = /^(\^|~|>=)?/.exec(r)[1] ?? '';
    const base = parseVersion(r.slice(op.length));
    if (!base) return false;
    if (op === '') return cmp(v, base) === 0;
    if (op === '>=') return cmp(v, base) >= 0;
    if (cmp(v, base) < 0) return false;
    if (op === '~') return v[0] === base[0] && v[1] === base[1];
    // caret
    if (base[0] > 0) return v[0] === base[0];
    if (base[1] > 0) return v[0] === 0 && v[1] === base[1];
    return cmp(v, base) === 0;
  });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const TABLE_ROW_RE = /^\s*\|\s*`((?:packages\/)?sdk)\/?`\s*\|\s*`(@[^`]+)`/;

/** Flags `| \`sdk/\` | \`@name\` |` table rows that name the wrong package. */
export function findTableMismatches(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = TABLE_ROW_RE.exec(line);
    if (!m) return;
    const expected = CANONICAL_PACKAGES[m[1]];
    if (m[2] !== expected) hits.push({ line: i + 1, dir: m[1], name: m[2], expected });
  });
  return hits;
}

export function checkRepository(root, { exclude = [] } = {}) {
  const findings = [];
  const add = (f) => findings.push(f);

  // 1. Canonical manifests.
  const sdkVersions = {};
  for (const [dir, expected] of Object.entries(CANONICAL_PACKAGES)) {
    const manifest = join(root, dir, 'package.json');
    if (!existsSync(manifest)) {
      add({
        rule: 'manifest-name',
        file: `${dir}/package.json`,
        line: 1,
        message: `missing; expected package "${expected}"`,
      });
      continue;
    }
    const pkg = readJson(manifest);
    sdkVersions[expected] = pkg.version;
    if (pkg.name !== expected) {
      add({
        rule: 'manifest-name',
        file: `${dir}/package.json`,
        line: 2,
        message: `name is "${pkg.name}", expected canonical "${expected}"`,
      });
    }
  }

  const excluded = new Set(exclude.map((p) => toPosix(relative(root, resolve(p)))));
  const files = walk(root)
    .filter((f) => !excluded.has(f))
    .sort();

  // 2–5. Dependency declarations in every package.json.
  for (const file of files) {
    if (!file.endsWith('package.json')) continue;
    if (Object.keys(CANONICAL_PACKAGES).some((d) => file === `${d}/package.json`)) continue;
    let pkg;
    try {
      pkg = readJson(join(root, file));
    } catch {
      continue;
    }
    const pkgDir = dirname(join(root, file));
    for (const field of DEP_FIELDS) {
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        if (LEGACY_NAMES.includes(name)) {
          add({
            rule: 'legacy-dependency',
            file,
            field,
            message: `${field} declares legacy "${name}"; use the canonical name`,
          });
        }
        const m = /^(?:file|link):(.+)$/.exec(String(spec));
        if (m) {
          const target = toPosix(relative(root, resolve(pkgDir, m[1])));
          const expected = CANONICAL_PACKAGES[target];
          if (expected && name !== expected) {
            add({
              rule: 'path-mismatch',
              file,
              field,
              message: `"${name}" points at ${target}/ which publishes "${expected}"`,
            });
          }
        }
      }
    }
    for (const name of SDK_NAMES) {
      if (pkg.dependencies?.[name] && pkg.peerDependencies?.[name]) {
        add({
          rule: 'dual-declaration',
          file,
          field: 'dependencies',
          message: `"${name}" is in both dependencies and peerDependencies; keep it as a peer (devDependency for local builds)`,
        });
      }
      const peer = pkg.peerDependencies?.[name];
      if (peer && sdkVersions[name] && !rangeAccepts(peer, sdkVersions[name])) {
        add({
          rule: 'peer-range',
          file,
          field: 'peerDependencies',
          message: `peer range "${peer}" for "${name}" does not accept current version ${sdkVersions[name]}`,
        });
      }
    }
  }

  // 6. Legacy references in text.
  for (const file of files) {
    if (!TEXT_EXTENSIONS.has(extname(file))) continue;
    if (ALLOWED_PATHS.some((re) => re.test(file))) continue;
    const abs = join(root, file);
    if (statSync(abs).size > 2_000_000) continue;
    const text = readFileSync(abs, 'utf8');
    if (file.endsWith('.md') || file.endsWith('.mdx')) {
      for (const hit of findTableMismatches(text)) {
        add({
          rule: 'table-mismatch',
          file,
          line: hit.line,
          message: `table lists ${hit.dir}/ as "${hit.name}" but it publishes "${hit.expected}"`,
        });
      }
    }
    // Legacy dependency keys in package.json are already reported by
    // legacy-dependency; only scan the rest (e.g. `pnpm --filter` scripts).
    const scanned = file.endsWith('package.json')
      ? text.replace(LEGACY_DEP_KEY_RE, (line) => ' '.repeat(line.length))
      : text;
    for (const hit of findLegacyReferences(scanned)) {
      add({
        rule: 'legacy-reference',
        file,
        line: hit.line,
        column: hit.column,
        message: `legacy SDK name "${hit.name}" — use "${
          hit.name.endsWith('-next') ? '@iln/sdk-next' : '@iln/sdk'
        }"`,
      });
    }
  }

  findings.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.column ?? 0) - (b.column ?? 0) ||
      a.rule.localeCompare(b.rule)
  );

  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;

  return {
    canonical: { ...CANONICAL_PACKAGES },
    legacyNames: [...LEGACY_NAMES],
    summary: {
      ok: findings.length === 0,
      total: findings.length,
      filesWithFindings: new Set(findings.map((f) => f.file)).size,
      byRule,
    },
    findings,
  };
}

function parseArgs(argv) {
  const args = { root: null, json: null };
  for (const a of argv) {
    if (a.startsWith('--root=')) args.root = a.slice(7);
    else if (a.startsWith('--json=')) args.json = a.slice(7);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  // Never scan our own report (it quotes every legacy name it found).
  const report = checkRepository(root, { exclude: args.json ? [args.json] : [] });

  if (args.json) {
    writeFileSync(
      args.json,
      JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2) + '\n'
    );
  }

  for (const f of report.findings) {
    const loc = f.line ? `${f.file}:${f.line}${f.column ? `:${f.column}` : ''}` : f.file;
    console.log(
      `::error file=${f.file}${f.line ? `,line=${f.line}` : ''}::[${f.rule}] ${f.message}`
    );
    if (!process.env.GITHUB_ACTIONS) console.log(`  ${loc}`);
  }
  const { total, filesWithFindings, byRule } = report.summary;
  if (report.summary.ok) {
    console.log(
      `sdk-package-names: OK — canonical names ${Object.values(CANONICAL_PACKAGES).join(
        ', '
      )} enforced.`
    );
  } else {
    console.log(
      `sdk-package-names: FAIL — ${total} finding(s) in ${filesWithFindings} file(s) ${JSON.stringify(
        byRule
      )}. ` + 'See docs/runbooks/sdk-package-names.md.'
    );
  }
  process.exitCode = report.summary.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
