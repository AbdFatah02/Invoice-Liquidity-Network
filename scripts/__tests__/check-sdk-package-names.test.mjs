import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOW_PRAGMA,
  checkRepository,
  findLegacyReferences,
  findTableMismatches,
  rangeAccepts,
} from '../check-sdk-package-names.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../check-sdk-package-names.mjs');
const REPO_ROOT = resolve(dirname(SCRIPT), '..');
const LEGACY = '@invoice-liquidity/sdk';

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

/** Minimal healthy workspace: both SDK manifests plus one consumer. */
function scaffold(root) {
  write(root, 'sdk/package.json', { name: '@iln/sdk', version: '0.1.0' });
  write(root, 'packages/sdk/package.json', { name: '@iln/sdk-next', version: '0.1.0' });
  write(root, 'examples/app/package.json', {
    name: 'app',
    dependencies: { '@iln/sdk': 'file:../../sdk' },
  });
  write(root, 'packages/react/package.json', {
    name: '@iln/react',
    peerDependencies: { '@iln/sdk': '^0.1.0' },
    devDependencies: { '@iln/sdk': 'workspace:*' },
  });
  write(root, 'docs/install.md', 'npm install @iln/sdk\n');
}

function run(root, ...args) {
  return spawnSync(process.execPath, [SCRIPT, `--root=${root}`, ...args], { encoding: 'utf8' });
}

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sdk-names-'));
  scaffold(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('success', () => {
  it('passes a workspace that uses only canonical names', () => {
    const report = checkRepository(root);
    assert.deepEqual(report.findings, []);
    assert.equal(report.summary.ok, true);
  });

  it('exits 0 from the CLI and writes a JSON report', () => {
    const out = join(root, 'report.json');
    const res = run(root, `--json=${out}`);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /sdk-package-names: OK/);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(report.summary.total, 0);
    assert.deepEqual(report.canonical, { sdk: '@iln/sdk', 'packages/sdk': '@iln/sdk-next' });
  });

  it('the repository itself is clean (regression guard for #1218)', () => {
    const report = checkRepository(REPO_ROOT);
    assert.deepEqual(
      report.findings.map((f) => `${f.rule} ${f.file}:${f.line ?? ''}`),
      []
    );
  });
});

describe('failure', () => {
  it('flags a renamed SDK manifest', () => {
    write(root, 'sdk/package.json', { name: LEGACY, version: '0.1.0' });
    const rules = checkRepository(root).findings.map((f) => f.rule);
    assert.ok(rules.includes('manifest-name'));
  });

  it('flags a legacy dependency key and the path it points at', () => {
    write(root, 'examples/app/package.json', {
      name: 'app',
      dependencies: { [LEGACY]: 'file:../../sdk' },
    });
    const rules = checkRepository(root)
      .findings.map((f) => f.rule)
      .sort();
    assert.deepEqual(rules, ['legacy-dependency', 'path-mismatch']);
  });

  it('flags sdk-next consumed under the stable name', () => {
    write(root, 'examples/app/package.json', {
      name: 'app',
      dependencies: { '@iln/sdk': 'file:../../packages/sdk' },
    });
    const [f] = checkRepository(root).findings;
    assert.equal(f.rule, 'path-mismatch');
    assert.match(f.message, /@iln\/sdk-next/);
  });

  it('flags the SDK declared as both dependency and peer', () => {
    write(root, 'packages/react/package.json', {
      name: '@iln/react',
      dependencies: { '@iln/sdk': 'workspace:*' },
      peerDependencies: { '@iln/sdk': '^0.1.0' },
    });
    assert.deepEqual(
      checkRepository(root).findings.map((f) => f.rule),
      ['dual-declaration']
    );
  });

  it('flags a peer range that rejects the current SDK version', () => {
    write(root, 'packages/react/package.json', {
      name: '@iln/react',
      peerDependencies: { '@iln/sdk': '^0.2.0' },
    });
    assert.deepEqual(
      checkRepository(root).findings.map((f) => f.rule),
      ['peer-range']
    );
  });

  it('flags legacy names in workflows, source and docs with exact locations', () => {
    write(root, '.github/workflows/e2e.yml', `steps:\n  - run: pnpm --filter ${LEGACY} test\n`);
    write(root, 'packages/react/rollup.config.js', `export default { external: ['${LEGACY}'] };\n`);
    write(root, 'docs/install.md', `# Install\n\nnpm install ${LEGACY}@latest\n`);
    const findings = checkRepository(root).findings;
    assert.deepEqual(
      findings.map((f) => `${f.file}:${f.line}`),
      ['.github/workflows/e2e.yml:2', 'docs/install.md:3', 'packages/react/rollup.config.js:1']
    );
    assert.ok(findings.every((f) => f.rule === 'legacy-reference'));
  });

  it('flags a package table that mislabels packages/sdk', () => {
    write(root, 'README.md', '| Dir | Name |\n|---|---|\n| `packages/sdk/` | `@iln/sdk` |\n');
    const [f] = checkRepository(root).findings;
    assert.equal(f.rule, 'table-mismatch');
    assert.equal(f.line, 3);
  });

  it('exits 1 from the CLI and still writes the report', () => {
    write(root, 'docs/install.md', `npm install ${LEGACY}\n`);
    const out = join(root, 'report.json');
    const res = run(root, `--json=${out}`);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /::error file=docs\/install\.md,line=1::\[legacy-reference\]/);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).summary.byRule['legacy-reference'], 1);
  });
});

describe('replay / restart', () => {
  it('produces an identical report on repeated runs over the same tree', () => {
    write(root, 'docs/a.md', `${LEGACY}\n${LEGACY}/validators\n`);
    write(root, 'docs/b.md', `import x from '${LEGACY}';\n`);
    const first = checkRepository(root);
    const second = checkRepository(root);
    assert.deepEqual(second, first);
    assert.equal(first.summary.total, 3);
  });

  it('overwrites a stale report instead of appending on re-run', () => {
    const out = join(root, 'report.json');
    write(root, 'docs/install.md', `npm install ${LEGACY}\n`);
    assert.equal(run(root, `--json=${out}`).status, 1);
    write(root, 'docs/install.md', 'npm install @iln/sdk\n');
    const res = run(root, `--json=${out}`);
    assert.equal(res.status, 0);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).summary.total, 0);
  });

  it('goes green after remediation, then red again on regression', () => {
    write(root, 'examples/app/package.json', {
      name: 'app',
      dependencies: { [LEGACY]: 'file:../../sdk' },
    });
    assert.equal(checkRepository(root).summary.ok, false);
    write(root, 'examples/app/package.json', {
      name: 'app',
      dependencies: { '@iln/sdk': 'file:../../sdk' },
    });
    assert.equal(checkRepository(root).summary.ok, true);
    write(root, 'examples/app/index.ts', `import { ILNSdk } from '${LEGACY}';\n`);
    assert.equal(checkRepository(root).summary.ok, false);
  });
});

describe('boundary conditions', () => {
  it('matches the legacy name with subpath, version, and quotes but not longer identifiers', () => {
    const text = [
      `'${LEGACY}'`,
      `${LEGACY}/validators`,
      `${LEGACY}@1.2.3`,
      `${LEGACY}x`,
      `${LEGACY}-utils`,
      '@invoice-liquidity/sdk-next',
      '@iln/sdk-next',
    ].join('\n');
    assert.deepEqual(
      findLegacyReferences(text).map((h) => [h.line, h.name]),
      [
        [1, LEGACY],
        [2, LEGACY],
        [3, LEGACY],
        [6, '@invoice-liquidity/sdk-next'],
      ]
    );
  });

  it('honours the allow pragma only on its own line', () => {
    const text = `${LEGACY} <!-- ${ALLOW_PRAGMA} -->\n${LEGACY}\n`;
    assert.deepEqual(
      findLegacyReferences(text).map((h) => h.line),
      [2]
    );
  });

  it('ignores historical files, node_modules and dist', () => {
    write(root, 'CHANGELOG.md', `- renamed from ${LEGACY}\n`);
    write(root, 'sdk/CHANGELOG.md', `- renamed from ${LEGACY}\n`);
    write(root, 'history/2025.md', `${LEGACY}\n`);
    write(root, 'node_modules/x/index.js', `require('${LEGACY}')\n`);
    write(root, 'sdk/dist/index.d.ts', `// ${LEGACY}\n`);
    assert.equal(checkRepository(root).summary.ok, true);
  });

  it('accepts the table row for each directory with its own name only', () => {
    const md =
      '| `sdk/` | `@iln/sdk` |\n| `packages/sdk/` | `@iln/sdk-next` |\n| `sdk/` | `@iln/sdk-next` |\n';
    assert.deepEqual(
      findTableMismatches(md).map((h) => h.line),
      [3]
    );
  });

  it('evaluates peer ranges at their edges', () => {
    assert.equal(rangeAccepts('0.1.0', '0.1.0'), true);
    assert.equal(rangeAccepts('^0.1.0', '0.1.9'), true);
    assert.equal(rangeAccepts('^0.1.0', '0.2.0'), false);
    assert.equal(rangeAccepts('^1.0.0', '1.9.0'), true);
    assert.equal(rangeAccepts('^1.0.0', '2.0.0'), false);
    assert.equal(rangeAccepts('~0.1.0', '0.1.5'), true);
    assert.equal(rangeAccepts('>=0.2.0', '0.1.0'), false);
    assert.equal(rangeAccepts('^0.0.1 || ^0.1.0', '0.1.0'), true);
    assert.equal(rangeAccepts('workspace:*', '0.1.0'), true);
    assert.equal(rangeAccepts('not-a-range', '0.1.0'), false);
  });

  it('reports a missing SDK manifest instead of crashing', () => {
    rmSync(join(root, 'packages/sdk'), { recursive: true });
    const [f] = checkRepository(root).findings;
    assert.equal(f.rule, 'manifest-name');
    assert.equal(f.file, 'packages/sdk/package.json');
  });
});
