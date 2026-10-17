import type { rpc as StellarRpc } from '@stellar/stellar-sdk';
import { CONFIG } from './config';
import { getCursorLedger, setCursorLedger, rollbackToLedger } from './db';
import { processEvent } from './processor';
import { server } from './rpc';

const BATCH_SIZE = 200;
const CONFIRMATION_DEPTH = 10;

/**
 * Run one full polling cycle:
 * - Determine the start ledger (from DB cursor or config/auto-detect).
 * - Page through ALL available contract events in batches of BATCH_SIZE.
 * - Process + persist each event (deduplication handled in processor).
 * - Advance the stored cursor to the highest ledger seen.
 *
 * Re-scanning the last processed ledger on every poll is intentional — it
 * protects the ledger boundary against missed events. Deduplication avoids
 * reprocessing unchanged events; removed events are not rolled back on re-org.
 */
export async function pollOnce(): Promise<void> {
  const stored = getCursorLedger();

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

  do {
    const request: StellarRpc.Api.GetEventsRequest = paginationCursor
      ? { cursor: paginationCursor, filters, limit: BATCH_SIZE }
      : { startLedger, filters, limit: BATCH_SIZE };


    const response = await server.getEvents(request);
    latestKnownLedger = response.latestLedger;

    const MAX_REORG_ROLLBACK_LEDGERS = 100;
    if (latestKnownLedger < stored) {
      const boundedRollbackLedger = Math.max(stored - MAX_REORG_ROLLBACK_LEDGERS, latestKnownLedger);
      console.warn(`[poller] Chain reorg detected! Latest ledger (${latestKnownLedger}) is behind cursor (${stored}). Rolling back to bounded ledger ${boundedRollbackLedger}...`);
      rollbackToLedger(boundedRollbackLedger);
      stored = boundedRollbackLedger;
      startLedger = boundedRollbackLedger;
      highestEventLedger = boundedRollbackLedger;
      paginationCursor = undefined;
      continue;
    }


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
  } while (paginationCursor);

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
