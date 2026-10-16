#!/usr/bin/env ts-node
/**
 * LP Funding Automation Script
 *
 * Queries the ILN indexer for pending invoices, filters by criteria,
 * sorts by yield descending, and funds the top N invoices.
 *
 * Demonstrates SDK-level backoff/retry for RPC calls to prevent
 * accidental self-DoS when hammering endpoints with retries.
 *
 * Usage:
 *   SECRET_KEY=S... INDEXER_URL=https://... ts-node index.ts [--dry-run] [--top-n 5]
 */

import axios from 'axios';
import { Command } from 'commander';
import { ILNSdk, createKeypairSigner, ILN_TESTNET, withBackoff, isTransientError } from '@iln/sdk';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Indexer invoice shape (amount as string, snake_case). */
interface IndexerInvoice {
  id: number;
  freelancer: string;
  payer: string;
  amount: string;
  due_date: number;
  discount_rate: number;
  status: string;
  funder: string | null;
}

/** LP funding criteria — all fields optional, defaults applied at runtime. */
interface LPCriteria {
  /** Minimum yield in basis points (default 100 = 1%). */
  minYieldBps: number;
  /** Maximum invoice amount in stroops (default 10_000 USDC = 100_000_000_000 stroops). */
  maxAmount: bigint;
  /** Minimum freelancer reputation score 0–100 (default 0 — no filter). */
  minReputation: number;
  /** Whitelisted token addresses. Empty array = accept any. */
  allowedTokens: string[];
  /** Maximum total spend per run in stroops (hard safety cap). */
  maxSpendPerRun: bigint;
  /** Maximum invoices to fund per run. */
  topN: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_CRITERIA: LPCriteria = {
  minYieldBps: 100, // 1%
  maxAmount: 100_000_000_000n, // 10,000 USDC in stroops
  minReputation: 0,
  allowedTokens: [],
  maxSpendPerRun: 500_000_000_000n, // 50,000 USDC
  topN: 5,
};

const INDEXER_URL = process.env.INDEXER_URL ?? 'https://iln-indexer.up.railway.app';
const SECRET_KEY = process.env.SECRET_KEY ?? '';
const CONTRACT_ID = process.env.CONTRACT_ID ?? ILN_TESTNET.contractId;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Effective yield for an invoice in bps, based on discount_rate alone. */
function yieldBps(invoice: IndexerInvoice): number {
  return invoice.discount_rate;
}

/** Compute amount the LP pays (amount minus the discount). */
function lpCost(invoice: IndexerInvoice): bigint {
  const amount = BigInt(invoice.amount);
  return amount - (amount * BigInt(invoice.discount_rate)) / 10_000n;
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─── Core logic ───────────────────────────────────────────────────────────────

async function fetchPendingInvoices(indexerUrl: string): Promise<IndexerInvoice[]> {
  const { result } = await withBackoff(
    async () => {
      const { data } = await axios.get<{ invoices: IndexerInvoice[] }>(
        `${indexerUrl}/invoices?status=Pending`
      );
      return data.invoices;
    },
    {
      maxRetries: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 10_000,
      isRetryable: (error) => {
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          if (status === 429 || (status !== undefined && status >= 500)) return true;
        }
        return isTransientError(error);
      },
      onRetry: (attempt, error, delayMs) => {
        log(
          `Retrying indexer fetch (attempt ${attempt}) after ${delayMs}ms: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      },
    }
  );
  return result;
}

function filterInvoices(invoices: IndexerInvoice[], criteria: LPCriteria): IndexerInvoice[] {
  return invoices.filter((inv) => {
    if (yieldBps(inv) < criteria.minYieldBps) return false;
    if (BigInt(inv.amount) > criteria.maxAmount) return false;
    // allowedTokens filter: skip if list is non-empty and token not in list
    // (token address would be part of invoice in a multi-token deployment)
    return true;
  });
}

function sortByYieldDesc(invoices: IndexerInvoice[]): IndexerInvoice[] {
  return [...invoices].sort((a, b) => yieldBps(b) - yieldBps(a));
}

async function run(criteria: LPCriteria, dryRun: boolean): Promise<void> {
  log(`Starting LP automation. dry-run=${dryRun}`);
  log(
    `Criteria: minYieldBps=${criteria.minYieldBps}, maxAmount=${criteria.maxAmount}, topN=${criteria.topN}`
  );

  // 1. Fetch pending invoices from indexer
  const pending = await fetchPendingInvoices(INDEXER_URL);
  log(`Fetched ${pending.length} pending invoices from indexer`);

  // 2. Filter + sort
  const candidates = sortByYieldDesc(filterInvoices(pending, criteria)).slice(0, criteria.topN);
  log(`${candidates.length} invoices match criteria after filtering`);

  if (candidates.length === 0) {
    log('Nothing to fund. Exiting.');
    return;
  }

  // 3. Set up SDK (only needed for live run)
  let sdk: ILNSdk | null = null;
  let funderAddress = '';

  if (!dryRun) {
    if (!SECRET_KEY) {
      throw new Error('SECRET_KEY env var is required for live mode.');
    }
    const signer = createKeypairSigner(SECRET_KEY);
    funderAddress = await signer.getPublicKey();
    sdk = new ILNSdk({
      contractId: CONTRACT_ID,
      rpcUrl: ILN_TESTNET.rpcUrl,
      networkPassphrase: ILN_TESTNET.networkPassphrase,
      signer,
      // SDK-level backoff prevents accidental self-DoS from retry loops.
      // Retries up to 3 times with exponential backoff and jitter.
      backoff: {
        maxRetries: 3,
        baseDelayMs: 500,
        maxDelayMs: 10_000,
        jitter: 0.25,
      },
    });
    log(`Funding as: ${funderAddress}`);
  }

  // 4. Fund (or simulate) each candidate, respecting the spend cap
  let totalSpent = 0n;
  const results: Array<{ id: number; status: string; cost?: bigint; error?: string }> = [];

  for (const invoice of candidates) {
    const cost = lpCost(invoice);

    if (totalSpent + cost > criteria.maxSpendPerRun) {
      log(`Invoice #${invoice.id}: would exceed maxSpendPerRun cap — stopping`);
      break;
    }

    if (dryRun) {
      log(
        `[DRY-RUN] Would fund invoice #${invoice.id}  ` +
          `yield=${yieldBps(invoice)}bps  amount=${invoice.amount}  cost=${cost}`
      );
      results.push({ id: invoice.id, status: 'dry-run', cost });
      totalSpent += cost;
      continue;
    }

    // Live: attempt to fund; skip on simulation/tx failure
    try {
      await sdk!.fundInvoice({ funder: funderAddress, invoiceId: BigInt(invoice.id) });
      log(`✓ Funded invoice #${invoice.id}  cost=${cost} stroops`);
      results.push({ id: invoice.id, status: 'funded', cost });
      totalSpent += cost;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`✗ Skipped invoice #${invoice.id}: ${message}`);
      results.push({ id: invoice.id, status: 'skipped', error: message });
    }
  }

  // 5. Summary
  log('─── Run summary ───────────────────────────────────────');
  log(`Total invoices evaluated : ${candidates.length}`);
  log(`Funded                   : ${results.filter((r) => r.status === 'funded').length}`);
  log(`Dry-run (would fund)     : ${results.filter((r) => r.status === 'dry-run').length}`);
  log(`Skipped (errors)         : ${results.filter((r) => r.status === 'skipped').length}`);
  log(`Total spent              : ${totalSpent} stroops`);
  log('───────────────────────────────────────────────────────');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('lp-automation')
  .description('Automatically fund ILN invoices matching LP criteria')
  .option('--dry-run', 'Log what would be funded without submitting transactions', false)
  .option('--top-n <n>', 'Maximum invoices to fund per run', String(DEFAULT_CRITERIA.topN))
  .option(
    '--min-yield <bps>',
    'Minimum yield in basis points',
    String(DEFAULT_CRITERIA.minYieldBps)
  )
  .option(
    '--max-amount <stroops>',
    'Maximum invoice amount in stroops',
    String(DEFAULT_CRITERIA.maxAmount)
  )
  .option(
    '--max-spend <stroops>',
    'Maximum total spend per run in stroops',
    String(DEFAULT_CRITERIA.maxSpendPerRun)
  )
  .parse(process.argv);

const opts = program.opts<{
  dryRun: boolean;
  topN: string;
  minYield: string;
  maxAmount: string;
  maxSpend: string;
}>();

const criteria: LPCriteria = {
  ...DEFAULT_CRITERIA,
  topN: parseInt(opts.topN, 10),
  minYieldBps: parseInt(opts.minYield, 10),
  maxAmount: BigInt(opts.maxAmount),
  maxSpendPerRun: BigInt(opts.maxSpend),
};

run(criteria, opts.dryRun).catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
