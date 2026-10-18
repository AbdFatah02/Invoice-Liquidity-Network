import { type rpc, scValToNative } from '@stellar/stellar-sdk';
import { hasEvent, insertEvent, upsertInvoice, getInvoiceById } from './db';
import { eventsProcessedTotal, invoicesUpsertedTotal } from './metrics';
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
 * 3. Persist the event record.
 * 4. Fetch the latest invoice state from the RPC and upsert into SQLite.
 *
 * Fetching via RPC (rather than parsing all fields from events) ensures we
 * always have accurate state even if events are processed out-of-order or after
 * a re-org.
 */
export async function processEvent(event: rpc.Api.EventResponse): Promise<void> {
  // ── Deduplication ─────────────────────────────────────────────────────────
  if (hasEvent(event.id)) {
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

  // ── Persist event record (INSERT OR IGNORE handles any race condition) ────
  const ilnEvent: ILNEvent = {
    event_id: event.id,
    event_type: eventType as ILNEventType,
    invoice_id: invoiceId,
    ledger: event.ledger,
    ledger_closed_at: event.ledgerClosedAt,
    created_at: Date.now(),
  };
  insertEvent(ilnEvent);

  // Track processed events
  try {
    eventsProcessedTotal.inc();
  } catch {
    /* metrics failure is non-fatal */
  }

  // ── Fetch latest invoice state and upsert ─────────────────────────────────
  // We fetch current state from RPC with exponential retry (Issue #1271)
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

  if (invoice) {
    const existing = getInvoiceById(invoiceId);
    const isChanged = !existing || existing.status !== invoice.status || existing.funder !== (invoice.funder ?? null);

    if (isChanged) {
      upsertInvoice(invoice);
      await invalidateInvoiceCache(invoiceId);
      try {
        invoicesUpsertedTotal.inc();
      } catch {
        /* metrics failure is non-fatal */
      }
    }
    // Publish to the single shared pubsub. The modular WebSocket schema
    // receives structured payloads, while the legacy Yoga schema receives
    // the raw invoice on its own namespaced channels (see ./graphql/pubsub).
    pubsub.publish(INVOICE_UPDATED, { invoiceUpdated: invoice, triggeringEvent: ilnEvent });
    pubsub.publish(EVENT_STREAM, { eventStream: ilnEvent });
    if (eventType === 'submitted') {
      pubsub.publish(LEGACY_INVOICE_CREATED, invoice);
    } else {
      pubsub.publish(LEGACY_INVOICE_UPDATED, invoice);
    }
  }
}
