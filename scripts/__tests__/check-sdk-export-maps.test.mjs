import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSdkExportMaps, SDK_SURFACES } from '../check-sdk-export-maps.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../check-sdk-export-maps.mjs');
const REPO_ROOT = resolve(dirname(SCRIPT), '..');

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function healthyManifest(name, prefix) {
  return {
    name,
    version: '0.1.0',
    main: `./dist/index.cjs`,
    module: `./dist/index.js`,
    types: `./dist/index.d.ts`,
    exports: {
      '.': {
        types: './dist/index.d.ts',
        browser: './dist/browser/index.js',
        import: './dist/index.js',
        require: './dist/index.cjs',
      },
      './tokens': {
        types: './dist/tokens.d.ts',
        import: './dist/tokens.js',
        require: './dist/tokens.cjs',
      },
    },
  };
}

function scaffoldHealthyWorkspace(root) {
  write(root, 'sdk/package.json', {
    ...healthyManifest('@iln/sdk', 'index'),
    main: './dist/index.cjs',
    module: './dist/index.mjs',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        'react-native': './dist/react-native/index.js',
        import: './dist/index.mjs',
        require: './dist/index.cjs',
      },
    },
  });
  write(root, 'packages/sdk/package.json', healthyManifest('@iln/sdk-next', 'index'));
  write(root, 'packages/react/package.json', {
    name: '@iln/react',
    version: '0.1.0',
    main: './dist/cjs/index.js',
    module: './dist/esm/index.js',
    types: './dist/types/index.d.ts',
    exports: {
      '.': {
        types: './dist/types/index.d.ts',
        import: './dist/esm/index.js',
        require: './dist/cjs/index.js',
      },
    },
  });
  write(root, 'examples/javascript-example/package.json', {
    name: 'iln-javascript-example',
    version: '1.0.0',
    dependencies: { '@iln/sdk': 'file:../../sdk' },
  });
}

function manifestPath(root, dir) {
  return join(root, dir, 'package.json');
}

function readManifest(root, dir) {
  return JSON.parse(readFileSync(manifestPath(root, dir), 'utf8'));
}

let testRoot;
beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'sdk-export-maps-'));
  scaffoldHealthyWorkspace(testRoot);
});
afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('#1210 checkSdkExportMaps — success', () => {
  it('passes a workspace whose surfaces share one export contract', () => {
    const report = checkSdkExportMaps(testRoot);
    assert.deepEqual(report.findings, []);
    assert.equal(report.summary.ok, true);
    assert.deepEqual(
      report.summary.surfaces,
      SDK_SURFACES.map((s) => s.pkg)
    );
  });

  it('allows extra conditions (browser/react-native) alongside the required trio', () => {
    const pkg = readManifest(testRoot, 'packages/sdk');
    assert.deepEqual(Object.keys(pkg.exports['.']).slice(0, 4), [
      'types',
      'browser',
      'import',
      'require',
    ]);
  });
});

describe('#1210 checkSdkExportMaps — failure', () => {
  it('flags a types condition that is not first (the audited regression)', () => {
    write(testRoot, 'packages/react/package.json', {
      name: '@iln/react',
      version: '0.1.0',
      exports: {
        '.': {
          import: './dist/esm/index.js',
          require: './dist/cjs/index.js',
          types: './dist/types/index.d.ts',
        },
      },
    });
    const report = checkSdkExportMaps(testRoot);
    const finding = report.findings.find((f) => f.rule === 'types-first');
    assert.ok(finding, 'expected a types-first finding');
    assert.equal(finding.file, 'packages/react/package.json');
  });

  it('flags a missing exports map', () => {
    write(testRoot, 'sdk/package.json', { name: '@iln/sdk', version: '0.1.0' });
    const report = checkSdkExportMaps(testRoot);
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].rule, 'exports-present');
  });

  it('flags a missing required condition on exports["."]', () => {
    const pkg = readManifest(testRoot, 'packages/sdk');
    delete pkg.exports['.'].require;
    write(testRoot, 'packages/sdk/package.json', pkg);
    const report = checkSdkExportMaps(testRoot);
    const finding = report.findings.find((f) => f.rule === 'condition-contract');
    assert.ok(finding);
    assert.match(finding.message, /"require"/);
  });

  it('flags top-level main/types drift from exports["."]', () => {
    const pkg = readManifest(testRoot, 'packages/react');
    pkg.main = './dist/legacy/index.js';
    write(testRoot, 'packages/react/package.json', pkg);
    const report = checkSdkExportMaps(testRoot);
    const finding = report.findings.find((f) => f.rule === 'legacy-field-drift');
    assert.ok(finding);
    assert.match(finding.message, /"main"/);
  });

  it('flags a non-relative export target', () => {
    const pkg = readManifest(testRoot, 'packages/sdk');
    pkg.exports['.'].import = 'dist/index.js';
    write(testRoot, 'packages/sdk/package.json', pkg);
    const report = checkSdkExportMaps(testRoot);
    assert.ok(report.findings.some((f) => f.rule === 'target-relative'));
  });

  it('flags an example that pins @iln/sdk to a published version range', () => {
    write(testRoot, 'examples/lp-automation/package.json', {
      name: 'lp-automation',
      version: '1.0.0',
      dependencies: { '@iln/sdk': '^0.1.0' },
    });
    const report = checkSdkExportMaps(testRoot);
    const finding = report.findings.find((f) => f.rule === 'example-specifier');
    assert.ok(finding);
    assert.equal(finding.file, 'examples/lp-automation/package.json');
  });
});

describe('#1210 checkSdkExportMaps — boundary', () => {
  it('accepts a string export entry without a types condition', () => {
    const pkg = readManifest(testRoot, 'packages/sdk');
    pkg.exports['./package.json'] = './package.json';
    write(testRoot, 'packages/sdk/package.json', pkg);
    const report = checkSdkExportMaps(testRoot);
    assert.deepEqual(report.findings, []);
  });

  it('accepts an exports["."] entry with types first and no optional conditions', () => {
    write(testRoot, 'packages/react/package.json', {
      name: '@iln/react',
      version: '0.1.0',
      exports: {
        '.': {
          types: './dist/types/index.d.ts',
          import: './dist/esm/index.js',
          require: './dist/cjs/index.js',
        },
      },
    });
    const report = checkSdkExportMaps(testRoot);
    assert.deepEqual(report.findings, []);
  });

  it('flags a bare-path exports["."] so the condition contract cannot be skipped', () => {
    write(testRoot, 'packages/react/package.json', {
      name: '@iln/react',
      version: '0.1.0',
      exports: { '.': './dist/index.js' },
    });
    const report = checkSdkExportMaps(testRoot);
    assert.deepEqual(
      report.findings.map((f) => f.rule),
      ['exports-present']
    );
  });

  it('rejects a file: example specifier pointing at a non-SDK package', () => {
    write(testRoot, 'packages/sdk/package.json', { name: '@iln/sdk-next', version: '0.1.0' });
    write(testRoot, 'examples/javascript-example/package.json', {
      name: 'iln-javascript-example',
      version: '1.0.0',
      dependencies: { '@iln/sdk': 'file:../../packages/sdk' },
    });
    const report = checkSdkExportMaps(testRoot);
    assert.ok(
      report.findings.some(
        (f) => f.rule === 'example-specifier' && /expected "@iln\/sdk"/.test(f.message)
      )
    );
  });
});

describe('#1210 real repository guard', () => {
  it('passes against the checked-in SDK surfaces (fails if the order regresses)', () => {
    const report = checkSdkExportMaps(REPO_ROOT);
    assert.deepEqual(report.findings, [], 'SDK export maps drifted apart');
  });

  it('runs as a CLI and exits 0 on the real repository', () => {
    const result = spawnSync(process.execPath, [SCRIPT, `--root=${REPO_ROOT}`], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /share one export contract/);
  });
});
