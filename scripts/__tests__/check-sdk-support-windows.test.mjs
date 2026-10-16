import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkSdkSupportWindows,
  SUPPORT_MANIFEST,
  VERSIONING_DOC,
} from '../check-sdk-support-windows.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../check-sdk-support-windows.mjs');
const REPO_ROOT = resolve(dirname(SCRIPT), '..');
const TODAY = '2026-01-01';

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function surfaceEntry(pkg, dir, overrides = {}) {
  return {
    package: pkg,
    directory: dir,
    version: '0.1.0',
    channel: 'stable',
    status: 'active',
    introduced: '2025-06-01',
    eol: null,
    owner: 'maintainers',
    runbook: 'docs/runbooks/sdk-support-windows.md',
    ...overrides,
  };
}

function scaffoldHealthyWorkspace(root) {
  write(root, 'sdk/package.json', { name: '@iln/sdk', version: '0.1.0' });
  write(root, 'packages/sdk/package.json', { name: '@iln/sdk-next', version: '0.1.0' });
  write(root, 'packages/react/package.json', { name: '@iln/react', version: '0.1.0' });
  write(root, SUPPORT_MANIFEST, {
    schemaVersion: 1,
    policy: { currentStable: '@iln/sdk' },
    surfaces: [
      surfaceEntry('@iln/sdk', 'sdk'),
      surfaceEntry('@iln/sdk-next', 'packages/sdk', { channel: 'experimental', eol: '2026-12-31' }),
      surfaceEntry('@iln/react', 'packages/react'),
    ],
  });
  write(
    root,
    VERSIONING_DOC,
    '# SDK Versioning\n\n@iln/sdk 0.1.0, @iln/sdk-next 0.1.0, @iln/react 0.1.0\n'
  );
}

let testRoot;
beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'sdk-support-windows-'));
  scaffoldHealthyWorkspace(testRoot);
});
afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function run(options = {}) {
  return checkSdkSupportWindows(testRoot, { today: TODAY, ...options });
}

describe('#1211 checkSdkSupportWindows — success', () => {
  it('passes a workspace where every surface declares a valid window', () => {
    const report = run();
    assert.deepEqual(report.findings, []);
    assert.equal(report.summary.ok, true);
    assert.deepEqual(report.summary.surfaces, ['@iln/sdk', '@iln/sdk-next', '@iln/react']);
    assert.equal(report.summary.today, TODAY);
  });
});

describe('#1211 checkSdkSupportWindows — failure', () => {
  it('flags a version that drifted ahead of its declared support window', () => {
    write(testRoot, 'sdk/package.json', { name: '@iln/sdk', version: '0.2.0' });
    const report = run();
    assert.deepEqual(
      report.findings.map((f) => f.rule),
      ['version-drift']
    );
    assert.match(report.findings[0].message, /0\.2\.0/);
  });

  it('flags a surface with no declared support window', () => {
    const manifest = JSON.parse(readFileSync(join(testRoot, SUPPORT_MANIFEST), 'utf8'));
    manifest.surfaces = manifest.surfaces.filter((s) => s.package !== '@iln/react');
    write(testRoot, SUPPORT_MANIFEST, manifest);
    const report = run();
    const finding = report.findings.find((f) => f.rule === 'surface-coverage');
    assert.ok(finding);
    assert.match(finding.message, /@iln\/react/);
  });

  it('flags an entry with a missing required field', () => {
    const manifest = JSON.parse(readFileSync(join(testRoot, SUPPORT_MANIFEST), 'utf8'));
    delete manifest.surfaces[0].status;
    write(testRoot, SUPPORT_MANIFEST, manifest);
    const report = run();
    assert.ok(report.findings.some((f) => f.rule === 'manifest-shape'));
  });

  it('flags an eol before the introduced date', () => {
    const manifest = JSON.parse(readFileSync(join(testRoot, SUPPORT_MANIFEST), 'utf8'));
    manifest.surfaces[0].eol = '2025-01-01';
    write(testRoot, SUPPORT_MANIFEST, manifest);
    const report = run();
    assert.ok(report.findings.some((f) => f.rule === 'window-validity'));
  });

  it('flags an active surface whose support window already closed', () => {
    const manifest = JSON.parse(readFileSync(join(testRoot, SUPPORT_MANIFEST), 'utf8'));
    manifest.surfaces[0].eol = '2025-12-31';
    write(testRoot, SUPPORT_MANIFEST, manifest);
    const report = run();
    const finding = report.findings.find((f) => f.rule === 'support-status');
    assert.ok(finding);
    assert.match(finding.message, /closed on 2025-12-31/);
  });

  it('flags a surface marked eol while its window is still open', () => {
    const manifest = JSON.parse(readFileSync(join(testRoot, SUPPORT_MANIFEST), 'utf8'));
    manifest.surfaces[0].status = 'eol';
    manifest.surfaces[0].eol = '2026-06-01';
    write(testRoot, SUPPORT_MANIFEST, manifest);
    const report = run();
    assert.ok(
      report.findings.some(
        (f) => f.rule === 'support-status' && /runs until 2026-06-01/.test(f.message)
      )
    );
  });

  it('flags documentation that stops describing a surface version', () => {
    write(testRoot, VERSIONING_DOC, '# SDK Versioning\n\n@iln/sdk, @iln/sdk-next, @iln/react\n');
    const report = run();
    assert.ok(report.findings.some((f) => f.rule === 'documented'));
  });

  it('flags an unknown surface in the manifest', () => {
    const manifest = JSON.parse(readFileSync(join(testRoot, SUPPORT_MANIFEST), 'utf8'));
    manifest.surfaces.push(surfaceEntry('@iln/ghost', 'packages/ghost'));
    write(testRoot, SUPPORT_MANIFEST, manifest);
    const report = run();
    assert.ok(
      report.findings.some((f) => f.rule === 'surface-coverage' && /@iln\/ghost/.test(f.message))
    );
  });
});

describe('#1211 checkSdkSupportWindows — boundary', () => {
  it('treats the eol date itself as still supported', () => {
    const manifest = JSON.parse(readFileSync(join(testRoot, SUPPORT_MANIFEST), 'utf8'));
    manifest.surfaces[0].eol = TODAY;
    write(testRoot, SUPPORT_MANIFEST, manifest);
    const report = run();
    assert.deepEqual(report.findings, []);
  });

  it('fails the moment the eol date is in the past (one day later)', () => {
    const manifest = JSON.parse(readFileSync(join(testRoot, SUPPORT_MANIFEST), 'utf8'));
    manifest.surfaces[0].eol = '2025-12-31';
    write(testRoot, SUPPORT_MANIFEST, manifest);
    const report = run({ today: '2026-01-01' });
    assert.ok(report.findings.some((f) => f.rule === 'support-status'));
  });

  it('accepts a deprecated surface whose window is still open', () => {
    const manifest = JSON.parse(readFileSync(join(testRoot, SUPPORT_MANIFEST), 'utf8'));
    manifest.surfaces[0].status = 'deprecated';
    manifest.surfaces[0].eol = '2026-06-01';
    write(testRoot, SUPPORT_MANIFEST, manifest);
    const report = run();
    assert.deepEqual(report.findings, []);
  });

  it('rejects a malformed eol value', () => {
    const manifest = JSON.parse(readFileSync(join(testRoot, SUPPORT_MANIFEST), 'utf8'));
    manifest.surfaces[0].eol = 'someday';
    write(testRoot, SUPPORT_MANIFEST, manifest);
    const report = run();
    assert.ok(report.findings.some((f) => f.rule === 'window-validity'));
  });
});

describe('#1211 real repository guard', () => {
  it('passes against the checked-in manifest and versioning docs', () => {
    const report = checkSdkSupportWindows(REPO_ROOT);
    assert.deepEqual(report.findings, [], 'SDK support windows drifted');
  });

  it('runs as a CLI and exits 0 on the real repository', () => {
    const result = spawnSync(process.execPath, [SCRIPT, `--root=${REPO_ROOT}`], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /declare a valid support window/);
  });
});
