#!/usr/bin/env node
// Task 1: Dependency License Checker Script

const path = require('path');
const checker = require('license-checker-rseidelsohn');

const ALLOWLIST = [
  'MIT',
  'Apache-2.0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'CC-BY-4.0',
]; // BlueOak is a highly permissive, MIT-like license
const BLOCKLIST = ['GPL', 'LGPL', 'AGPL', 'SSPL', 'Commons Clause'];
const OWN_PACKAGES = [
  'invoice-liquidity-network',
  '@iln/sdk',
  '@iln/sdk-next',
  '@invoice-liquidity/cli',
  'iln-indexer',
  'iln-notifications',
  '@iln/indexer',
];

function isSingleLicenseAllowed(license) {
  const upperLicense = license.toUpperCase();

  // 1. Check blocklist first
  for (const blocked of BLOCKLIST) {
    const blockedUpper = blocked.toUpperCase();
    if (upperLicense.includes(blockedUpper)) {
      return false;
    }
  }

  // 2. Check allowlist
  for (const allowed of ALLOWLIST) {
    const allowedUpper = allowed.toUpperCase();
    if (
      upperLicense === allowedUpper ||
      upperLicense.startsWith(allowedUpper + '-') ||
      upperLicense.startsWith(allowedUpper + ' ') ||
      (allowedUpper.startsWith('BSD') && upperLicense.startsWith(allowedUpper))
    ) {
      return true;
    }
  }

  return false;
}

function isLicenseAllowed(licenseName) {
  if (!licenseName) return false;

  if (Array.isArray(licenseName)) {
    return licenseName.some((l) => isLicenseAllowed(l));
  }

  const cleanLicense = licenseName.trim().replace(/[*()]/g, '');

  if (cleanLicense.toUpperCase().includes(' OR ')) {
    const options = cleanLicense.split(/\s+OR\s+/i).map((o) => o.trim());
    return options.some((opt) => isSingleLicenseAllowed(opt));
  }

  const partsAnd = cleanLicense.split(/\s+AND\s+|[;,/]/i).map((p) => p.trim());
  return partsAnd.every((part) => isSingleLicenseAllowed(part));
}

// Packages to scan
const packagesToScan = [
  { name: 'Root', path: path.resolve(__dirname, '..') },
  { name: 'SDK', path: path.resolve(__dirname, '../sdk') },
  { name: 'CLI', path: path.resolve(__dirname, '../cli') },
  { name: 'Indexer', path: path.resolve(__dirname, '../indexer') },
  { name: 'Notifications', path: path.resolve(__dirname, '../notifications') },
  { name: 'Packages/Indexer', path: path.resolve(__dirname, '../packages/indexer') },
];

let totalViolations = 0;

function checkPath(pkg) {
  return new Promise((resolve) => {
    console.log(`\n🔍 Auditing license compliance for ${pkg.name}...`);

    checker.init(
      {
        start: pkg.path,
        production: true, // Only check production dependencies
        failOn: BLOCKLIST.join(';'), // Fail on blocklist
      },
      (err, packages) => {
        if (err) {
          // Sometimes license-checker returns an error if no packages found
          if (err.message && err.message.includes('No packages found')) {
            console.log(`✅ No production dependencies found in ${pkg.name}.`);
            return resolve();
          }
          console.error(`❌ Error scanning ${pkg.name}:`, err.message || err);
          totalViolations++;
          return resolve();
        }

        const violations = [];
        const checked = [];

        for (const [pkgNameVer, pkgInfo] of Object.entries(packages)) {
          const name = pkgNameVer.substring(0, pkgNameVer.lastIndexOf('@'));

          // Skip own monorepo packages
          if (
            OWN_PACKAGES.includes(name) ||
            name.startsWith('@invoice-liquidity/') ||
            name.startsWith('@iln/')
          ) {
            continue;
          }

          const licenses = pkgInfo.licenses;
          const isAllowed = isLicenseAllowed(licenses);

          if (!isAllowed) {
            violations.push({
              package: pkgNameVer,
              license: licenses,
              repository: pkgInfo.repository || 'N/A',
            });
          } else {
            checked.push({ package: pkgNameVer, license: licenses });
          }
        }

        if (violations.length > 0) {
          console.error(`❌ Found ${violations.length} license violation(s) in ${pkg.name}:`);
          violations.forEach((v) => {
            console.error(`  - Package: ${v.package}`);
            console.error(`    License: ${v.license}`);
            console.error(`    Repo:    ${v.repository}`);
          });
          totalViolations += violations.length;
        } else {
          console.log(
            `✅ ${pkg.name} compliance check passed! Audited ${checked.length} packages.`
          );
        }
        resolve();
      }
    );
  });
}

async function run() {
  for (const pkg of packagesToScan) {
    await checkPath(pkg);
  }

  console.log('\n======================================');
  if (totalViolations > 0) {
    console.error(`🚨 License audit failed with ${totalViolations} total violation(s).`);
    console.error('Please resolve the offending dependencies before releasing.');
    console.log('======================================');
    process.exit(1);
  } else {
    console.log('🎉 All packages passed license compliance checks!');
    console.log('======================================');
    process.exit(0);
  }
}

run().catch((err) => {
  console.error('Unexpected error running license check:', err);
  process.exit(1);
});
