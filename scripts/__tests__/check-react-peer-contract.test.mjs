import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPAT_MATRIX_DOC,
  PEER_CONTRACT,
  REACT_MANIFEST,
  REACT_ROLLUP_CONFIG,
  SDK_MANIFEST,
  VERSIONING_DOC,
  caretAdmits,
  checkReactPeerContract,
  nodeEngineAdmits,
  parseRollupExternals,
} from '../check-react-peer-contract.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function scaffoldHealthyWorkspace(root) {
  write(root, REACT_MANIFEST, {
    name: '@iln/react',
    version: '0.1.0',
    engines: { node: '>=20' },
    peerDependencies: { ...PEER_CONTRACT },
    devDependencies: {
      '@iln/sdk': 'workspace:*',
      '@tanstack/react-query': '^5.62.0',
      react: '^19.0.0',
    },
  });
  write(root, REACT_ROLLUP_CONFIG, "external: ['react', '@tanstack/react-query', '@iln/sdk'],\n");
  write(root, SDK_MANIFEST, { name: '@iln/sdk', version: '0.1.0' });
  write(
    root,
    VERSIONING_DOC,
    '# SDK Versioning\n\nThe React hooks keep `react@^19.0.0` and `@iln/sdk@^0.1.0` as peers.\n'
  );
  write(
    root,
    COMPAT_MATRIX_DOC,
    '# Matrix\n\n| @iln/sdk | React |\n|---|---|\n| ^0.1.0 | ^19.0.0 |\n'
  );
}

function reactManifest(root) {
  return JSON.parse(readFileSync(join(root, REACT_MANIFEST), 'utf8'));
}

let testRoot;
beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'react-peer-contract-'));
  scaffoldHealthyWorkspace(testRoot);
});
afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function run() {
  return checkReactPeerContract(testRoot);
}

describe('#1213 checkReactPeerContract — success', () => {
  it('passes a workspace with the declared peer contract', () => {
    const report = run();
    assert.deepEqual(report.findings, []);
    assert.equal(report.summary.ok, true);
    assert.deepEqual(report.summary.peers, ['react', '@tanstack/react-query', '@iln/sdk']);
  });
});

describe('#1213 checkReactPeerContract — failure', () => {
  it('flags a missing peer', () => {
    const manifest = reactManifest(testRoot);
    delete manifest.peerDependencies.react;
    write(testRoot, REACT_MANIFEST, manifest);
    assert.ok(run().findings.some((f) => f.rule === 'peer-missing' && /"react"/.test(f.message)));
  });

  it('flags a peer range that drifts from the contract', () => {
    const manifest = reactManifest(testRoot);
    manifest.peerDependencies.react = '^18.0.0';
    write(testRoot, REACT_MANIFEST, manifest);
    const finding = run().findings.find((f) => f.rule === 'peer-range');
    assert.ok(finding);
    assert.match(finding.message, /\^19\.0\.0/);
  });

  it('flags a peer with no devDependency mirror', () => {
    const manifest = reactManifest(testRoot);
    delete manifest.devDependencies['@iln/sdk'];
    write(testRoot, REACT_MANIFEST, manifest);
    assert.ok(run().findings.some((f) => f.rule === 'dev-mirror' && /@iln\/sdk/.test(f.message)));
  });

  it('flags an @iln/sdk peer range that no longer admits the SDK version', () => {
    write(testRoot, SDK_MANIFEST, { name: '@iln/sdk', version: '0.2.0' });
    const finding = run().findings.find((f) => f.rule === 'sdk-version-drift');
    assert.ok(finding);
    assert.match(finding.message, /0\.2\.0/);
  });

  it('flags a peer that is not externalized in the rollup config', () => {
    write(testRoot, REACT_ROLLUP_CONFIG, "external: ['react', '@tanstack/react-query'],\n");
    assert.ok(run().findings.some((f) => f.rule === 'peer-bundled' && /@iln\/sdk/.test(f.message)));
  });

  it('flags a node engine range below 20', () => {
    const manifest = reactManifest(testRoot);
    manifest.engines.node = '>=18';
    write(testRoot, REACT_MANIFEST, manifest);
    assert.ok(run().findings.some((f) => f.rule === 'node-engine'));
  });

  it('flags the versioning doc when it stops stating the contract', () => {
    write(testRoot, VERSIONING_DOC, '# SDK Versioning\n\nNo peer details here.\n');
    const findings = run().findings.filter(
      (f) => f.rule === 'documented' && f.file === VERSIONING_DOC
    );
    assert.ok(findings.some((f) => /@iln\/sdk@\^0\.1\.0/.test(f.message)));
    assert.ok(findings.some((f) => /react@\^19\.0\.0/.test(f.message)));
  });

  it('flags the compatibility matrix when it claims an exact peer', () => {
    write(
      testRoot,
      COMPAT_MATRIX_DOC,
      '# Matrix\n\n| @iln/sdk | React |\n|---|---|\n| 0.1.0 (exact) | ^19.0.0 |\n'
    );
    const findings = run().findings.filter(
      (f) => f.rule === 'documented' && f.file === COMPAT_MATRIX_DOC
    );
    assert.ok(findings.some((f) => /exact/.test(f.message)));
  });

  it('flags a manifest with no peerDependencies object', () => {
    write(testRoot, REACT_MANIFEST, { name: '@iln/react', version: '0.1.0' });
    assert.ok(run().findings.some((f) => f.rule === 'contract-shape'));
  });

  it('flags an unparseable manifest without throwing', () => {
    write(testRoot, REACT_MANIFEST, '{ not json');
    assert.ok(
      run().findings.some((f) => f.rule === 'contract-shape' && /Invalid JSON/.test(f.message))
    );
  });

  it('flags a missing manifest', () => {
    rmSync(join(testRoot, REACT_MANIFEST));
    assert.ok(run().findings.some((f) => f.rule === 'contract-shape' && /missing/.test(f.message)));
  });
});

describe('#1213 checkReactPeerContract — boundary', () => {
  it('treats the minimum caret version as admitted', () => {
    assert.equal(caretAdmits('^0.1.0', '0.1.0'), true);
    assert.equal(caretAdmits('^0.1.0', '0.1.5'), true);
    assert.equal(caretAdmits('^0.1.0', '0.2.0'), false);
    assert.equal(caretAdmits('^19.0.0', '19.0.0'), true);
    assert.equal(caretAdmits('^19.0.0', '19.3.1'), true);
    assert.equal(caretAdmits('^19.0.0', '18.9.9'), false);
    assert.equal(caretAdmits('19.0.0', '19.0.0'), false);
  });

  it('accepts equivalent node engine spellings and rejects lower majors', () => {
    assert.equal(nodeEngineAdmits('>=20', 20), true);
    assert.equal(nodeEngineAdmits('>= 20', 20), true);
    assert.equal(nodeEngineAdmits('>=20.0.0', 20), true);
    assert.equal(nodeEngineAdmits('>=18', 20), false);
    assert.equal(nodeEngineAdmits('*', 20), false);
  });

  it('parses quoted rollup externals with mixed quote styles', () => {
    const externals = parseRollupExternals(
      "external: [\"react\", '@tanstack/react-query' , '@iln/sdk'],\n"
    );
    assert.deepEqual([...externals].sort(), ['@iln/sdk', '@tanstack/react-query', 'react']);
  });

  it('does not flag peers that remain dev-mirrored after an sdk patch bump', () => {
    write(testRoot, SDK_MANIFEST, { name: '@iln/sdk', version: '0.1.99' });
    assert.deepEqual(run().findings, []);
  });
});

describe('#1213 repository wiring regression guard', () => {
  it('passes against the real repository contract', () => {
    const report = checkReactPeerContract(REPO_ROOT);
    assert.deepEqual(report.findings, []);
  });
});
