#!/usr/bin/env node
/**
 * check-react-peer-contract.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Enforces the peer-dependency contract for `@iln/react` (issue #1213).
 *
 * `@iln/react` is consumed inside a host React application, so React, the React
 * Query runtime and the ILN SDK must all be supplied by the host and never
 * bundled into the published artifact. When that contract drifts, consumers end
 * up with two copies of React (broken hooks) or a private SDK copy that ignores
 * their configuration. The ranges are also the policy of record documented in
 * docs/sdk-versioning.md, so CI has to keep the manifest and the docs in step.
 *
 * Invariants enforced (all error-level, exit 1 on any finding):
 *   1. contract-shape       packages/react/package.json parses, declares
 *                           `peerDependencies` and an `engines.node` range.
 *   2. peer-missing         every contracted peer is declared.
 *   3. peer-range           each peer range equals the contracted range.
 *   4. sdk-version-drift    the `@iln/sdk` peer range admits the version in
 *                           sdk/package.json.
 *   5. peer-bundled         every contracted peer is listed in the rollup
 *                           `external` array (so it is never bundled).
 *   6. dev-mirror           every contracted peer is also a devDependency, so
 *                           the package can be built and tested in-repo.
 *   7. node-engine          `engines.node` requires Node 20 or newer.
 *   8. documented           the versioning doc states the contract and the
 *                           compatibility matrix does not contradict it.
 *
 * Usage:
 *   node scripts/check-react-peer-contract.mjs [--root=<dir>] [--json=<file>]
 *
 * --json writes a machine-readable report (uploaded as a CI artifact). See
 * docs/runbooks/react-peer-contract.md.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, '..');

export const REACT_MANIFEST = 'packages/react/package.json';
export const REACT_ROLLUP_CONFIG = 'packages/react/rollup.config.js';
export const SDK_MANIFEST = 'sdk/package.json';
export const VERSIONING_DOC = 'docs/sdk-versioning.md';
export const COMPAT_MATRIX_DOC = 'docs/SDK_COMPATIBILITY_MATRIX.md';

/** The peer contract of record (docs/sdk-versioning.md, "Compatibility guarantees"). */
export const PEER_CONTRACT = Object.freeze({
  react: '^19.0.0',
  '@tanstack/react-query': '^5.62.0',
  '@iln/sdk': '^0.1.0',
});

/** Minimum supported Node.js range (docs/sdk-versioning.md). */
export const NODE_ENGINE = '>=20';

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseCaret(range) {
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(String(range).trim());
  return match ? { major: +match[1], minor: +match[2], patch: +match[3] } : null;
}

/**
 * Whether a caret range admits a concrete version. Supports only `^x.y.z`
 * (the contract shape); anything else is treated as not admitting.
 */
export function caretAdmits(range, version) {
  const r = parseCaret(range);
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!r || !v) return false;
  const major = +v[1];
  const minor = +v[2];
  const patch = +v[3];
  if (r.major === 0) {
    return major === 0 && minor === r.minor && patch >= r.patch;
  }
  return major === r.major && (minor > r.minor || (minor === r.minor && patch >= r.patch));
}

/** Whether an `engines.node` range requires at least the given major. */
export function nodeEngineAdmits(range, minimumMajor) {
  const match = /^>=\s*(\d+)/.exec(String(range ?? '').trim());
  return match ? +match[1] >= minimumMajor : false;
}

/** Reads the string entries of a rollup `external` array. */
export function parseRollupExternals(source) {
  const match = /external\s*:\s*\[([^\]]*)\]/.exec(source);
  if (!match) return new Set();
  const entries = match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  return new Set(entries);
}

/**
 * Validates the `@iln/react` peer contract across the manifest, the rollup
 * config and the documentation.
 *
 * @param {string} [root] repository root
 * @returns {{ findings: Array<object>, summary: object }}
 */
export function checkReactPeerContract(root = DEFAULT_ROOT) {
  const findings = [];
  const add = (rule, file, message) => findings.push({ rule, file, message });
  const peers = Object.keys(PEER_CONTRACT);

  const manifestPath = join(root, REACT_MANIFEST);
  if (!existsSync(manifestPath)) {
    add('contract-shape', REACT_MANIFEST, 'manifest is missing');
    return summarize(findings);
  }

  let pkg;
  try {
    pkg = readJson(manifestPath);
  } catch (err) {
    add('contract-shape', REACT_MANIFEST, `Invalid JSON: ${err.message}`);
    return summarize(findings);
  }

  const peerDependencies = pkg.peerDependencies;
  if (!isPlainObject(peerDependencies)) {
    add('contract-shape', REACT_MANIFEST, 'must declare a "peerDependencies" object');
  }
  if (!isPlainObject(pkg.engines) || typeof pkg.engines.node !== 'string') {
    add('contract-shape', REACT_MANIFEST, 'must declare an "engines.node" range');
  }

  const devDependencies = isPlainObject(pkg.devDependencies) ? pkg.devDependencies : {};

  for (const peer of peers) {
    const declared = isPlainObject(peerDependencies) ? peerDependencies[peer] : undefined;
    if (declared === undefined) {
      add('peer-missing', REACT_MANIFEST, `"${peer}" must be a peer dependency`);
      continue;
    }
    if (declared !== PEER_CONTRACT[peer]) {
      add(
        'peer-range',
        REACT_MANIFEST,
        `"${peer}" peer range is "${declared}", expected "${PEER_CONTRACT[peer]}" (the documented contract)`
      );
    }
    if (devDependencies[peer] === undefined) {
      add(
        'dev-mirror',
        REACT_MANIFEST,
        `"${peer}" must also be a devDependency for in-repo build/test`
      );
    }
  }

  const sdkManifestPath = join(root, SDK_MANIFEST);
  if (existsSync(sdkManifestPath)) {
    const sdkVersion = readJson(sdkManifestPath).version;
    const sdkPeer = isPlainObject(peerDependencies) ? peerDependencies['@iln/sdk'] : undefined;
    if (typeof sdkPeer === 'string' && sdkVersion && !caretAdmits(sdkPeer, sdkVersion)) {
      add(
        'sdk-version-drift',
        REACT_MANIFEST,
        `"@iln/sdk" peer range "${sdkPeer}" does not admit @iln/sdk@${sdkVersion}`
      );
    }
  }

  if (isPlainObject(pkg.engines) && typeof pkg.engines.node === 'string') {
    if (!nodeEngineAdmits(pkg.engines.node, 20)) {
      add(
        'node-engine',
        REACT_MANIFEST,
        `engines.node is "${pkg.engines.node}", expected a range requiring Node ${NODE_ENGINE}`
      );
    }
  }

  const rollupPath = join(root, REACT_ROLLUP_CONFIG);
  if (!existsSync(rollupPath)) {
    add('peer-bundled', REACT_ROLLUP_CONFIG, 'rollup config is missing');
  } else {
    const externals = parseRollupExternals(readFileSync(rollupPath, 'utf8'));
    for (const peer of peers) {
      if (!externals.has(peer)) {
        add(
          'peer-bundled',
          REACT_ROLLUP_CONFIG,
          `"${peer}" must be listed in "external" so it is not bundled`
        );
      }
    }
  }

  checkDocumented(root, add);
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
  return summarize(findings);
}

function checkDocumented(root, add) {
  const versioningPath = join(root, VERSIONING_DOC);
  if (!existsSync(versioningPath)) {
    add('documented', VERSIONING_DOC, 'versioning doc is missing');
  } else {
    const doc = readFileSync(versioningPath, 'utf8');
    for (const [peer, range] of Object.entries(PEER_CONTRACT)) {
      if (peer === '@tanstack/react-query') continue;
      if (!doc.includes(`${peer}@${range}`)) {
        add('documented', VERSIONING_DOC, `must state "${peer}@${range}" as a peer of @iln/react`);
      }
    }
  }

  const matrixPath = join(root, COMPAT_MATRIX_DOC);
  if (!existsSync(matrixPath)) {
    add('documented', COMPAT_MATRIX_DOC, 'compatibility matrix is missing');
    return;
  }
  const matrix = readFileSync(matrixPath, 'utf8');
  if (!matrix.includes('^0.1.0')) {
    add('documented', COMPAT_MATRIX_DOC, 'must document the "@iln/sdk" peer as "^0.1.0"');
  }
  if (/@iln\/sdk[^\n]*exact/i.test(matrix) || /\(exact\)/i.test(matrix)) {
    add(
      'documented',
      COMPAT_MATRIX_DOC,
      'claims an exact @iln/sdk peer; the contract is a caret range "^0.1.0"'
    );
  }
}

function summarize(findings) {
  return {
    findings,
    summary: {
      total: findings.length,
      ok: findings.length === 0,
      peers: Object.keys(PEER_CONTRACT),
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

  const report = checkReactPeerContract(root);

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(report, null, 2));
    console.log(`[react-peer-contract] wrote JSON report to ${jsonOut}`);
  }

  if (report.findings.length > 0) {
    console.error(
      `\x1b[31m[react-peer-contract] FAILED — ${report.findings.length} finding(s):\x1b[0m`
    );
    for (const f of report.findings) {
      console.error(`  - [${f.rule}] ${f.file}: ${f.message}`);
    }
    process.exit(1);
  }

  console.log(
    `\x1b[32m[react-peer-contract] OK — @iln/react keeps ${report.summary.peers.join(
      ', '
    )} as external peers\x1b[0m`
  );
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
