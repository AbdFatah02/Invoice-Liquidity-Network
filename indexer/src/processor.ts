import { type rpc, scValToNative } from '@stellar/stellar-sdk';
import { hasEvent, applyEventWithInvoice } from './db';
import { eventsProcessedTotal, duplicateEventsTotal, invoicesUpsertedTotal } from './metrics';
import { invalidateInvoiceCache } from './cache';
import { fetchInvoice } from './rpc';
import type { ILNEvent, ILNEventType } from './types';
import {
  pubsub,
  INVOICE_UPDATED,
  EVENT_STREAM,
  LEGACY_INVOICE_CREATED,
  LEGACY_INVOICE_UPDATED,
} from './graphql/pubsub';

const KNOWN_EVENT_TYPES = new Set<ILNEventType>(['submitted', 'funded', 'paid', 'defaulted']);

/**
 * Process a single Soroban contract event:
 * 1. Deduplicate by event_id.
 * 2. Decode the topic symbol and invoice_id from the event body.
 * 3. Fetch the latest invoice state from the RPC.
 * 4. Atomically persist the event record and upsert the invoice into SQLite (#1260).
 *
 * Atomic application ensures that an RPC error or crash never leaves an event
 * marked as processed without its invoice state, guaranteeing idempotency across
 * replays and restarts.
 */
export async function processEvent(event: rpc.Api.EventResponse): Promise<void> {
  // ── Deduplication ─────────────────────────────────────────────────────────
  if (hasEvent(event.id)) {
    try {
      duplicateEventsTotal.inc();
    } catch {
      /* metrics failure is non-fatal */
    }
    return;
  }

  // ── Decode event type from topic[0] ───────────────────────────────────────
  if (!event.topic || event.topic.length === 0) return;

  const eventType = scValToNative(event.topic[0]) as string;
  if (!KNOWN_EVENT_TYPES.has(eventType as ILNEventType)) {
    return;
  }

  // ── Decode invoice_id from value ──────────────────────────────────────────
  const invoiceId = Number(scValToNative(event.value) as bigint);

  const ilnEvent: ILNEvent = {
    event_id: event.id,
    event_type: eventType as ILNEventType,
    invoice_id: invoiceId,
    ledger: event.ledger,
    ledger_closed_at: event.ledgerClosedAt,
    created_at: Date.now(),
  };

  // ── Fetch latest invoice state from RPC ───────────────────────────────────
  let invoice = null;
  let attempts = 0;
  const maxAttempts = 3;
  while (attempts < maxAttempts) {
    try {
      invoice = await fetchInvoice(invoiceId);
      break;
    } catch (fetchErr) {
      attempts++;
      if (attempts >= maxAttempts) {
        console.error(`[processor] Failed to fetch invoice ${invoiceId} after ${maxAttempts} attempts`, fetchErr);
        throw fetchErr;
      }
      await new Promise((resolve) => setTimeout(resolve, 300 * Math.pow(2, attempts)));
    }
  }

  // ── Atomic Event & Invoice Application (#1260) ───────────────────────────
  const { isChanged } = applyEventWithInvoice(ilnEvent, invoice);

  // Track processed events
  try {
    eventsProcessedTotal.inc();
  } catch {
    /* metrics failure is non-fatal */
  }

  if (invoice) {
    if (isChanged) {
      await invalidateInvoiceCache(invoiceId);
      try {
        invoicesUpsertedTotal.inc();
      } catch {
        /* metrics failure is non-fatal */
      }
    }

    // Publish to the single shared pubsub.
    pubsub.publish(INVOICE_UPDATED, { invoiceUpdated: invoice, triggeringEvent: ilnEvent });
    pubsub.publish(EVENT_STREAM, { eventStream: ilnEvent });
    if (eventType === 'submitted') {
      pubsub.publish(LEGACY_INVOICE_CREATED, invoice);
    } else {
      pubsub.publish(LEGACY_INVOICE_UPDATED, invoice);
    }
  }
}
