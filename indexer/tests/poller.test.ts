import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, getCursorLedger, setCursorLedger, setDb } from "../src/db";
import { pollOnce } from "../src/poller";
import { processEvent } from "../src/processor";

vi.mock("../src/rpc", () => ({
  fetchInvoice: vi.fn(),
  server: { getEvents: vi.fn() },
}));

import { fetchInvoice, server } from "../src/rpc";

function makeEvent() {
  return {
    id: "reorg-overlap-event",
    pagingToken: "reorg-overlap-event",
    type: "contract",
    ledger: 100,
    ledgerClosedAt: "2024-01-01T00:00:00Z",
    contractId: "CTEST",
    topic: [xdr.ScVal.scvSymbol("submitted")],
    value: nativeToScVal(1n, { type: "u64" }),
    inSuccessfulContractCall: true,
  } as any;
}

function makeEventAt(ledger: number, id = `evt-${ledger}`) {
  return {
    id,
    pagingToken: id,
    type: "contract",
    ledger,
    ledgerClosedAt: "2024-01-01T00:00:00Z",
    contractId: "CTEST",
    topic: [xdr.ScVal.scvSymbol("submitted")],
    value: nativeToScVal(1n, { type: "u64" }),
    inSuccessfulContractCall: true,
  } as any;
}

describe("pollOnce ledger overlap", () => {
  beforeEach(() => {
    setDb(createDb(":memory:"));
    setCursorLedger(100);
    vi.mocked(fetchInvoice).mockReset().mockResolvedValue(null);
    vi.mocked(server.getEvents).mockReset();
  });

  it("rescans the saved cursor ledger and ignores an already-processed boundary event", async () => {
    const event = makeEvent();
    await processEvent(event);
    vi.mocked(fetchInvoice).mockClear();
    vi.mocked(server.getEvents).mockResolvedValue({
      events: [event],
      latestLedger: 101,
      cursor: "next-page",
    } as any);

    await pollOnce();

    expect(server.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 100 }),
    );
    expect(fetchInvoice).not.toHaveBeenCalled();
    expect(getCursorLedger()).toBe(100);
  });
});

describe("pollOnce re-org recovery (#1256)", () => {
  beforeEach(() => {
    setDb(createDb(":memory:"));
    vi.mocked(fetchInvoice).mockReset().mockResolvedValue(null);
    vi.mocked(server.getEvents).mockReset();
  });

  it("rolls the persisted cursor back and re-scans from the new tip when a re-org is detected", async () => {
    setCursorLedger(500);
    vi.mocked(server.getEvents)
      .mockResolvedValueOnce({ events: [], latestLedger: 480, cursor: "behind" } as any)
      .mockResolvedValueOnce({ events: [], latestLedger: 485, cursor: "ahead" } as any);

    await pollOnce();

    // The cursor was rolled back to the re-orged tip, then re-scanned from there.
    expect(getCursorLedger()).toBe(480);
    expect(server.getEvents).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ startLedger: 500 }),
    );
    expect(server.getEvents).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ startLedger: 480 }),
    );
  });

  it("surfaces a persistent re-org instead of hiding it in an unbounded retry loop", async () => {
    setCursorLedger(500);
    vi.mocked(server.getEvents)
      .mockResolvedValueOnce({ events: [], latestLedger: 400, cursor: "a" } as any)
      .mockResolvedValueOnce({ events: [], latestLedger: 300, cursor: "b" } as any)
      .mockResolvedValueOnce({ events: [], latestLedger: 200, cursor: "c" } as any)
      .mockResolvedValueOnce({ events: [], latestLedger: 100, cursor: "d" } as any);

    await expect(pollOnce()).rejects.toThrow(/reorg did not stabilise/);

    // The cursor is left at the last known-good ledger, never above the tip.
    expect(getCursorLedger()).toBe(200);
  });

  it("processes events at exactly the confirmation depth and skips ones still inside it", async () => {
    setCursorLedger(1000);
    vi.mocked(server.getEvents).mockResolvedValue({
      events: [makeEventAt(1091), makeEventAt(1090), makeEventAt(1080)],
      latestLedger: 1100,
      cursor: "page",
    } as any);

    await pollOnce();

    // 1090 is exactly CONFIRMATION_DEPTH (10) below the tip → processed.
    // 1091 is only 9 below → still unconfirmed → skipped. 1080 → processed.
    expect(fetchInvoice).toHaveBeenCalledTimes(2);
    expect(getCursorLedger()).toBe(1090);
  });

  it("resumes forward progress on the next cycle after a re-org rollback", async () => {
    setCursorLedger(500);
    // Cycle 1: re-org to 480, then a stable tip at 485.
    vi.mocked(server.getEvents)
      .mockResolvedValueOnce({ events: [], latestLedger: 480, cursor: "behind" } as any)
      .mockResolvedValueOnce({ events: [], latestLedger: 485, cursor: "stable" } as any);
    await pollOnce();
    expect(getCursorLedger()).toBe(480);

    // Cycle 2 (restart): the stored cursor is the rolled-back ledger and the
    // poller keeps advancing against the live tip.
    vi.mocked(server.getEvents).mockReset();
    vi.mocked(server.getEvents).mockResolvedValue({
      events: [],
      latestLedger: 520,
      cursor: "next",
    } as any);
    await pollOnce();
    expect(getCursorLedger()).toBe(510);
  });
});
