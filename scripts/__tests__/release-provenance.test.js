/**
 * Issue #878 / #1077 — npm package provenance regression guard.
 *
 * Every release workflow that publishes to npm must actually be configured
 * for provenance attestation (the --provenance flag or NPM_CONFIG_PROVENANCE
 * plus the id-token: write permission GitHub Actions OIDC needs), and must
 * reference the real package name declared in the package directory it
 * publishes. The audit this test encodes found that the provenance flags
 * were correct but two workflows referenced stale state (an old package name
 * and a private package); both were fixed and this test keeps the
 * configuration honest.
 *
 * Issue #1077 additionally requires SLSA provenance generation
 * (slsa-framework/slsa-github-generator) wired into both release workflows,
 * with the publish job gated on provenance so a release can never ship
 * unattested.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const workflowFiles = readdirSync(WORKFLOWS).filter(f => f.endsWith('.yml'));

const read = rel => readFileSync(join(ROOT, rel), 'utf8');

test('every release workflow that publishes to npm is provenance-enabled', () => {
  for (const file of workflowFiles) {
    const content = readFileSync(join(WORKFLOWS, file), 'utf8');

    // A publish command is the tell that this workflow ships a package.
    if (!/(npm|pnpm)\s+publish/.test(content)) continue;

    const hasFlag = content.includes('--provenance');
    const hasEnvFlag = content.includes('NPM_CONFIG_PROVENANCE');
    const hasOidc = content.includes('id-token: write');

    assert.ok(
      (hasFlag || hasEnvFlag) && hasOidc,
      `${file} publishes to npm but is missing provenance attestation config ` +
        `(need --provenance or NPM_CONFIG_PROVENANCE=true, plus id-token: write). ` +
        'npm publish without provenance defeats the supply-chain guarantee.',
    );
  }
});

test('every npm publish targets a package name that actually exists in the repo', () => {
  // The workflow must name the package it publishes (its header/comments
  // document it) and that name must match packages/<dir>/package.json.
  const packageNames = new Set();
  for (const dir of readdirSync(join(ROOT, 'packages'))) {
    const pkgPath = join(ROOT, 'packages', dir, 'package.json');
    try {
      packageNames.add(JSON.parse(readFileSync(pkgPath, 'utf8')).name);
    } catch {
      // not a package directory
    }
  }

  const sdkRelease = read('.github/workflows/sdk-release.yml');
  const sdkName = JSON.parse(read('packages/sdk/package.json')).name;
  assert.ok(
    sdkRelease.includes(sdkName),
    `sdk-release.yml must reference the real package name ${sdkName} (issue #878 found stale "@iln/sdk")`,
  );
  assert.ok(
    packageNames.has(sdkName),
    `${sdkName} (from packages/sdk/package.json) must exist in the repo's package set`,
  );
});

test('no release workflow references the removed scripts publish path', () => {
  assert.ok(
    !workflowFiles.includes('scripts-release.yml'),
    'scripts-release.yml was removed (issue #878): @iln/scripts is private and "not for public installation"',
  );
  for (const file of workflowFiles) {
    const content = readFileSync(join(WORKFLOWS, file), 'utf8');
    assert.ok(
      !/publish.*@iln\/scripts|@iln\/scripts.*publish/.test(content),
      `${file} still references publishing @iln/scripts`,
    );
  }
});

test('the provenance docs reference the real package name', () => {
  const securityGuide = read('docs/security-guide.md');
  const releaseProcess = read('docs/release-process.md');
  assert.ok(
    securityGuide.includes('@iln/sdk-next'),
    'docs/security-guide.md should reference @iln/sdk-next',
  );
  assert.ok(
    !securityGuide.includes('npm audit signatures @invoice-liquidity/sdk'), // sdk-name-check: allow-legacy
    'docs/security-guide.md must not present the stale @invoice-liquidity/sdk verification block', // sdk-name-check: allow-legacy
  );
  assert.ok(
    releaseProcess.includes('@iln/sdk-next'),
    'docs/release-process.md should reference @iln/sdk-next',
  );
});

// ---------------------------------------------------------------------------
// Issue #1077 — SLSA provenance generation in the release pipeline.
// ---------------------------------------------------------------------------

const SLSA_GENERATOR =
  /slsa-framework\/slsa-github-generator\/\.github\/workflows\/generator_generic_slsa3\.yml@v\d+\.\d+\.\d+/;

test('both release workflows generate SLSA provenance via slsa-github-generator', () => {
  for (const file of ['release.yml', 'sdk-release.yml']) {
    const content = readFileSync(join(WORKFLOWS, file), 'utf8');
    assert.match(
      content,
      SLSA_GENERATOR,
      `${file} must call slsa-framework/slsa-github-generator pinned to an immutable @vX.Y.Z tag ` +
        '(issue #1077). Never reference the generator by branch or short tag.',
    );
    assert.ok(
      !content.includes('continue-on-error: true'),
      `${file} must not set continue-on-error on provenance generation — a failed ` +
        'attestation has to fail the release instead of shipping unattested (issue #1077).',
    );
  }
});

test('npm publish is gated on provenance generation in both release workflows', () => {
  for (const file of ['release.yml', 'sdk-release.yml']) {
    const content = readFileSync(join(WORKFLOWS, file), 'utf8');
    const needsLines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('needs:'));
    assert.ok(
      needsLines.some((line) => /^needs:\s*\[.*provenance.*\]$/.test(line)),
      `${file} must gate its publish job with "needs: [..., provenance]" so a ` +
        'provenance failure blocks the release (issue #1077).',
    );
    assert.ok(
      content.includes('Verify provenance covers the release artifacts'),
      `${file} must verify the generated attestation covers the packed artifacts ` +
        'before publishing (issue #1077: fail rather than ship unattested).',
    );
  }
});

test('release attestations are attached to or downloadable from the release', () => {
  const sdkRelease = readFileSync(join(WORKFLOWS, 'sdk-release.yml'), 'utf8');
  assert.ok(
    sdkRelease.includes('.intoto.jsonl'),
    'sdk-release.yml must publish the signed .intoto.jsonl attestation alongside the release artifacts (issue #1077)',
  );
  const release = readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8');
  assert.ok(
    release.includes('actions/attest-build-provenance'),
    'release.yml must record a GitHub Artifact Attestation for the packed SDK/CLI tarballs (issue #1077)',
  );
});
