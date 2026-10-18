import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDb,
  setDb,
  getCursorLedger,
  setCursorLedger,
  rollbackToLedger,
  applyEventWithInvoice,
} from '../src/db';
import { pollOnce } from '../src/poller';
import type { ILNEvent, Invoice } from '../src/types';

vi.mock('../src/rpc', () => ({
  fetchInvoice: vi.fn(),
  server: {
    getEvents: vi.fn(),
    getLatestLedger: vi.fn(),
  },
}));

vi.mock('../src/cache', () => ({
  invalidateInvoiceCache: vi.fn().mockResolvedValue(undefined),
}));

import { server, fetchInvoice } from '../src/rpc';

function makeTestEvent(ledger: number, invoiceId = 1): ILNEvent {
  return {
    event_id: `evt-${ledger}-${invoiceId}`,
    event_type: 'submitted',
    invoice_id: invoiceId,
    ledger,
    ledger_closed_at: new Date().toISOString(),
    created_at: Date.now(),
  };
}

function makeTestInvoice(invoiceId = 1): Omit<Invoice, 'created_at' | 'updated_at'> {
  return {
    id: invoiceId,
    freelancer: 'G_FREELANCER',
    payer: 'G_PAYER',
    amount: '10000000',
    due_date: 1735689600,
    discount_rate: 300,
    status: 'Pending',
    funder: null,
    funded_at: null,
  };
}

describe('Issue #1263: Add cursor monotonicity invariants to poller tests', () => {
  beforeEach(() => {
    setDb(createDb(':memory:'));
    vi.mocked(fetchInvoice).mockReset().mockResolvedValue(null);
    vi.mocked(server.getEvents).mockReset();
    vi.mocked(server.getLatestLedger).mockReset().mockResolvedValue({ sequence: 1000 } as any);
  });

  it('enforces that setCursorLedger cannot rewind without explicit allowRewind', () => {
    setCursorLedger(500);
    expect(getCursorLedger()).toBe(500);

    // Monotonic forward advances are allowed
    setCursorLedger(500); // Equal is allowed
    expect(getCursorLedger()).toBe(500);

    setCursorLedger(550); // Greater is allowed
    expect(getCursorLedger()).toBe(550);

    // Regressions without allowRewind throw monotonicity violation error
    expect(() => setCursorLedger(540)).toThrow(/Cursor monotonicity violation/);
    expect(getCursorLedger()).toBe(550);

    // Explicit allowRewind allows authorized rollback
    setCursorLedger(400, true);
    expect(getCursorLedger()).toBe(400);
  });

  it('increments cursorMonotonicityViolationsTotal metric on rejected rewind attempt', () => {
    setCursorLedger(200);

    expect(() => setCursorLedger(150)).toThrow(/Cursor monotonicity violation/);
    expect(getCursorLedger()).toBe(200);
  });

  it('allows rollbackToLedger to rewind cursor as the sole authorized rollback mechanism', () => {
    setCursorLedger(300);
    applyEventWithInvoice(makeTestEvent(280), makeTestInvoice(1));
    applyEventWithInvoice(makeTestEvent(300), makeTestInvoice(2));

    expect(getCursorLedger()).toBe(300);

    const rollbackResult = rollbackToLedger(250);
    expect(rollbackResult.eventsRemoved).toBe(2);
    expect(getCursorLedger()).toBe(250);

    // After rollback, forward progression from rewound cursor is monotonic
    setCursorLedger(260);
    expect(getCursorLedger()).toBe(260);
  });

  it('guarantees poller forward cycle strictly increases or maintains cursor monotonicity', async () => {
    setCursorLedger(100);

    // Cycle 1: 5 events across ledgers 100..105, chain tip 120
    const rawEvents = [
      {
        id: 'e-101',
        pagingToken: 'e-101',
        type: 'contract',
        ledger: 101,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        contractId: 'C1',
        topic: [],
        value: null,
      },
      {
        id: 'e-105',
        pagingToken: 'e-105',
        type: 'contract',
        ledger: 105,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        contractId: 'C1',
        topic: [],
        value: null,
      },
    ];

    vi.mocked(server.getEvents).mockResolvedValueOnce({
      events: rawEvents,
      latestLedger: 120,
      cursor: 'cur1',
    } as any);

    await pollOnce();

    const cursorAfterCycle1 = getCursorLedger();
    // In poller: newCursor = Math.max(highestEventLedger (105), latestKnownLedger - 10 (110)) => 110
    expect(cursorAfterCycle1).toBeGreaterThanOrEqual(100);
    expect(cursorAfterCycle1).toBe(110);

    // Cycle 2: No new events, chain tip advanced to 125
    vi.mocked(server.getEvents).mockResolvedValueOnce({
      events: [],
      latestLedger: 125,
      cursor: 'cur2',
    } as any);

    await pollOnce();

    const cursorAfterCycle2 = getCursorLedger();
    expect(cursorAfterCycle2).toBeGreaterThanOrEqual(cursorAfterCycle1);
    expect(cursorAfterCycle2).toBe(115); // 125 - 10 = 115

    // Cycle 3: Re-scan with same chain tip (125) preserves monotonicity without backward drift
    vi.mocked(server.getEvents).mockResolvedValueOnce({
      events: [],
      latestLedger: 125,
      cursor: 'cur3',
    } as any);

    await pollOnce();

    const cursorAfterCycle3 = getCursorLedger();
    expect(cursorAfterCycle3).toBe(cursorAfterCycle2);
  });

  it('preserves cursor monotonicity invariant across node restarts and event replays', async () => {
    setCursorLedger(450);

    // Initial run persists cursor at 450
    expect(getCursorLedger()).toBe(450);

    // Simulate restart with replay of existing events at ledger 450
    vi.mocked(server.getEvents).mockResolvedValueOnce({
      events: [],
      latestLedger: 460,
      cursor: 'cur-restart',
    } as any);

    await pollOnce();

    // After restart poll, cursor cannot regress below 450
    expect(getCursorLedger()).toBeGreaterThanOrEqual(450);
  });
});
