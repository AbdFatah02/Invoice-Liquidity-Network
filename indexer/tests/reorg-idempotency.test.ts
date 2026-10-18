import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDb,
  getCursorLedger,
  setCursorLedger,
  getInvoiceById,
  hasEvent,
  getEvents,
  setDb,
  getPendingForkDecision,
  getForkDecisions,
  recordForkDecision,
  rollbackToLedger,
} from '../src/db';
import { pollOnce } from '../src/poller';
import { processEvent } from '../src/processor';
import * as cache from '../src/cache';

vi.mock('../src/rpc', () => ({
  fetchInvoice: vi.fn(),
  server: {
    getEvents: vi.fn(),
    getLatestLedger: vi.fn(),
  },
}));

vi.mock('../src/cache', () => ({
  invalidateInvoiceCache: vi.fn().mockResolvedValue(undefined),
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDelete: vi.fn().mockResolvedValue(undefined),
  cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
}));

import { fetchInvoice, server } from '../src/rpc';

const FREELANCER = 'GBSOVFQ4MFEHKV37QXGFKRM66CKFWWU47CRXGAWTP7DQIRMUQK56OPR';
const PAYER = 'GC5GY2JTEOIVJDNFPEZQNMGZBTZJ5LFTJFWL5UB3LV4BGVVQAHC3D4S';
const FUNDER = 'GDNA2SBLDTGZICXNPQ5SIQFYBDP7WGLXSLKQFQYQRXLWSMQWMFWVHP2';

function makeEvent(
  type: string,
  invoiceId: number,
  ledger = 100,
  id = `evt-${invoiceId}-${type}-${ledger}`
) {
  return {
    id,
    pagingToken: id,
    type: 'contract',
    ledger,
    ledgerClosedAt: '2024-01-01T00:00:00Z',
    contractId: 'CTEST',
    topic: [xdr.ScVal.scvSymbol(type)],
    value: nativeToScVal(BigInt(invoiceId), { type: 'u64' }),
    inSuccessfulContractCall: true,
  } as any;
}

function mockInvoice(id: number, status = 'Pending', funder: string | null = null) {
  return {
    id,
    freelancer: FREELANCER,
    payer: PAYER,
    amount: '100000000',
    due_date: 9999999999,
    discount_rate: 300,
    status: status as any,
    funder,
    funded_at: funder ? 1700000000 : null,
  };
}

beforeEach(() => {
  setDb(createDb(':memory:'));
  vi.mocked(fetchInvoice).mockReset();
  vi.mocked(server.getEvents).mockReset();
  vi.mocked(server.getLatestLedger).mockReset();
  vi.mocked(cache.invalidateInvoiceCache).mockClear();
});

describe('Issue #1260: Make event application idempotent across replays', () => {
  it('applies events idempotently on successive replays without state duplication or corruption', async () => {
    vi.mocked(fetchInvoice).mockResolvedValue(mockInvoice(101, 'Pending'));
    const event = makeEvent('submitted', 101, 100);

    // Initial process
    await processEvent(event);
    expect(hasEvent(event.id)).toBe(true);
    expect(getInvoiceById(101)?.status).toBe('Pending');
    expect(vi.mocked(fetchInvoice)).toHaveBeenCalledTimes(1);

    // Immediate replay (e.g. repeated block scan or duplicate polling window)
    await processEvent(event);
    expect(vi.mocked(fetchInvoice)).toHaveBeenCalledTimes(1); // skipped duplicate fetch
    expect(getInvoiceById(101)?.status).toBe('Pending');
  });

  it('does not commit event if invoice fetch fails, enabling clean retry on replay', async () => {
    vi.mocked(fetchInvoice).mockRejectedValue(new Error('Transient RPC failure'));
    const event = makeEvent('submitted', 102, 105);

    // Initial attempt fails after retries
    await expect(processEvent(event)).rejects.toThrow('Transient RPC failure');
    expect(hasEvent(event.id)).toBe(false);
    expect(getInvoiceById(102)).toBeUndefined();

    // Replay after RPC recovery
    vi.mocked(fetchInvoice).mockReset().mockResolvedValue(mockInvoice(102, 'Pending'));
    await processEvent(event);

    expect(hasEvent(event.id)).toBe(true);
    expect(getInvoiceById(102)?.status).toBe('Pending');
  });
});

describe('Issue #1259: Reconcile cursor state after chain tip rewinds', () => {
  it('reconciles cursor state to rewound chain tip and re-scans in the same cycle', async () => {
    setCursorLedger(500);

    // Node tip rewinds to 470, then stabilizes to 475
    vi.mocked(server.getEvents)
      .mockResolvedValueOnce({ events: [], latestLedger: 470, cursor: 'behind' } as any)
      .mockResolvedValueOnce({ events: [], latestLedger: 475, cursor: 'stable' } as any);

    await pollOnce();

    expect(getCursorLedger()).toBe(470);
    expect(server.getEvents).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ startLedger: 500 })
    );
    expect(server.getEvents).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ startLedger: 470 })
    );
  });

  it('bounds re-org rollbacks to MAX_REORG_ROLLBACK_LEDGERS', async () => {
    setCursorLedger(1000);

    // Large rewind of 300 ledgers down to 700
    vi.mocked(server.getEvents)
      .mockResolvedValueOnce({ events: [], latestLedger: 700, cursor: 'rewind' } as any)
      .mockResolvedValueOnce({ events: [], latestLedger: 910, cursor: 'stable' } as any);

    await pollOnce();

    // Bounded to 1000 - 100 = 900
    expect(getCursorLedger()).toBe(900);
  });
});

describe('Issue #1258: Persist fork replacement decisions for restart safety', () => {
  it('persists a completed fork decision record during chain reorg', async () => {
    setCursorLedger(200);

    vi.mocked(server.getEvents)
      .mockResolvedValueOnce({ events: [], latestLedger: 180, cursor: 'rewind' } as any)
      .mockResolvedValueOnce({ events: [], latestLedger: 185, cursor: 'stable' } as any);

    await pollOnce();

    const decisions = getForkDecisions();
    expect(decisions.length).toBeGreaterThan(0);
    const latestDecision = decisions[0];
    expect(latestDecision.from_ledger).toBe(200);
    expect(latestDecision.to_ledger).toBe(180);
    expect(latestDecision.tip_ledger).toBe(180);
    expect(latestDecision.status).toBe('completed');
    expect(latestDecision.resolved_at).not.toBeNull();
  });

  it('detects and recovers an in-progress fork decision upon node restart', async () => {
    // Simulate crash where a fork decision was recorded but interrupted
    setCursorLedger(300);
    const decisionId = recordForkDecision(300, 250, 250);
    expect(getPendingForkDecision()?.id).toBe(decisionId);

    // On start of next poll cycle, the pending decision is recovered
    vi.mocked(server.getEvents).mockResolvedValueOnce({
      events: [],
      latestLedger: 260,
      cursor: 'next',
    } as any);

    await pollOnce();

    // Fork decision should now be marked completed
    expect(getPendingForkDecision()).toBeUndefined();
    const decisions = getForkDecisions();
    expect(decisions.find((d) => d.id === decisionId)?.status).toBe('completed');
  });
});

describe('Issue #1257: Implement rollback for removed events', () => {
  it('removes forked events and deletes invoices that only existed on the abandoned fork', async () => {
    setCursorLedger(150);

    // Invoice 201 was submitted at ledger 160 (on forked tip)
    vi.mocked(fetchInvoice).mockResolvedValueOnce(mockInvoice(201, 'Pending'));
    await processEvent(makeEvent('submitted', 201, 160));
    expect(getInvoiceById(201)).toBeDefined();
    expect(hasEvent('evt-201-submitted-160')).toBe(true);

    // Rollback to ledger 150
    const result = rollbackToLedger(150);

    expect(result.eventsRemoved).toBe(1);
    expect(result.invoicesAffected).toBe(1);
    expect(hasEvent('evt-201-submitted-160')).toBe(false);
    expect(getInvoiceById(201)).toBeUndefined(); // deleted because no valid events remain
  });

  it('restores invoice status to canonical pre-fork state when subsequent events are rolled back', async () => {
    setCursorLedger(150);

    // Invoice 202 was submitted at ledger 140 (canonical)
    vi.mocked(fetchInvoice).mockResolvedValueOnce(mockInvoice(202, 'Pending'));
    await processEvent(makeEvent('submitted', 202, 140));

    // Invoice 202 was funded at ledger 160 (on forked tip)
    vi.mocked(fetchInvoice).mockResolvedValueOnce(mockInvoice(202, 'Funded', FUNDER));
    await processEvent(makeEvent('funded', 202, 160));
    expect(getInvoiceById(202)?.status).toBe('Funded');
    expect(getInvoiceById(202)?.funder).toBe(FUNDER);

    // Rollback to ledger 150
    rollbackToLedger(150);

    // Invoice 202 should be rolled back to 'Pending' with funder cleared
    const restored = getInvoiceById(202);
    expect(restored).toBeDefined();
    expect(restored?.status).toBe('Pending');
    expect(restored?.funder).toBeNull();
    expect(restored?.funded_at).toBeNull();
  });

  it('triggers cache invalidation for all affected invoices during poller re-org rollback', async () => {
    setCursorLedger(200);

    // Seed an event at ledger 210
    vi.mocked(fetchInvoice).mockResolvedValueOnce(mockInvoice(301, 'Pending'));
    await processEvent(makeEvent('submitted', 301, 210));
    vi.mocked(cache.invalidateInvoiceCache).mockClear();

    // Trigger re-org via poller to ledger 190
    vi.mocked(server.getEvents)
      .mockResolvedValueOnce({ events: [], latestLedger: 190, cursor: 'behind' } as any)
      .mockResolvedValueOnce({ events: [], latestLedger: 195, cursor: 'stable' } as any);

    await pollOnce();

    expect(cache.invalidateInvoiceCache).toHaveBeenCalledWith(301);
  });
});
