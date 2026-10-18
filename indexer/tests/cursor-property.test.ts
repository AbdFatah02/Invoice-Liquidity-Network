import { beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  createDb,
  setDb,
  getDb,
  getCursorLedger,
  setCursorLedger,
  rollbackToLedger,
  applyEventWithInvoice,
  recordForkDecision,
  quarantineForkDecision,
  isReorgQuarantined,
  getPendingForkDecision,
  getQuarantinedReorgs,
} from '../src/db';
import { MAX_REORG_RECOVERY_ATTEMPTS } from '../src/poller';
import type { ILNEvent, Invoice, InvoiceStatus } from '../src/types';

function makeEvent(
  id: string,
  eventType: ILNEvent['event_type'],
  invoiceId: number,
  ledger: number
): ILNEvent {
  return {
    event_id: id,
    event_type: eventType,
    invoice_id: invoiceId,
    ledger,
    ledger_closed_at: '2026-01-01T00:00:00Z',
    created_at: Date.now(),
  };
}

function makeInvoice(
  id: number,
  status: InvoiceStatus,
  funder: string | null = null
): Omit<Invoice, 'created_at' | 'updated_at'> {
  return {
    id,
    freelancer: `G_FREELANCER_${id}`,
    payer: `G_PAYER_${id}`,
    amount: `${id * 1000000}`,
    due_date: 1735689600,
    discount_rate: 250,
    status,
    funder,
    funded_at: funder ? 1735689000 : null,
  };
}

describe('Issue #1264: Property-based cursor and replay testing', () => {
  beforeEach(() => {
    setDb(createDb(':memory:'));
  });

  it('Property 1: Cursor monotonicity holds for any sequence of forward ledger increments', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 1, max: 20 }),
        (initialLedger, stepIncrements, regressionDelta) => {
          setDb(createDb(':memory:'));
          setCursorLedger(initialLedger);

          let current = initialLedger;
          for (const inc of stepIncrements) {
            const next = current + inc;
            setCursorLedger(next);
            expect(getCursorLedger()).toBe(next);
            expect(getCursorLedger()).toBeGreaterThanOrEqual(current);
            current = next;
          }

          // Invariant: any attempt to decrement cursor without allowRewind MUST throw
          if (current > regressionDelta) {
            const invalidLower = current - regressionDelta;
            expect(() => setCursorLedger(invalidLower)).toThrow(
              /Cursor monotonicity violation/
            );
            // Cursor remains uncorrupted at current
            expect(getCursorLedger()).toBe(current);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 2: Replay idempotency holds across arbitrary duplicates and repeated replays of event streams', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            invoiceId: fc.integer({ min: 1, max: 10 }),
            amount: fc.integer({ min: 1000, max: 100000 }),
          }),
          { minLength: 1, maxLength: 15 }
        ),
        (invoiceConfigs) => {
          setDb(createDb(':memory:'));

          // Deduplicate invoiceConfigs by invoiceId to keep clean causal streams
          const uniqueConfigs = Array.from(
            new Map(invoiceConfigs.map((c) => [c.invoiceId, c])).values()
          );

          // Build canonical sequential events for generated invoices
          const canonicalEvents: Array<{ event: ILNEvent; invoice: Omit<Invoice, 'created_at' | 'updated_at'> }> = [];
          let ledger = 100;

          for (const cfg of uniqueConfigs) {
            ledger += 2;
            const submittedEvt = makeEvent(`sub-${cfg.invoiceId}`, 'submitted', cfg.invoiceId, ledger);
            const submittedInv = makeInvoice(cfg.invoiceId, 'Pending', null);
            canonicalEvents.push({ event: submittedEvt, invoice: submittedInv });

            ledger += 1;
            const fundedEvt = makeEvent(`fund-${cfg.invoiceId}`, 'funded', cfg.invoiceId, ledger);
            const fundedInv = makeInvoice(cfg.invoiceId, 'Funded', `G_FUNDER_${cfg.invoiceId}`);
            canonicalEvents.push({ event: fundedEvt, invoice: fundedInv });
          }

          // Initial sequential execution
          for (const item of canonicalEvents) {
            applyEventWithInvoice(item.event, item.invoice);
          }

          const db = getDb();
          const snapshotInvoices = db.prepare('SELECT id, status, funder FROM invoices ORDER BY id ASC').all();
          const snapshotEvents = db.prepare('SELECT event_id, event_type, invoice_id, ledger FROM events ORDER BY event_id ASC').all();

          // Replay execution: duplicate every event in-place and repeat full sequence
          const duplicatedStream = canonicalEvents.flatMap((item) => [item, item, item]);
          const fullReplay = [...duplicatedStream, ...canonicalEvents];

          for (const item of fullReplay) {
            applyEventWithInvoice(item.event, item.invoice);
          }

          const replayedInvoices = db.prepare('SELECT id, status, funder FROM invoices ORDER BY id ASC').all();
          const replayedEvents = db.prepare('SELECT event_id, event_type, invoice_id, ledger FROM events ORDER BY event_id ASC').all();

          // Invariant: Final database state is byte-for-byte identical after repeated arbitrary replays
          expect(replayedInvoices).toEqual(snapshotInvoices);
          expect(replayedEvents).toEqual(snapshotEvents);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 3: Reorg rollback correctly restores canonical state and purges abandoned events across arbitrary rollback depths', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 300 }),
        fc.integer({ min: 5, max: 50 }),
        fc.integer({ min: 1, max: 20 }),
        (baseLedger, forkLength, rollbackDepth) => {
          setDb(createDb(':memory:'));
          setCursorLedger(baseLedger);

          // Canonical baseline invoice created before fork
          const baseInvoice = makeInvoice(1, 'Pending', null);
          const baseEvent = makeEvent('base-evt-1', 'submitted', 1, baseLedger - 10);
          applyEventWithInvoice(baseEvent, baseInvoice);

          // Events created during the fork
          const forkInvoice = makeInvoice(2, 'Pending', null);
          const forkEvent1 = makeEvent('fork-evt-2', 'submitted', 2, baseLedger + 5);
          applyEventWithInvoice(forkEvent1, forkInvoice);

          const tipLedger = baseLedger + forkLength;
          setCursorLedger(tipLedger);

          // Target rollback ledger
          const targetLedger = Math.max(baseLedger - 10, tipLedger - rollbackDepth);
          rollbackToLedger(targetLedger);

          const db = getDb();
          const remainingEventsAboveTarget = db
            .prepare('SELECT COUNT(*) as cnt FROM events WHERE ledger > ?')
            .get(targetLedger) as { cnt: number };

          // Invariant 1: Cursor is rolled back to target
          expect(getCursorLedger()).toBe(targetLedger);

          // Invariant 2: No events remain above target ledger
          expect(remainingEventsAboveTarget.cnt).toBe(0);

          // Invariant 3: If target < forkEvent1.ledger, the fork invoice must be removed
          if (targetLedger < baseLedger + 5) {
            const forkInvInDb = db.prepare('SELECT id FROM invoices WHERE id = 2').get();
            expect(forkInvInDb).toBeUndefined();
          }

          // Invariant 4: Events at or below target remain intact
          const baseEventInDb = db.prepare('SELECT event_id FROM events WHERE event_id = ?').get('base-evt-1');
          expect(baseEventInDb).toBeDefined();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 4: Incomplete reorg recoveries correctly transition to quarantine when attempts reach threshold', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        (crashCount) => {
          setDb(createDb(':memory:'));
          const decisionId = recordForkDecision(500, 450, 450);

          const db = getDb();
          db.prepare('UPDATE fork_decisions SET recovery_attempts = ? WHERE id = ?').run(
            crashCount,
            decisionId
          );

          if (crashCount >= MAX_REORG_RECOVERY_ATTEMPTS) {
            quarantineForkDecision(
              decisionId,
              `Exceeded maximum recovery attempts (${crashCount})`,
              'Property-based simulation of crash exhaustion'
            );

            // Invariant: Marked quarantined, recorded in quarantine table, no longer pending
            expect(isReorgQuarantined(decisionId)).toBe(true);
            expect(getPendingForkDecision()).toBeUndefined();

            const quarantinedList = getQuarantinedReorgs();
            expect(quarantinedList.some((q) => q.decision_id === decisionId)).toBe(true);
          } else {
            // Still in progress
            expect(isReorgQuarantined(decisionId)).toBe(false);
            const pending = getPendingForkDecision();
            expect(pending?.id).toBe(decisionId);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
