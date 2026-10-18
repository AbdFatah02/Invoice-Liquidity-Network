import type { rpc as StellarRpc } from '@stellar/stellar-sdk';
import { CONFIG } from './config';
import {
  getCursorLedger,
  setCursorLedger,
  rollbackToLedger,
  recordForkDecision,
  getPendingForkDecision,
  incrementForkDecisionAttempts,
  quarantineForkDecision,
} from './db';
import { reorgAbortionsTotal, reorgRollbacksTotal } from './metrics';
import { invalidateInvoiceCache } from './cache';
import { processEvent } from './processor';
import { server } from './rpc';

const BATCH_SIZE = 200;
const CONFIRMATION_DEPTH = 10;

/**
 * Maximum number of same-cycle rollbacks accepted before the cycle is aborted.
 * A node tip that keeps falling below the cursor is a persistent re-org (or a
 * misbehaving RPC) and must not be hidden by an unbounded retry loop (#1256, #1259).
 */
const MAX_REORG_RETRIES = 3;

/**
 * Maximum recovery attempts allowed for an incomplete re-org decision before
 * quarantining it to prevent infinite restart crash loops (#1262).
 */
export const MAX_REORG_RECOVERY_ATTEMPTS = 3;

/**
 * Run one full polling cycle:
 * - Reconcile any uncompleted fork replacement decision from a prior crashed run (#1258).
 * - Quarantine incomplete or repeatedly failing re-org recovery to prevent crash loops (#1262).
 * - Determine the start ledger (from DB cursor or config/auto-detect).
 * - Page through ALL available contract events in batches of BATCH_SIZE.
 * - Process + persist each event (deduplication handled in processor).
 * - Advance the stored cursor to the highest ledger seen adhering to monotonicity (#1263).
 *
 * Re-scanning the last processed ledger on every poll is intentional — it
 * protects the ledger boundary against missed events. Deduplication avoids
 * reprocessing unchanged events.
 *
 * Cursor state is mutable: a chain re-org can push the node tip *below* the
 * stored cursor. When that happens we roll the persisted cursor (and any derived
 * events above the new tip) back to the tip and re-scan in the same cycle. The
 * re-scan is bounded by `MAX_REORG_RETRIES`; a re-org that never stabilises is
 * surfaced as an error rather than silently trusting a cursor above the chain
 * head (#1256, #1259).
 */
export async function pollOnce(): Promise<void> {
  let stored = getCursorLedger();

  // ── Reconcile any uncompleted fork decision from a prior restart/crash (#1258, #1262) ──
  const pendingFork = getPendingForkDecision();
  if (pendingFork) {
    const attempts = incrementForkDecisionAttempts(pendingFork.id);
    if (attempts > MAX_REORG_RECOVERY_ATTEMPTS) {
      console.error(
        `[poller] Fork decision #${pendingFork.id} exceeded maximum recovery attempts (${attempts} > ${MAX_REORG_RECOVERY_ATTEMPTS}). Quarantining incomplete reorg.`
      );
      quarantineForkDecision(
        pendingFork.id,
        `Exceeded maximum recovery attempts (${attempts} > ${MAX_REORG_RECOVERY_ATTEMPTS})`,
        'Persistent recovery failure during startup reconciliation'
      );
      stored = getCursorLedger();
    } else {
      try {
        console.warn(
          `[poller] Recovering pending fork replacement decision #${pendingFork.id} (attempt ${attempts}/${MAX_REORG_RECOVERY_ATTEMPTS}, from ${pendingFork.from_ledger} to ${pendingFork.to_ledger})`
        );
        const { affectedInvoiceIds } = rollbackToLedger(pendingFork.to_ledger, pendingFork.id);
        if (affectedInvoiceIds.length > 0) {
          await Promise.all(affectedInvoiceIds.map((id) => invalidateInvoiceCache(id).catch(() => {})));
        }
        stored = pendingFork.to_ledger;
      } catch (err: unknown) {
        console.error(`[poller] Error recovering fork decision #${pendingFork.id}:`, err);
        if (attempts >= MAX_REORG_RECOVERY_ATTEMPTS) {
          quarantineForkDecision(
            pendingFork.id,
            'Rollback failure during recovery',
            err instanceof Error ? err.stack || err.message : String(err)
          );
        }
        throw err;
      }
    }
  }

  // ── Determine start ledger ────────────────────────────────────────────────
  let startLedger: number;
  if (stored === 0) {
    if (CONFIG.startLedger > 0) {
      startLedger = CONFIG.startLedger;
    } else {
      // Auto-detect: start 1 000 ledgers before the current tip (~83 minutes).
      const latest = await server.getLatestLedger();
      startLedger = Math.max(1, latest.sequence - 1_000);
    }
  } else {
    // Re-scan from the last processed ledger so we never miss an event at the
    // boundary, even if we crashed mid-batch.
    startLedger = stored;
  }

  // ── Page through events ───────────────────────────────────────────────────
  const filters: StellarRpc.Api.EventFilter[] = [
    { type: 'contract', contractIds: [CONFIG.contractId] },
  ];
  let paginationCursor: string | undefined;
  let highestEventLedger = stored;
  let latestKnownLedger = stored;
  let reorgsThisCycle = 0;

  // A `while (true)` loop (rather than `do … while (paginationCursor)`) so that a
  // detected re-org re-scans from the rolled-back ledger within the *same* cycle
  // instead of exiting while the local cursor still points above the chain head.
  for (;;) {
    const request: StellarRpc.Api.GetEventsRequest = paginationCursor
      ? { cursor: paginationCursor, filters, limit: BATCH_SIZE }
      : { startLedger, filters, limit: BATCH_SIZE };

    const response = await server.getEvents(request);
    latestKnownLedger = response.latestLedger;

    const MAX_REORG_ROLLBACK_LEDGERS = 100;
    if (latestKnownLedger < stored) {
      if (reorgsThisCycle >= MAX_REORG_RETRIES) {
        try {
          reorgAbortionsTotal.inc();
        } catch {
          /* metrics failure is non-fatal */
        }
        throw new Error(
          `[poller] Chain reorg did not stabilise after ${MAX_REORG_RETRIES} attempts (latest: ${latestKnownLedger}, cursor: ${stored})`
        );
      }
      reorgsThisCycle++;
      try {
        reorgRollbacksTotal.inc();
      } catch {
        /* metrics failure is non-fatal */
      }

      const boundedRollbackLedger = Math.max(stored - MAX_REORG_ROLLBACK_LEDGERS, latestKnownLedger);
      console.warn(
        `[poller] Chain reorg detected! Latest ledger (${latestKnownLedger}) is behind cursor (${stored}). Rolling back to bounded ledger ${boundedRollbackLedger}...`
      );

      // Persist fork replacement decision for restart safety (#1258)
      const decisionId = recordForkDecision(stored, boundedRollbackLedger, latestKnownLedger);

      // Reconcile cursor and rollback removed events and invoices (#1257, #1259)
      const { affectedInvoiceIds } = rollbackToLedger(boundedRollbackLedger, decisionId);

      // Invalidate caches for affected invoices
      if (affectedInvoiceIds.length > 0) {
        await Promise.all(affectedInvoiceIds.map((id) => invalidateInvoiceCache(id).catch(() => {})));
      }

      stored = boundedRollbackLedger;
      startLedger = boundedRollbackLedger;
      highestEventLedger = boundedRollbackLedger;
      paginationCursor = undefined;
      continue;
    }

    // Forward progress re-establishes the re-org detection budget.
    reorgsThisCycle = 0;

    for (const event of response.events) {
      if (latestKnownLedger - event.ledger < CONFIRMATION_DEPTH) {
        continue;
      }
      await processEvent(event);
      if (event.ledger > highestEventLedger) {
        highestEventLedger = event.ledger;
      }
    }

    // The response always carries a cursor. Only follow it if we hit the full
    // page limit — otherwise we've consumed all available events.
    paginationCursor = response.events.length === BATCH_SIZE ? response.cursor : undefined;

    if (highestEventLedger > stored) {
      setCursorLedger(highestEventLedger);
      stored = highestEventLedger;
    }

    if (!paginationCursor) break;
  }

  // ── Advance cursor ────────────────────────────────────────────────────────
  // Save up to (latestLedger - CONFIRMATION_DEPTH) so next poll starts from the confirmed tip,
  // giving a small overlap window for any in-flight events.
  const newCursor = Math.max(highestEventLedger, Math.max(0, latestKnownLedger - CONFIRMATION_DEPTH));
  if (newCursor > stored) {
    setCursorLedger(newCursor);
  }
}

/**
 * Start the continuous polling loop.
 * Runs `pollOnce()` immediately, then schedules itself after each cycle.
 * Errors are logged and swallowed so the loop never stops.
 */
export async function startPolling(): Promise<void> {
  console.log(
    `[poller] Starting — polling every ${CONFIG.pollIntervalMs}ms for contract ${CONFIG.contractId}`
  );

  const tick = async () => {
    try {
      await pollOnce();
    } catch (err) {
      console.error('[poller] Error during poll:', err);
    }
    setTimeout(tick, CONFIG.pollIntervalMs);
  };

  await tick();
}
