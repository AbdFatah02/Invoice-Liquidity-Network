import { describe, expect, it, vi } from 'vitest';

import {
  MAX_FRAUD_WINDOW_MS,
  RAPID_SUCCESSION_WINDOW_MS,
  assessOracleRequest,
  normalizeAmountToNumber,
  normalizeTimestampToMs,
} from './verifier';
import { OracleVerifier } from './verifier';
import { createEphemeralOracleCache } from './cache';
import {
  DAY_MS,
  TEST_PAYER,
  healthyHistory,
  makeExternal,
  makeHistoryEntry,
  makeReputation,
} from './testFixtures';
import type { OracleVerificationRequest } from './types';

/**
 * Boundary conditions the fraud window and normalisation helpers turn on, and
 * the branches the happy-path suites do not reach.
 */

const NOW = Date.now();
const request: OracleVerificationRequest = {
  payer: TEST_PAYER,
  amount: '10000000',
  invoiceId: '42',
};

function assess(
  history: ReturnType<typeof healthyHistory>,
  overrides: Partial<Parameters<typeof assessOracleRequest>[0]> = {}
) {
  return assessOracleRequest({
    request,
    reputation: makeReputation(NOW, { score: 90 }),
    history,
    nowMs: NOW,
    maxOracleAgeMs: 0,
    ...overrides,
  });
}

describe('normalizeAmountToNumber', () => {
  it.each([
    ['10000000', 10_000_000],
    [10_000_000, 10_000_000],
    [10_000_000n, 10_000_000],
    ['0', 0],
  ])('normalizes %p', (input, expected) => {
    expect(normalizeAmountToNumber(input as string | number | bigint)).toBe(expected);
  });

  it('falls back to 0 for values that are neither bigint-parseable nor finite', () => {
    expect(normalizeAmountToNumber('abc')).toBe(0);
  });

  it('recovers a finite number from a decimal string BigInt rejects', () => {
    expect(normalizeAmountToNumber('12.5')).toBe(12.5);
  });

  it('saturates at MAX_SAFE_INTEGER when a bigint overflows Number', () => {
    // 10n ** 40n still converts to a finite 1e40; only a value past
    // Number.MAX_VALUE becomes Infinity and takes the saturation branch.
    expect(normalizeAmountToNumber(10n ** 400n)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('normalizeTimestampToMs', () => {
  it.each([
    [null, 0],
    [undefined, 0],
    [0, 0],
    [-5, 0],
    ['not-a-number', 0],
  ])('maps %p to 0', (input, expected) => {
    expect(normalizeTimestampToMs(input as number | string | null | undefined)).toBe(expected);
  });

  it('scales seconds to milliseconds', () => {
    expect(normalizeTimestampToMs(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it('leaves millisecond values alone', () => {
    expect(normalizeTimestampToMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('accepts numeric strings', () => {
    expect(normalizeTimestampToMs('1700000000')).toBe(1_700_000_000_000);
  });
});

describe('fraud window boundaries', () => {
  it('ignores activity just outside MAX_FRAUD_WINDOW_MS', () => {
    // Four identical amounts would trip the similar-amount heuristic, but all
    // of them sit one day past the window.
    // makeHistoryEntry sets updated_at one day after created_at, so the offset
    // has to clear the window by more than a day for the entry to fall outside.
    const stale = Array.from({ length: 4 }, (_, i) =>
      makeHistoryEntry(NOW, { id: i, agoMs: MAX_FRAUD_WINDOW_MS + 5 * DAY_MS, amount: '10000000' })
    );

    expect(assess(stale).response.fraudSignals).toEqual([]);
  });

  it('flags identical amounts just inside MAX_FRAUD_WINDOW_MS', () => {
    const fresh = Array.from({ length: 5 }, (_, i) =>
      makeHistoryEntry(NOW, {
        id: i,
        agoMs: MAX_FRAUD_WINDOW_MS - DAY_MS,
        amount: '10000000',
        // Spread creation so only the similar-amount rule fires.
        created_at: NOW - MAX_FRAUD_WINDOW_MS + i * 5 * DAY_MS,
        updated_at: NOW - MAX_FRAUD_WINDOW_MS + DAY_MS,
      })
    );

    expect(assess(fresh).response.fraudSignals).toContain(
      'Multiple recent invoices with similar amounts from the same payer'
    );
  });

  it('needs three invoices inside RAPID_SUCCESSION_WINDOW_MS, not two', () => {
    const two = Array.from({ length: 2 }, (_, i) =>
      makeHistoryEntry(NOW, {
        id: i,
        agoMs: DAY_MS,
        amount: String(3_000_000 + i * 2_000_000),
        created_at: NOW - i * (RAPID_SUCCESSION_WINDOW_MS / 4),
        updated_at: NOW - DAY_MS,
      })
    );

    expect(assess(two).response.fraudSignals).not.toContain(
      'Rapid succession of invoices detected for the same payer'
    );
  });

  it('flags three invoices inside the rapid-succession window', () => {
    const three = Array.from({ length: 3 }, (_, i) =>
      makeHistoryEntry(NOW, {
        id: i,
        amount: String(3_000_000 + i * 4_000_000),
        created_at: NOW - i * (RAPID_SUCCESSION_WINDOW_MS / 4),
        updated_at: NOW - 1_000,
      })
    );

    expect(assess(three).response.fraudSignals).toContain(
      'Rapid succession of invoices detected for the same payer'
    );
  });

  it('flags two or more recent defaults', () => {
    const defaults = Array.from({ length: 2 }, (_, i) =>
      makeHistoryEntry(NOW, {
        id: i,
        status: 'Defaulted',
        amount: String(2_000_000 + i * 5_000_000),
        created_at: NOW - (i + 3) * 5 * DAY_MS,
        updated_at: NOW - (i + 1) * DAY_MS,
      })
    );

    expect(assess(defaults).response.fraudSignals).toContain(
      'Recent default concentration suggests elevated fraud risk'
    );
  });

  it('flags four invoices sharing an updated_at ledger window', () => {
    const sameLedger = Array.from({ length: 4 }, (_, i) =>
      makeHistoryEntry(NOW, {
        id: i,
        amount: String(2_000_000 + i * 6_000_000),
        created_at: NOW - (i + 2) * 6 * DAY_MS,
        updated_at: NOW - DAY_MS,
      })
    );

    expect(assess(sameLedger).response.fraudSignals).toContain(
      'Repeated invoice updates clustered in the same ledger window'
    );
  });

  it('ignores zero-amount history when matching similar amounts', () => {
    const zeroes = Array.from({ length: 4 }, (_, i) =>
      makeHistoryEntry(NOW, { id: i, amount: '0', agoMs: (i + 2) * 4 * DAY_MS })
    );

    expect(assess(zeroes).response.fraudSignals).not.toContain(
      'Multiple recent invoices with similar amounts from the same payer'
    );
  });

  it('ignores a zero request amount when matching similar amounts', () => {
    const result = assessOracleRequest({
      request: { ...request, amount: '0' },
      reputation: makeReputation(NOW, { score: 90 }),
      history: Array.from({ length: 4 }, (_, i) =>
        makeHistoryEntry(NOW, { id: i, amount: '10000000', agoMs: (i + 2) * 4 * DAY_MS })
      ),
      nowMs: NOW,
      maxOracleAgeMs: 0,
    });

    expect(result.response.fraudSignals).not.toContain(
      'Multiple recent invoices with similar amounts from the same payer'
    );
  });
});

describe('assessment edge cases', () => {
  it('handles empty history and says so in the evidence', () => {
    const { response } = assess([]);

    expect(response.historicalSuccessRate).toBe(0);
    expect(response.historicalDefaultRate).toBe(0);
    expect(response.averageHistoricalAmount).toBe('0');
    // No historical average means the deviation is reported as the 100% cap.
    expect(response.amountDeviation).toBe(100);
    expect(response.evidence.join(' ')).toMatch(/No payer history/);
  });

  it('treats a non-positive maxOracleAgeMs as "freshness not enforced"', () => {
    const ancient = healthyHistory(NOW - 400 * DAY_MS);
    const { response } = assessOracleRequest({
      request,
      reputation: makeReputation(NOW - 400 * DAY_MS, { score: 90 }),
      history: ancient,
      nowMs: NOW,
      maxOracleAgeMs: 0,
    });

    expect(response.composition.outcome).not.toBe('rejected-stale-data');
  });

  it('rejects on staleness once a maximum age is enforced', () => {
    const ancient = healthyHistory(NOW - 400 * DAY_MS);
    const { response } = assessOracleRequest({
      request,
      reputation: makeReputation(NOW - 400 * DAY_MS, { score: 90 }),
      history: ancient,
      nowMs: NOW,
      maxOracleAgeMs: 1_000,
    });

    expect(response.composition.outcome).toBe('rejected-stale-data');
    expect(response.isVerified).toBe(false);
  });

  it('falls back to nowMs when no source timestamp can be derived', () => {
    const undated = [makeHistoryEntry(NOW, { created_at: 0, updated_at: 0, funded_at: null })];
    const { sourceTimestampMs, response } = assessOracleRequest({
      request,
      reputation: makeReputation(NOW, { lastActivity: 0 }),
      history: undated,
      nowMs: NOW,
      maxOracleAgeMs: 1_000,
    });

    expect(sourceTimestampMs).toBe(NOW);
    expect(response.dataAgeMs).toBe(0);
  });

  it('generates a request id when the caller does not supply one', () => {
    const { response } = assess([]);
    expect(response.requestId).toBe(`${TEST_PAYER}:42:${NOW}`);
  });

  it('preserves a caller-supplied request id', () => {
    const { response } = assessOracleRequest({
      request: { ...request, requestId: 'caller-supplied' },
      reputation: makeReputation(NOW),
      history: [],
      nowMs: NOW,
      maxOracleAgeMs: 0,
    });

    expect(response.requestId).toBe('caller-supplied');
  });

  it('clamps a negative reputation score to zero', () => {
    const { response } = assess([], { reputation: makeReputation(NOW, { score: -50 }) });
    expect(response.reputationScore).toBe(0);
  });

  it('threads the external signal into the response composition', () => {
    const { response } = assess(healthyHistory(NOW), {
      external: makeExternal({ status: 'unverified', provider: 'acme' }),
    });

    expect(response.composition.external).toMatchObject({
      status: 'unverified',
      provider: 'acme',
    });
  });
});

describe('OracleVerifier request handling', () => {
  function verifier(overrides: Record<string, unknown> = {}) {
    return new OracleVerifier({
      cache: createEphemeralOracleCache(),
      now: () => NOW,
      maxOracleAgeMs: 0,
      historyProvider: async () => healthyHistory(NOW),
      reputationProvider: async () => makeReputation(NOW, { score: 90 }),
      ...overrides,
    });
  }

  it('trims whitespace and normalizes numeric fields before keying the cache', async () => {
    const v = verifier();

    const first = await v.verify({ ...request, payer: `  ${TEST_PAYER}  ` });
    const second = await v.verify({ ...request, amount: 10_000_000, invoiceId: 42 });

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
  });

  it('coalesces concurrent identical requests into one computation', async () => {
    let calls = 0;
    const v = verifier({
      historyProvider: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return healthyHistory(NOW);
      },
    });

    const [a, b] = await Promise.all([v.verify(request), v.verify(request)]);

    expect(calls).toBe(1);
    expect(a.isVerified).toBe(b.isVerified);
    expect(b.cacheHit).toBe(true);
  });

  it('overrides the cached requestId when the caller supplies one', async () => {
    const v = verifier();

    await v.verify({ ...request, requestId: 'first' });
    const cached = await v.verify({ ...request, requestId: 'second' });

    expect(cached.cacheHit).toBe(true);
    expect(cached.requestId).toBe('second');
  });

  it('tolerates a failing history provider', async () => {
    const v = verifier({
      historyProvider: async () => {
        throw new Error('indexer unreachable');
      },
    });

    const response = await v.verify(request);
    expect(response.evidence.join(' ')).toMatch(/No payer history/);
  });

  it('tolerates a failing reputation provider', async () => {
    const v = verifier({
      reputationProvider: async () => {
        throw new Error('rpc unreachable');
      },
    });

    expect((await v.verify(request)).reputationScore).toBe(0);
  });

  it('reports an unreachable external provider as unknown, not unverified', async () => {
    const v = verifier({
      externalProvider: async () => {
        throw new Error('kyb timeout');
      },
    });

    const response = await v.verify(request);

    expect(response.composition.external.status).toBe('unknown');
    expect(response.composition.external.provider).toBe('unavailable');
  });

  it('works without any cache configured', async () => {
    const v = new OracleVerifier({
      now: () => NOW,
      maxOracleAgeMs: 0,
      historyProvider: async () => healthyHistory(NOW),
      reputationProvider: async () => makeReputation(NOW, { score: 90 }),
    });

    const response = await v.verify(request);
    expect(response.cacheHit).toBe(false);
    expect(await v.invalidatePayer(TEST_PAYER)).toBe(0);
  });

  it('applies the default cache TTL and max age when none are supplied', async () => {
    const v = new OracleVerifier({
      cache: createEphemeralOracleCache(),
      historyProvider: async () => [],
      reputationProvider: async () => makeReputation(Date.now()),
    });

    expect((await v.verify(request)).isVerified).toBe(false);
  });
});
