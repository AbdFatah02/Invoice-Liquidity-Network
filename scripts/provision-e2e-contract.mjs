#!/usr/bin/env node
/**
 * provision-e2e-contract.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Provision a REAL deployed contract for the cross-package E2E suite (#1241).
 *
 * Audit finding: `tests/e2e/lifecycle.test.ts` defaulted its contract ID to the
 * placeholder string `C_DEPLOYED_CONTRACT_ID` and `.github/workflows/e2e.yml`
 * exported the same placeholder, so the "lifecycle" suite could never have talked
 * to a deployed contract — while still reporting success whenever the node was up.
 *
 * This script is the single, fail-closed source of that contract ID:
 *
 *   1. If `CONTRACT_ID` (or `DEPLOYED_CONTRACT_ID`) is already set, it is
 *      verified against the live chain: the contract must exist as a ledger entry
 *      on the configured RPC. A placeholder or unknown ID is a hard failure.
 *   2. Otherwise the compiled WASM is deployed with the Stellar CLI to the
 *      configured RPC / network passphrase and the resulting ID is used.
 *   3. With neither available the script exits non-zero with the exact commands
 *      needed to fix it. It never writes a placeholder.
 *
 * Outputs (for CI and local runs):
 *   - prints `CONTRACT_ID=<id>` on stdout
 *   - writes the id to `--output-file` (default `.docker-output/e2e-contract-id.txt`)
 *   - appends `CONTRACT_ID=<id>` to `$GITHUB_ENV` / `$GITHUB_OUTPUT` when running
 *     inside GitHub Actions
 *
 * Exit codes: 0 provisioned, 1 unmet prerequisite / verification failure,
 * 2 invalid usage.
 *
 * Usage:
 *   node scripts/provision-e2e-contract.mjs [--rpc-url URL] [--wasm PATH]
 *                                         [--identity NAME] [--network NAME]
 *                                         [--output-file PATH] [--verify-only]
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Default standalone-network RPC, matching tests/e2e/docker-compose.yml. */
export const DEFAULT_RPC_URL = 'http://localhost:8000/soroban/rpc';
export const DEFAULT_NETWORK_PASSPHRASE = 'Standalone Network ; February 2017';
export const DEFAULT_OUTPUT_FILE = '.docker-output/e2e-contract-id.txt';
export const DEFAULT_WASM_CANDIDATES = [
  'invoice-liquidity-network/target/wasm32v1-none/release/invoice_liquidity.wasm',
  'backend/target/wasm32v1-none/release/invoice_liquidity.wasm',
  'target/wasm32v1-none/release/invoice_liquidity.wasm',
];

/** Placeholder contract IDs must never be accepted as provisioned (#1242). */
export const PLACEHOLDER_PATTERNS = [
  /^C_[A-Z0-9_]*REPLACE_ME$/,
  /^C_DEPLOYED_CONTRACT_ID$/,
  /^C_MOCK_CONTRACT_ID_REPLACE_ME$/,
  /^C_[A-Z]+_CONTRACT_ID$/,
  /dummy-contract-id/,
];

export function isPlaceholderContractId(value) {
  if (!value) return true;
  const trimmed = String(value).trim();
  if (!trimmed) return true;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** A deployed Soroban contract ID: `C` + 55 base32 characters. */
export function isDeployedContractIdShape(value) {
  return typeof value === 'string' && /^C[A-Z2-7]{55}$/.test(value.trim());
}

function parseArgs(argv) {
  const options = {
    rpcUrl: process.env.RPC_URL || DEFAULT_RPC_URL,
    wasm: process.env.ILN_WASM_PATH || null,
    identity: process.env.SOURCE || 'e2e-deployer',
    network: process.env.NETWORK_ALIAS || 'local',
    networkPassphrase: process.env.NETWORK_PASSPHRASE || DEFAULT_NETWORK_PASSPHRASE,
    outputFile: DEFAULT_OUTPUT_FILE,
    verifyOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) {
        console.error(`Missing value for ${arg}`);
        process.exit(2);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case '--rpc-url':
        options.rpcUrl = next();
        break;
      case '--wasm':
        options.wasm = next();
        break;
      case '--identity':
        options.identity = next();
        break;
      case '--network':
        options.network = next();
        break;
      case '--network-passphrase':
        options.networkPassphrase = next();
        break;
      case '--output-file':
        options.outputFile = next();
        break;
      case '--verify-only':
        options.verifyOnly = true;
        break;
      case '--help':
      case '-h':
        console.log(
          'usage: node scripts/provision-e2e-contract.mjs [--rpc-url URL] [--wasm PATH] ' +
            '[--identity NAME] [--network NAME] [--output-file PATH] [--verify-only]'
        );
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(2);
    }
  }

  return options;
}

/** Perform a single Soroban JSON-RPC call against `rpcUrl`. */
export async function rpcRequest(rpcUrl, method, params = {}) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  if (!response.ok) {
    throw new Error(`${method} failed: HTTP ${response.status} ${response.statusText}`);
  }

  const body = await response.json();
  if (body.error) {
    throw new Error(`${method} failed: ${body.error.message ?? JSON.stringify(body.error)}`);
  }
  return body.result;
}

/**
 * Boundary check: does `contractId` exist as a contract ledger entry on-chain?
 * `not_found` is a failed verification, not a soft "unknown".
 */
export async function verifyContractExists(rpcUrl, contractId) {
  if (isPlaceholderContractId(contractId)) {
    return { ok: false, reason: 'placeholder' };
  }
  if (!isDeployedContractIdShape(contractId)) {
    return { ok: false, reason: 'malformed' };
  }

  const result = await rpcRequest(rpcUrl, 'getLedgerEntries', {
    keys: [{ contractData: { contract: contractId, key: { vec: [] }, durability: 'persistent' } }],
  });

  const entries = result?.entries ?? [];
  return { ok: entries.length > 0, reason: entries.length > 0 ? undefined : 'not_found' };
}

function resolveWasmPath(explicit) {
  if (explicit) {
    const abs = resolve(ROOT, explicit);
    return existsSync(abs) ? abs : null;
  }
  for (const candidate of DEFAULT_WASM_CANDIDATES) {
    const abs = resolve(ROOT, candidate);
    if (existsSync(abs)) return abs;
  }
  return null;
}

function runStellar(args, { allowFailure = false } = {}) {
  const result = spawnSync('stellar', args, { encoding: 'utf8' });
  if (result.error) {
    throw new Error(
      `stellar CLI is unavailable (${result.error.message}). Install it with ` +
        '`cargo install --locked stellar-cli` or supply an already-deployed CONTRACT_ID.'
    );
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `stellar ${args[0]} failed (exit ${result.status}): ${(
        result.stderr ||
        result.stdout ||
        ''
      ).trim()}`
    );
  }
  return result;
}

function writeOutputs(contractId, outputFile, log) {
  const absOutput = resolve(ROOT, outputFile);
  mkdirSync(dirname(absOutput), { recursive: true });
  writeFileSync(absOutput, `${contractId}\n`);

  if (process.env.GITHUB_ENV) {
    writeFileSync(process.env.GITHUB_ENV, `CONTRACT_ID=${contractId}\n`, { flag: 'a' });
  }
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `contract-id=${contractId}\n`, { flag: 'a' });
  }

  log(`CONTRACT_ID=${contractId}`);
  log(`Wrote the provisioned contract id to ${outputFile}`);
}

async function main(argv, log = console.log) {
  const options = parseArgs(argv);

  // 0. The RPC itself must be reachable — a dead node is an actionable failure.
  try {
    const health = await rpcRequest(options.rpcUrl, 'getHealth');
    const status = health?.status ?? health;
    if (status !== 'healthy' && status !== 1 && status !== '1') {
      throw new Error(`status=${JSON.stringify(status)}`);
    }
  } catch (error) {
    console.error(
      `✗ Cannot provision a contract: ${options.rpcUrl} is not a healthy Soroban RPC ` +
        `(${error instanceof Error ? error.message : String(error)}).\n` +
        '  recovery: docker compose -f tests/e2e/docker-compose.yml up -d stellar-quickstart'
    );
    return 1;
  }

  // 1. Reuse an already-supplied contract ID, but only after verifying it.
  const supplied = process.env.CONTRACT_ID || process.env.DEPLOYED_CONTRACT_ID;
  if (supplied) {
    let verification;
    try {
      verification = await verifyContractExists(options.rpcUrl, supplied);
    } catch (error) {
      console.error(
        `✗ CONTRACT_ID=${supplied} could not be verified against ${options.rpcUrl}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
      return 1;
    }

    if (!verification.ok) {
      console.error(
        `✗ CONTRACT_ID=${supplied} is not a deployed contract on ${options.rpcUrl} ` +
          `(reason: ${verification.reason}).\n` +
          '  recovery: unset CONTRACT_ID to deploy the built WASM, or point CONTRACT_ID at a ' +
          'contract that exists on this network.'
      );
      return 1;
    }

    log(`Reusing the verified contract already deployed at ${supplied}`);
    writeOutputs(supplied, options.outputFile, log);
    return 0;
  }

  if (options.verifyOnly) {
    console.error(
      '✗ --verify-only was requested but no CONTRACT_ID/DEPLOYED_CONTRACT_ID is set.\n' +
        '  recovery: export CONTRACT_ID=<deployed contract id> or drop --verify-only to deploy.'
    );
    return 1;
  }

  // 2. Deploy the compiled WASM.
  const wasmPath = resolveWasmPath(options.wasm);
  if (!wasmPath) {
    console.error(
      '✗ No compiled contract WASM found, so no real contract can be provisioned.\n' +
        `  looked in: ${(options.wasm ? [options.wasm] : DEFAULT_WASM_CANDIDATES).join(', ')}\n` +
        '  recovery: build the contract (cargo build --target wasm32v1-none --release) or set ' +
        'CONTRACT_ID to an already-deployed contract.\n' +
        '  Note: no placeholder contract id is ever emitted.'
    );
    return 1;
  }

  // Register the network (idempotent) and make sure the deployer identity exists.
  runStellar(
    [
      'network',
      'add',
      options.network,
      '--rpc-url',
      options.rpcUrl,
      '--network-passphrase',
      options.networkPassphrase,
    ],
    { allowFailure: true }
  );
  runStellar(['network', 'use', options.network], { allowFailure: true });
  runStellar(['keys', 'generate', options.identity, '--network', options.network], {
    allowFailure: true,
  });

  try {
    runStellar([
      'contract',
      'deploy',
      '--wasm',
      wasmPath,
      '--source',
      options.identity,
      '--network',
      options.network,
    ]);
  } catch (error) {
    console.error(
      `✗ Deploying ${wasmPath} failed: ${
        error instanceof Error ? error.message : String(error)
      }\n` +
        '  recovery: fund the deployer identity on this network or supply CONTRACT_ID for an ' +
        'already-deployed contract.'
    );
    return 1;
  }

  let contractId;
  try {
    contractId = runStellar([
      'contract',
      'list',
      '--source',
      options.identity,
      '--network',
      options.network,
    ])
      .stdout.trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .pop();
  } catch (error) {
    console.error(
      `✗ Could not read the deployed contract id after deployment: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
    return 1;
  }

  if (isPlaceholderContractId(contractId) || !isDeployedContractIdShape(contractId ?? '')) {
    console.error(
      `✗ Deployment did not yield a valid contract id (got ${JSON.stringify(contractId)}).\n` +
        '  recovery: inspect `stellar contract list` output; this control refuses to emit a ' +
        'placeholder value.'
    );
    return 1;
  }

  const verification = await verifyContractExists(options.rpcUrl, contractId);
  if (!verification.ok) {
    console.error(
      `✗ Freshly deployed contract ${contractId} is not visible on ${options.rpcUrl} ` +
        `(reason: ${verification.reason}).\n` +
        '  recovery: wait for the contract to be included in a ledger and re-run, or set ' +
        'CONTRACT_ID to a contract that exists on this network.'
    );
    return 1;
  }

  log(`Deployed and verified contract ${contractId} from ${wasmPath}`);
  writeOutputs(contractId, options.outputFile, log);
  return 0;
}

// Only run when invoked as a script (exported for tests).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`✗ provision-e2e-contract failed: ${error?.message ?? error}`);
      process.exit(1);
    });
}

export { main, parseArgs, resolveWasmPath };
