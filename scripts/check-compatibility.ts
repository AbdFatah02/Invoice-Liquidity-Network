/**
 * scripts/check-compatibility.ts
 *
 * CI check that validates the current contract, SDK, and frontend versions
 * are present in the compatibility matrix in docs/cross-repo-dependencies.md.
 *
 * It also validates the documentation site's version banner. The docs site is
 * single-track (it always describes the latest testnet build) and states which
 * release it describes in a banner on every page. That claim is only useful if
 * it is checked, so the banner's declared versions are asserted to match
 * docs/version-manifest.json, the two versioning pages, and the compatibility
 * matrix below. See docs/versioning.md.
 *
 * Usage:
 *   npx ts-node --esm scripts/check-compatibility.ts
 *   pnpm check-compatibility
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dirname ?? __dirname, '..');

type ReadFile = (fullPath: string) => string;

const defaultReadFile: ReadFile = (fullPath) => readFileSync(fullPath, 'utf-8');

// ---------------------------------------------------------------------------
// 1. Read current versions from source files
// ---------------------------------------------------------------------------

export function readContractVersion(
  root: string = ROOT,
  readFile: ReadFile = defaultReadFile
): string {
  const cargoPath = resolve(root, 'backend/contracts/invoice_liquidity/Cargo.toml');
  const content = readFile(cargoPath);
  const match = content.match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error(`Could not find version in ${cargoPath}`);
  }
  return match[1];
}

export function readJsonVersion(
  relativePath: string,
  root: string = ROOT,
  readFile: ReadFile = defaultReadFile
): string {
  const fullPath = resolve(root, relativePath);
  const content = readFile(fullPath);
  const json = JSON.parse(content) as { version?: string };
  if (!json.version) {
    throw new Error(`No "version" field in ${fullPath}`);
  }
  return json.version;
}

// ---------------------------------------------------------------------------
// 2. Parse compatibility matrix from markdown
// ---------------------------------------------------------------------------

export interface MatrixRow {
  contract: string;
  sdk: string;
  frontend: string;
}

export function parseCompatibilityMatrix(
  root: string = ROOT,
  readFile: ReadFile = defaultReadFile
): MatrixRow[] {
  const docPath = resolve(root, 'docs/cross-repo-dependencies.md');
  const content = readFile(docPath);

  const startMarker = '<!-- COMPATIBILITY_MATRIX_START -->';
  const endMarker = '<!-- COMPATIBILITY_MATRIX_END -->';

  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `Could not find compatibility matrix markers in ${docPath}. ` +
        `Expected ${startMarker} and ${endMarker}.`
    );
  }

  const matrixBlock = content.slice(startIdx + startMarker.length, endIdx);
  const lines = matrixBlock.split('\n').filter((line) => line.trim().startsWith('|'));

  // Skip header row and separator row (lines starting with |---)
  const dataLines = lines.filter((line) => {
    const trimmed = line.trim();
    // Skip separator rows like |---|---|---|---|
    if (/^\|[\s-|]+\|$/.test(trimmed)) return false;
    // Skip header row (first non-separator row with column names)
    if (trimmed.includes('Contract') && trimmed.includes('SDK') && trimmed.includes('Frontend')) {
      return false;
    }
    return true;
  });

  const rows: MatrixRow[] = [];

  for (const line of dataLines) {
    const cells = line
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);

    if (cells.length < 3) continue;

    // Extract version strings — they are wrapped in backticks like `0.1.0`
    const extractVersion = (cell: string): string => {
      const match = cell.match(/`([^`]+)`/);
      return match ? match[1] : cell;
    };

    rows.push({
      contract: extractVersion(cells[0]),
      sdk: extractVersion(cells[1]),
      frontend: extractVersion(cells[2]),
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// 3. Docs site version banner
// ---------------------------------------------------------------------------

interface VersionManifest {
  docsTrack: string;
  network: string;
  contract: { package: string; version: string; contractId: string; versionMethod: string };
  sdk: { package: string; version: string };
}

/** The declaration the docs banner renders. Canonical copy. */
const MANIFEST_PATH = 'docs/version-manifest.json';

/**
 * Files that mirror the manifest because they are consumed by a site build that
 * cannot reach outside its own package root. Each is scanned for the named
 * constants, whose values must equal the manifest's.
 */
const MANIFEST_MIRRORS: { path: string; constants: Record<string, keyof FlatManifest> }[] = [
  {
    path: 'packages/docs/lib/docs-version.ts',
    constants: {
      NETWORK: 'network',
      CONTRACT_VERSION: 'contractVersion',
      CONTRACT_ID: 'contractId',
      CONTRACT_VERSION_METHOD: 'versionMethod',
      SDK_VERSION: 'sdkVersion',
    },
  },
  {
    path: 'docs/theme.config.jsx',
    constants: {
      DOCS_CONTRACT_VERSION: 'contractVersion',
      DOCS_CONTRACT_ID: 'contractId',
      DOCS_SDK_VERSION: 'sdkVersion',
    },
  },
];

/** Versioning pages that quote the declared values in prose readers copy from. */
const VERSIONING_PAGES = ['docs/versioning.md', 'packages/docs/content/versioning.mdx'];

interface FlatManifest {
  network: string;
  contractVersion: string;
  contractId: string;
  versionMethod: string;
  sdkVersion: string;
}

function readManifest(): { manifest: VersionManifest; flat: FlatManifest } {
  const raw = readFileSync(resolve(ROOT, MANIFEST_PATH), 'utf-8');
  const manifest = JSON.parse(raw) as VersionManifest;

  const missing = [
    !manifest.contract?.version && 'contract.version',
    !manifest.contract?.contractId && 'contract.contractId',
    !manifest.contract?.versionMethod && 'contract.versionMethod',
    !manifest.sdk?.version && 'sdk.version',
    !manifest.network && 'network',
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`${MANIFEST_PATH} is missing required field(s): ${missing.join(', ')}`);
  }

  return {
    manifest,
    flat: {
      network: manifest.network,
      contractVersion: manifest.contract.version,
      contractId: manifest.contract.contractId,
      versionMethod: manifest.contract.versionMethod,
      sdkVersion: manifest.sdk.version,
    },
  };
}

/** Extract `const NAME = "value"` / `export const NAME = "value"` from a source file. */
function readStringConstant(source: string, name: string): string | null {
  const match = source.match(
    new RegExp(`(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*['"\`]([^'"\`]+)['"\`]`)
  );
  return match ? match[1] : null;
}

/**
 * Validate that everything claiming to know which release the docs describe
 * agrees: the manifest, its mirrors, the versioning pages, and the matrix.
 */
function checkDocsVersionDeclaration(matrix: MatrixRow[]): string[] {
  const errors: string[] = [];
  const { flat } = readManifest();

  for (const mirror of MANIFEST_MIRRORS) {
    const source = readFileSync(resolve(ROOT, mirror.path), 'utf-8');
    for (const [constantName, manifestKey] of Object.entries(mirror.constants)) {
      const actual = readStringConstant(source, constantName);
      const expected = flat[manifestKey];
      if (actual === null) {
        errors.push(`${mirror.path}: could not find a string constant named ${constantName}`);
      } else if (actual !== expected) {
        errors.push(
          `${mirror.path}: ${constantName} is "${actual}" but ${MANIFEST_PATH} declares "${expected}"`
        );
      }
    }
  }

  for (const page of VERSIONING_PAGES) {
    const content = readFileSync(resolve(ROOT, page), 'utf-8');
    if (!content.includes(flat.contractId)) {
      errors.push(`${page}: does not mention the declared contract ID ${flat.contractId}`);
    }
    if (!content.includes(flat.contractVersion)) {
      errors.push(
        `${page}: does not mention the declared contract version ${flat.contractVersion}`
      );
    }
  }

  const matrixMatch = matrix.some(
    (row) => row.contract === flat.contractVersion && row.sdk === flat.sdkVersion
  );
  if (!matrixMatch) {
    errors.push(
      `${MANIFEST_PATH}: contract ${flat.contractVersion} + SDK ${flat.sdkVersion} is not a row in ` +
        `the compatibility matrix, so the docs banner advertises an untested combination`
    );
  }

  return errors;
}

// ---------------------------------------------------------------------------
// 4. Main validation
// ---------------------------------------------------------------------------

export function validate(
  contractVersion: string,
  sdkVersion: string,
  frontendVersion: string,
  matrix: MatrixRow[]
): { ok: true } | { ok: false; message: string } {
  if (matrix.length === 0) {
    return {
      ok: false,
      message:
        '❌ Compatibility matrix is empty! Add at least one row to docs/cross-repo-dependencies.md.',
    };
  }

  const match = matrix.find(
    (row) =>
      row.contract === contractVersion && row.sdk === sdkVersion && row.frontend === frontendVersion
  );

  if (match) {
    return { ok: true };
  }

  const rows = matrix
    .map((r) => `     Contract: ${r.contract} | SDK: ${r.sdk} | Frontend: ${r.frontend}`)
    .join('\n');

  return {
    ok: false,
    message:
      `❌ Current version combination NOT found in the compatibility matrix!\n\n` +
      `   Expected one of these rows to match:\n${rows}\n\n` +
      `   Please update docs/cross-repo-dependencies.md with the new version combination.`,
  };
}

function main(): void {
  console.log('🔍 Checking cross-repo version compatibility...\n');

  const matrix = parseCompatibilityMatrix();

  if (matrix.length === 0) {
    console.error(
      '❌ Compatibility matrix is empty! Add at least one row to docs/cross-repo-dependencies.md.'
    );
    process.exit(1);
  }

  // Run first: this half needs no submodules, so docs contributors get useful
  // output even on a checkout without backend/ and frontend/.
  const docsErrors = checkDocsVersionDeclaration(matrix);

  if (docsErrors.length > 0) {
    console.error('❌ Docs site version banner is out of sync:\n');
    for (const error of docsErrors) {
      console.error(`     ${error}`);
    }
    console.error(
      '\n   Update docs/version-manifest.json and its mirrors together. See docs/versioning.md.\n'
    );
    process.exit(1);
  }

  console.log('✅ Docs version banner matches the manifest and the compatibility matrix.\n');

  const contractVersion = readContractVersion();
  const sdkVersion = readJsonVersion('sdk/package.json');
  const frontendVersion = readJsonVersion('frontend/package.json');

  console.log(`  Contract (invoice_liquidity): ${contractVersion}`);
  console.log(`  SDK (@iln/sdk): ${sdkVersion}`);
  console.log(`  Frontend (ILN-Frontend):      ${frontendVersion}`);
  console.log();

  const matrix = parseCompatibilityMatrix();

  const result = validate(contractVersion, sdkVersion, frontendVersion, matrix);

  if (result.ok) {
    console.log('✅ Current version combination found in the compatibility matrix.');
    process.exit(0);
  } else {
    console.error(result.message);
    process.exit(1);
  }
}

// Only run main() when executed directly (not when imported by tests).
if (process.argv[1]?.includes('check-compatibility')) {
  main();
}
