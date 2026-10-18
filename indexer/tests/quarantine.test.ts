import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDb,
  setDb,
  getDb,
  setCursorLedger,
  recordForkDecision,
  getPendingForkDecision,
  getForkDecisions,
  quarantineForkDecision,
  getQuarantinedReorgs,
  isReorgQuarantined,
  incrementForkDecisionAttempts,
} from '../src/db';
import { pollOnce, MAX_REORG_RECOVERY_ATTEMPTS } from '../src/poller';

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

describe('Issue #1262: Detect and quarantine incomplete reorg recovery', () => {
  beforeEach(() => {
    setDb(createDb(':memory:'));
    vi.mocked(fetchInvoice).mockReset().mockResolvedValue(null);
    vi.mocked(server.getEvents).mockReset();
    vi.mocked(server.getLatestLedger).mockReset().mockResolvedValue({ sequence: 500 } as any);
  });

  it('records quarantine record and marks fork decision quarantined', () => {
    setCursorLedger(300);
    const decisionId = recordForkDecision(300, 250, 250);

    expect(isReorgQuarantined(decisionId)).toBe(false);

    quarantineForkDecision(
      decisionId,
      'Exceeded max recovery attempts',
      'Synthetic test failure'
    );

    expect(isReorgQuarantined(decisionId)).toBe(true);

    const quarantinedList = getQuarantinedReorgs();
    expect(quarantinedList).toHaveLength(1);
    expect(quarantinedList[0]).toMatchObject({
      decision_id: decisionId,
      from_ledger: 300,
      to_ledger: 250,
      reason: 'Exceeded max recovery attempts',
      error_details: 'Synthetic test failure',
    });

    const decisions = getForkDecisions();
    const target = decisions.find((d) => d.id === decisionId);
    expect(target?.status).toBe('quarantined');
    expect(target?.resolved_at).not.toBeNull();
  });

  it('tracks recovery attempts on in-progress fork decisions', () => {
    const decisionId = recordForkDecision(400, 350, 350);

    expect(incrementForkDecisionAttempts(decisionId)).toBe(1);
    expect(incrementForkDecisionAttempts(decisionId)).toBe(2);
    expect(incrementForkDecisionAttempts(decisionId)).toBe(3);

    const db = getDb();
    const row = db
      .prepare('SELECT recovery_attempts FROM fork_decisions WHERE id = ?')
      .get(decisionId) as { recovery_attempts: number };
    expect(row.recovery_attempts).toBe(3);
  });

  it('quarantines incomplete reorg recovery when attempts exceed MAX_REORG_RECOVERY_ATTEMPTS', async () => {
    setCursorLedger(500);

    // Create a pending fork decision that has already failed 3 times
    const decisionId = recordForkDecision(500, 450, 450);
    const db = getDb();
    db.prepare('UPDATE fork_decisions SET recovery_attempts = ? WHERE id = ?').run(
      MAX_REORG_RECOVERY_ATTEMPTS,
      decisionId
    );

    // Mock RPC events for forward poll
    vi.mocked(server.getEvents).mockResolvedValueOnce({
      events: [],
      latestLedger: 510,
      cursor: 'next',
    } as any);

    // Running pollOnce must NOT crash in an infinite loop; it must quarantine and safely proceed
    await pollOnce();

    expect(isReorgQuarantined(decisionId)).toBe(true);
    expect(getPendingForkDecision()).toBeUndefined();

    const quarantined = getQuarantinedReorgs();
    expect(quarantined.some((q) => q.decision_id === decisionId)).toBe(true);
  });

  it('quarantines reorg when rollback throws persistent error during recovery', async () => {
    setCursorLedger(500);
    const decisionId = recordForkDecision(500, 450, 450);
    const db = getDb();
    // Simulate attempt 2 (so this next attempt is attempt 3 = MAX_REORG_RECOVERY_ATTEMPTS)
    db.prepare('UPDATE fork_decisions SET recovery_attempts = ? WHERE id = ?').run(
      MAX_REORG_RECOVERY_ATTEMPTS - 1,
      decisionId
    );

    // Inject an error by corrupting the events table schema or triggering constraint error during rollback
    db.prepare('DROP TABLE events').run();

    await expect(pollOnce()).rejects.toThrow();

    // Since attempts reached MAX_REORG_RECOVERY_ATTEMPTS, it must be quarantined
    expect(isReorgQuarantined(decisionId)).toBe(true);
    const quarantined = getQuarantinedReorgs();
    expect(quarantined[0].reason).toContain('Rollback failure during recovery');
  });

  it('does not quarantine healthy fork decisions that complete cleanly on first attempt', async () => {
    setCursorLedger(500);
    const decisionId = recordForkDecision(500, 480, 480);

    vi.mocked(server.getEvents).mockResolvedValueOnce({
      events: [],
      latestLedger: 490,
      cursor: 'next',
    } as any);

    await pollOnce();

    expect(isReorgQuarantined(decisionId)).toBe(false);
    expect(getPendingForkDecision()).toBeUndefined();
    const decisions = getForkDecisions();
    const completed = decisions.find((d) => d.id === decisionId);
    expect(completed?.status).toBe('completed');
  });
});
