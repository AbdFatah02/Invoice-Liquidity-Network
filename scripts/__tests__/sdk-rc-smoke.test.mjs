import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SMOKE_TARGETS,
  analyzePackagedPackage,
  listExportsTargets,
  smokeTarget,
} from '../sdk-rc-smoke.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function manifestWith(exportsMap, extra = {}) {
  return { name: '@fixture/pkg', version: '1.0.0', exports: exportsMap, ...extra };
}

function scaffoldResolvablePackage(root, dir, pkg) {
  write(root, join(dir, 'package.json'), {
    name: pkg,
    version: '1.0.0',
    files: ['dist'],
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.mjs',
        require: './dist/index.cjs',
      },
    },
  });
  write(root, join(dir, 'dist/index.d.ts'), 'export declare const x: number;\n');
  write(root, join(dir, 'dist/index.mjs'), 'export const x = 1;\n');
  write(root, join(dir, 'dist/index.cjs'), "'use strict';\nmodule.exports = { x: 1 };\n");
}

function scaffoldOmittedTargetPackage(root, dir, pkg) {
  write(root, join(dir, 'package.json'), {
    name: pkg,
    version: '1.0.0',
    files: ['dist/index.*'],
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.mjs',
        require: './dist/index.cjs',
      },
      './legacy': {
        types: './dist/legacy-imports.d.ts',
        import: './dist/legacy-imports.mjs',
        require: './dist/legacy-imports.cjs',
      },
    },
  });
  write(root, join(dir, 'dist/index.d.ts'), 'export declare const x: number;\n');
  write(root, join(dir, 'dist/index.mjs'), 'export const x = 1;\n');
  write(root, join(dir, 'dist/index.cjs'), "'use strict';\nmodule.exports = { x: 1 };\n");
  write(root, join(dir, 'dist/legacy-imports.d.ts'), 'export declare const x: number;\n');
  write(root, join(dir, 'dist/legacy-imports.mjs'), 'export const x = 1;\n');
  write(root, join(dir, 'dist/legacy-imports.cjs'), "'use strict';\nmodule.exports = { x: 1 };\n");
}

let testRoot;
let workDir;
beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'sdk-rc-smoke-'));
  workDir = join(testRoot, '.work');
});
afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('#1212 listExportsTargets', () => {
  it('flattens conditional and string exports into subpath/condition/target triples', () => {
    const targets = listExportsTargets(
      manifestWith({
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.mjs',
          require: './dist/index.cjs',
        },
        './plain': './dist/plain.mjs',
      })
    );
    assert.deepEqual(
      targets.map((t) => `${t.subpath}:${t.condition}`),
      ['.:types', '.:import', '.:require', './plain:default']
    );
    assert.equal(targets.find((t) => t.subpath === './plain').target, './dist/plain.mjs');
  });

  it('returns nothing when there is no exports map', () => {
    assert.deepEqual(listExportsTargets({ name: 'x' }), []);
  });
});

describe('#1212 analyzePackagedPackage — success', () => {
  it('passes when every export target is present in the tarball', () => {
    const findings = analyzePackagedPackage({
      expectedName: '@fixture/pkg',
      manifest: manifestWith({
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.mjs',
          require: './dist/index.cjs',
        },
      }),
      files: ['package.json', 'dist/index.d.ts', 'dist/index.mjs', 'dist/index.cjs'],
    });
    assert.deepEqual(findings, []);
  });
});

describe('#1212 analyzePackagedPackage — failure', () => {
  it('flags a types target omitted from the pack', () => {
    const findings = analyzePackagedPackage({
      expectedName: '@fixture/pkg',
      manifest: manifestWith({ '.': { types: './dist/index.d.ts', import: './dist/index.mjs' } }),
      files: ['package.json', 'dist/index.mjs'],
    });
    assert.deepEqual(
      findings.map((f) => f.rule),
      ['type-targets']
    );
    assert.match(findings[0].message, /dist\/index\.d\.ts/);
  });

  it('flags import/require targets omitted from the pack', () => {
    const findings = analyzePackagedPackage({
      expectedName: '@fixture/pkg',
      manifest: manifestWith({
        './legacy': { import: './dist/legacy-imports.mjs', require: './dist/legacy-imports.cjs' },
      }),
      files: ['package.json', 'dist/index.mjs'],
      tarball: 'pkg.tgz',
    });
    assert.deepEqual(
      findings.map((f) => f.rule),
      ['pack-integrity', 'pack-integrity']
    );
    assert.ok(findings.every((f) => f.file === 'pkg.tgz'));
  });

  it('flags a packed package whose name does not match the expected surface', () => {
    const findings = analyzePackagedPackage({
      expectedName: '@fixture/pkg',
      manifest: manifestWith({ '.': './dist/index.mjs' }, { name: '@fixture/renamed' }),
      files: ['package.json', 'dist/index.mjs'],
    });
    assert.ok(
      findings.some((f) => f.rule === 'pack-fields' && /@fixture\/renamed/.test(f.message))
    );
  });

  it('flags a packed package with no exports map', () => {
    const findings = analyzePackagedPackage({
      expectedName: '@fixture/pkg',
      manifest: { name: '@fixture/pkg', version: '1.0.0' },
      files: ['package.json'],
    });
    assert.ok(findings.some((f) => f.rule === 'pack-fields' && /exports/.test(f.message)));
  });

  it('flags a pack with no package.json at all', () => {
    const findings = analyzePackagedPackage({
      expectedName: '@fixture/pkg',
      manifest: manifestWith({ '.': './dist/index.mjs' }),
      files: ['dist/index.mjs'],
    });
    assert.deepEqual(
      findings.map((f) => f.rule),
      ['pack-fields']
    );
    assert.match(findings[0].message, /missing package\.json/);
  });
});

describe('#1212 analyzePackagedPackage — boundary', () => {
  it('accepts a string export entry and normalizes a leading ./', () => {
    const findings = analyzePackagedPackage({
      expectedName: '@fixture/pkg',
      manifest: manifestWith({ './plain': './dist/plain.mjs' }),
      files: ['package.json', './dist/plain.mjs'],
    });
    assert.deepEqual(findings, []);
  });

  it('ignores non-runtime conditions such as browser and node', () => {
    const findings = analyzePackagedPackage({
      expectedName: '@fixture/pkg',
      manifest: manifestWith({ '.': { browser: './dist/browser.mjs' } }),
      files: ['package.json'],
    });
    assert.deepEqual(findings, []);
  });
});

describe('#1212 smokeTarget — packed artifact resolves', () => {
  it('packs and resolves a healthy fixture package end to end', () => {
    scaffoldResolvablePackage(testRoot, 'pkg', '@fixture/ok');
    const result = smokeTarget({ dir: 'pkg', pkg: '@fixture/ok' }, testRoot, {
      workDir,
      build: false,
    });
    assert.deepEqual(result.findings, []);
    assert.equal(result.package, '@fixture/ok');
    assert.ok(result.fileCount >= 4);
  });

  it('catches an export target that exists on disk but is omitted from the pack', () => {
    scaffoldOmittedTargetPackage(testRoot, 'pkg', '@fixture/legacy');
    const result = smokeTarget({ dir: 'pkg', pkg: '@fixture/legacy' }, testRoot, {
      workDir,
      build: false,
    });
    const rules = new Set(result.findings.map((f) => f.rule));
    assert.ok(rules.has('type-targets'));
    assert.ok(rules.has('pack-integrity'));
    assert.ok(rules.has('require-resolve'));
    assert.ok(result.findings.every((f) => !/dist\/index\./.test(f.message)));
  });

  it('reports a missing package.json without attempting to pack', () => {
    const result = smokeTarget({ dir: 'ghost', pkg: '@fixture/ghost' }, testRoot, {
      workDir,
      build: false,
    });
    assert.deepEqual(
      result.findings.map((f) => f.rule),
      ['pack-fields']
    );
    assert.match(result.findings[0].message, /missing/);
  });
});

describe('#1212 smokeTarget — build plumbing', () => {
  it('reports unbuilt output when dist/ is absent and building is disabled', () => {
    write(testRoot, 'pkg/package.json', {
      name: '@fixture/unbuilt',
      version: '1.0.0',
      exports: { '.': { import: './dist/index.mjs', require: './dist/index.cjs' } },
    });
    const result = smokeTarget({ dir: 'pkg', pkg: '@fixture/unbuilt' }, testRoot, {
      workDir,
      build: false,
    });
    assert.ok(result.findings.length > 0);
    assert.ok(
      result.findings.every(
        (f) =>
          f.rule === 'pack-integrity' || f.rule === 'require-resolve' || f.rule === 'import-resolve'
      )
    );
  });
});

describe('#1212 smokeTarget — replay is deterministic', () => {
  it('produces identical findings across repeated runs of the same input', () => {
    scaffoldOmittedTargetPackage(testRoot, 'pkg', '@fixture/replay');
    const target = { dir: 'pkg', pkg: '@fixture/replay' };
    const first = smokeTarget(target, testRoot, { workDir: join(testRoot, 'w1'), build: false });
    const second = smokeTarget(target, testRoot, { workDir: join(testRoot, 'w2'), build: false });
    assert.deepEqual(
      first.findings.map((f) => ({ rule: f.rule, file: f.file })),
      second.findings.map((f) => ({ rule: f.rule, file: f.file }))
    );
    assert.ok(first.findings.length > 0);
  });
});

describe('#1212 repository wiring regression guard', () => {
  it('targets exactly the two publishable SDK surfaces', () => {
    assert.deepEqual(
      SMOKE_TARGETS.map((t) => t.dir),
      ['sdk', 'packages/sdk']
    );
  });

  it('builds the ./legacy shim so its export targets are shipped', () => {
    const tsup = readFileSync(join(REPO_ROOT, 'sdk/tsup.config.ts'), 'utf8');
    assert.match(tsup, /src\/legacy-imports\.ts/);

    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'sdk/package.json'), 'utf8'));
    const legacy = manifest.exports['./legacy'];
    for (const target of Object.values(legacy)) {
      assert.match(target, /^\.\/dist\/legacy-imports\./);
    }
  });
});
