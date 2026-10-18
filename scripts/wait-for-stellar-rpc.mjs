#!/usr/bin/env node
/** Deterministic Stellar RPC readiness control (#1245). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class RpcReadinessError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'RpcReadinessError';
  }
}

async function rpc(fetchImpl, url, method, id) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body?.jsonrpc !== '2.0' || body?.id !== id || body?.error || !body?.result) {
    throw new Error(`invalid ${method} JSON-RPC response`);
  }
  return body.result;
}

export async function waitForStellarRpc(options = {}) {
  const {
    url = 'http://localhost:8000/soroban/rpc',
    attempts = 60,
    intervalMs = 2_000,
    consecutiveSuccesses = 2,
    fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => new Date().toISOString(),
    onAttempt = () => {},
  } = options;
  if (!Number.isInteger(attempts) || attempts < 1) throw new TypeError('attempts must be >= 1');
  if (!Number.isInteger(consecutiveSuccesses) || consecutiveSuccesses < 1)
    throw new TypeError('consecutiveSuccesses must be >= 1');

  const evidence = {
    control: 'stellar-rpc-readiness',
    owner: 'E2E maintainers',
    url,
    startedAt: now(),
    attempts: [],
  };
  let consecutive = 0;
  let previousLedger = null;
  let lastError = 'no probe attempted';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const health = await rpc(fetchImpl, url, 'getHealth', `health-${attempt}`);
      if (health.status !== 'healthy')
        throw new Error(`health status is ${health.status ?? '<missing>'}`);
      const ledger = await rpc(fetchImpl, url, 'getLatestLedger', `ledger-${attempt}`);
      const sequence = Number(ledger.sequence);
      if (!Number.isSafeInteger(sequence) || sequence <= 0)
        throw new Error(`invalid ledger sequence ${String(ledger.sequence)}`);
      if (previousLedger !== null && sequence < previousLedger)
        throw new Error(`ledger regressed from ${previousLedger} to ${sequence}`);
      previousLedger = sequence;
      consecutive += 1;
      evidence.attempts.push({ attempt, ok: true, sequence, at: now() });
      onAttempt(evidence.attempts.at(-1));
      if (consecutive >= consecutiveSuccesses) {
        return { ...evidence, ready: true, completedAt: now(), latestLedger: sequence };
      }
    } catch (error) {
      consecutive = 0;
      previousLedger = null;
      lastError = error instanceof Error ? error.message : String(error);
      evidence.attempts.push({ attempt, ok: false, error: lastError, at: now() });
      onAttempt(evidence.attempts.at(-1));
    }
    if (attempt < attempts) await sleep(intervalMs);
  }

  const result = { ...evidence, ready: false, completedAt: now(), error: lastError };
  throw new RpcReadinessError(
    `Stellar RPC ${url} was not deterministically ready after ${attempts} attempts: ${lastError}`,
    { cause: result }
  );
}

function parseArgs(argv) {
  const out = {
    url: process.env.STELLAR_RPC_URL || 'http://localhost:8000/soroban/rpc',
    attempts: 60,
    intervalMs: 2_000,
    consecutiveSuccesses: 2,
    evidence: '.artifacts/rpc-readiness.json',
  };
  for (const arg of argv) {
    const [key, value] = arg.split('=', 2);
    if (key === '--url') out.url = value;
    else if (key === '--attempts') out.attempts = Number(value);
    else if (key === '--interval-ms') out.intervalMs = Number(value);
    else if (key === '--consecutive-successes') out.consecutiveSuccesses = Number(value);
    else if (key === '--evidence') out.evidence = value;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let evidence;
  try {
    evidence = await waitForStellarRpc({
      ...options,
      onAttempt: (attempt) =>
        console.log(
          attempt.ok
            ? `[rpc-ready] attempt ${attempt.attempt}: healthy at ledger ${attempt.sequence}`
            : `[rpc-ready] attempt ${attempt.attempt}: ${attempt.error}`
        ),
    });
    console.log(`[rpc-ready] ready after ${evidence.attempts.length} attempts`);
  } catch (error) {
    evidence = error.cause ?? { ready: false, error: error.message };
    console.error(`[rpc-ready] ${error.message}`);
    process.exitCode = 1;
  } finally {
    mkdirSync(dirname(options.evidence), { recursive: true });
    writeFileSync(options.evidence, `${JSON.stringify(evidence, null, 2)}\n`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
