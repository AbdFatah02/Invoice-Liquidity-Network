import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { StrKey } from '@stellar/stellar-sdk';

import { createOracleApp, type CreateOracleAppResult } from './index';
import { createEphemeralOracleCache } from './cache';
import { startChaosUpstream, type ChaosUpstream } from './chaosUpstream';
import { TEST_PAYER, healthyHistory, makeReputation } from './testFixtures';
import type {
  IndexerInvoiceHistoryEntry,
  OracleServiceOptions,
  OracleVerificationResponse,
} from './types';

/**
 * Upstream-outage chaos suite (#1058).
 *
 * ── What this adds over the existing resilience tests ────────────────────────
 *
 * `verifier.test.ts` proves that a *throwing provider function* degrades the
 * verdict, and `cacheStaleness.test.ts` proves the TTL policy. Neither touches
 * the network. The code that has to survive an outage — `fetch`, its abort
 * deadline, the response normalisation, the indexer URL, the Soroban RPC client
 * — sat unexercised, which is precisely why "the oracle degrades gracefully"
 * could be claimed without anyone being able to demonstrate it.
 *
 * Every case below drives a real TCP socket against a real listener and imposes
 * the three fault modes the issue names: connection refused, timeouts, 5xx.
 *
 * ── The behaviour under test ─────────────────────────────────────────────────
 *
 * The oracle has two upstream feeds: the indexer (payer history) and Soroban
 * RPC (on-chain reputation). Both must fail *safe*:
 *
 *   - the endpoint stays up and answers 200 with a lower-trust verdict;
 *   - a missing feed never reads as a passed identity check;
 *   - the outage is visible in-band (`Indexer data unavailable` evidence) and in
 *     the outcome metric the `OracleAllVerificationsRejected` alert watches;
 *   - failover through the cache is real but *bounded*, so an outage cannot pin
 *     a clean verdict forever;
 *   - and nothing escapes as an unhandled rejection, which is how a scheduled
 *     chaos run turns into a dead pod in production.
 *
 * @see docs/oracle-service.md — "Graceful Degradation on Indexer Downtime"
 */

const AMOUNT = '11200000';
const INVOICE_ID = '42';
/**
 * Short enough that the timeout cases finish quickly, long enough that a
 * healthy loopback response never trips it by accident.
 */
const REQUEST_TIMEOUT_MS = 1000;
const FRESHNESS_WINDOW_MS = 60_000;

/** A contract id the real SDK will accept, so an RPC failure is a network failure. */
const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));

interface Harness {
  upstream: ChaosUpstream;
  service: CreateOracleAppResult;
  verify(body?: Record<string, unknown>): Promise<request.Response>;
}

async function startHarness(
  options: Partial<OracleServiceOptions> = {},
  history: IndexerInvoiceHistoryEntry[] = healthyHistory(Date.now())
): Promise<Harness> {
  const upstream = await startChaosUpstream(history);
  const service = await createOracleApp({
    indexerBaseUrl: upstream.baseUrl,
    cache: createEphemeralOracleCache(),
    cacheTtlSeconds: 300,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    maxOracleAgeMs: FRESHNESS_WINDOW_MS,
    // These cases are about upstream failure handling, not admission control,
    // and the abuse tracker is process-global per IP: on a fast runner the
    // loopback requests land inside its velocity window and the whole suite
    // starts answering 429. `index.test.ts` covers the limiter itself.
    enableRateLimit: false,
    // The reputation feed is on-chain and out of scope for these cases, so it is
    // pinned to a healthy value. The two RPC tests below deliberately drop this
    // and drive a real `SorobanRpc.Server` at the harness instead.
    reputationProvider: async () => makeReputation(Date.now(), { score: 95 }),
    ...options,
  });

  return {
    upstream,
    service,
    verify: (body = {}) =>
      request(service.app)
        .post('/v1/verify')
        .send({ payer: TEST_PAYER, amount: AMOUNT, invoiceId: INVOICE_ID, ...body }),
  };
}

/** Elapsed milliseconds of `run`, so latency bounds are asserted, not narrated. */
async function elapsedMs<T>(run: () => Promise<T>): Promise<{ value: T; tookMs: number }> {
  const startedAt = Date.now();
  const value = await run();
  return { value, tookMs: Date.now() - startedAt };
}

function evidenceOf(response: OracleVerificationResponse): string {
  return response.evidence.join(' | ');
}

/**
 * The errno a direct connection to `url` fails with, or `undefined` when it
 * connects. Used as a positive control: an outage assertion proves nothing if the
 * endpoint was never actually down.
 */
async function refusalCodeOf(url: string): Promise<string | undefined> {
  try {
    await fetch(url);
    return undefined;
  } catch (error) {
    return (error as { cause?: { code?: string } }).cause?.code;
  }
}

const INDEXER_UNAVAILABLE = /Indexer data unavailable/;

describe('upstream outage chaos (#1058)', { timeout: 30_000 }, () => {
  const started: Harness[] = [];
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The degradation path logs by design; keep it out of the run output and
    // assert on the spy where the log line itself is the contract.
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const harness of started.splice(0)) {
      await harness.upstream.stop();
      await harness.service.close();
    }
    vi.restoreAllMocks();
  });

  async function harness(
    options: Partial<OracleServiceOptions> = {},
    history?: IndexerInvoiceHistoryEntry[]
  ): Promise<Harness> {
    const startedHarness = await startHarness(options, history);
    started.push(startedHarness);
    return startedHarness;
  }

  // ── The feed is genuinely on the wire ──────────────────────────────────────

  it('verifies a payer through the real indexer transport', async () => {
    const { upstream, verify } = await harness();

    const { value: res } = await elapsedMs(() => verify());

    expect(res.status).toBe(200);
    expect(res.body.isVerified).toBe(true);
    expect(res.body.cacheHit).toBe(false);
    expect(res.body.trustScore).toBeGreaterThanOrEqual(70);

    // If this request never reached the listener, every "outage" below would be
    // a test of a code path that was never running.
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]).toEqual({
      method: 'GET',
      path: `/v1/history/${TEST_PAYER}`,
      query: '?role=payer&fields=id%2Camount%2Cdue_date%2Cdiscount_rate%2Cstatus%2Ccreated_at%2Cupdated_at',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("bounds every outage case with its own deadline, not the upstream's", async () => {
    const { upstream, verify } = await harness();
    upstream.setFault('timeout');

    const { value: res, tookMs } = await elapsedMs(() =>
      verify({ forceRefresh: true, invoiceId: '43' })
    );

    expect(res.status).toBe(200);
    // A request that outruns the abort deadline holds a worker open for the
    // upstream's latency instead of the service's own.
    expect(tookMs).toBeLessThan(5_000);
    expect(res.body.isVerified).toBe(false);
    // The operator-visible half of the same fact.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('indexer unavailable'));
  });

  // ── Failover: the cache absorbs a short outage ─────────────────────────────

  it('keeps serving the last clean verdict while the indexer refuses connections', async () => {
    const { upstream, verify } = await harness();

    const warm = await verify();
    expect(warm.body.isVerified).toBe(true);

    // Closing the listener makes the OS refuse the connection: the only way to
    // reproduce ECONNREFUSED without lying about it.
    await upstream.stop();

    const res = await verify();

    expect(res.status).toBe(200);
    expect(res.body.cacheHit).toBe(true);
    expect(res.body.isVerified).toBe(true);
    expect(res.body.trustScore).toBe(warm.body.trustScore);
  });

  it('stops absorbing the outage through the cache once the verdict expires', async () => {
    const { upstream, verify } = await harness({ cacheTtlSeconds: 1 });

    const warm = await verify();
    expect(warm.body.isVerified).toBe(true);

    await upstream.stop();
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const res = await verify();

    // Failover without a deadline would let an outage freeze a clean verdict
    // indefinitely — the exact way a funding decision gets made on old data.
    expect(res.status).toBe(200);
    expect(res.body.cacheHit).toBe(false);
    expect(res.body.isVerified).toBe(false);
  });

  // ── Fail-safe: a cold cache during an outage must not verify anyone ────────

  it('rejects on a cold cache instead of guessing', async () => {
    const { upstream, verify } = await harness();
    await upstream.stop();

    const res = await verify({ forceRefresh: true });
    const body = res.body as OracleVerificationResponse;

    expect(res.status).toBe(200);
    expect(body.isVerified).toBe(false);
    expect(body.composition.outcome).toBe('rejected-low-trust');
    expect(body.reputationScore).toBe(95);
    // The outage has to be distinguishable from a payer who simply has no
    // invoices, or the caller cannot tell "new" from "we could not look".
    expect(evidenceOf(body)).toMatch(INDEXER_UNAVAILABLE);
    expect(evidenceOf(body)).toMatch(/No payer history available from the indexer/);
  });

  it.each(['error-500', 'error-503'] as const)(
    'reads an upstream HTTP %s as an unavailable feed, not a failed payer',
    async (fault) => {
      const { upstream, verify } = await harness();
      upstream.setFault(fault);

      const res = await verify({ forceRefresh: true });
      const body = res.body as OracleVerificationResponse;

      expect(res.status).toBe(200);
      expect(body.isVerified).toBe(false);
      expect(body.fraudSignals).toEqual([]);
      // "We could not check" must never be reported as "we checked and it failed".
      expect(body.composition.external.status).toBe('unknown');
      expect(evidenceOf(body)).toMatch(INDEXER_UNAVAILABLE);
    }
  );

  it('recovers as soon as the feed comes back', async () => {
    const { upstream, verify } = await harness();

    upstream.setFault('reset');
    const during = await verify({ forceRefresh: true, invoiceId: '44' });
    expect(during.body.isVerified).toBe(false);

    upstream.setFault('healthy');
    const after = await verify({ forceRefresh: true, invoiceId: '45' });
    expect(after.body.isVerified).toBe(true);
  });

  it('separates a body that is empty from a body that is broken', async () => {
    const empty = await harness();
    empty.upstream.setFault('garbage');
    const emptyRes = await empty.verify({ forceRefresh: true });
    // The feed answered correctly; the payload just is not a history list. That
    // is a contract breach, not an outage — recorded as "no history".
    expect(evidenceOf(emptyRes.body as OracleVerificationResponse)).toMatch(
      /No payer history available from the indexer/
    );
    expect(evidenceOf(emptyRes.body as OracleVerificationResponse)).not.toMatch(
      INDEXER_UNAVAILABLE
    );
    expect(emptyRes.body.isVerified).toBe(false);

    const broken = await harness();
    broken.upstream.setFault('invalid-json');
    const brokenRes = await broken.verify({ forceRefresh: true });
    expect(evidenceOf(brokenRes.body as OracleVerificationResponse)).toMatch(INDEXER_UNAVAILABLE);
    expect(brokenRes.body.isVerified).toBe(false);
  });

  // ── The staleness circuit breaker ──────────────────────────────────────────

  it('rejects a verdict whose source data is outside the freshness window', async () => {
    const staleSince = Date.now() - 10 * 60_000;
    const { verify } = await harness(
      {
        maxOracleAgeMs: 60_000,
        // Both feeds old: freshness is about the evidence, not the wall clock.
        reputationProvider: async () => makeReputation(staleSince, { score: 95 }),
      },
      healthyHistory(staleSince)
    );

    const res = await verify();
    const body = res.body as OracleVerificationResponse;

    expect(body.isVerified).toBe(false);
    expect(body.dataAgeMs).toBeGreaterThan(9 * 60_000);
    expect(body.dataAgeMs).toBeLessThan(11 * 60_000);
    expect(body.composition.outcome).toBe('rejected-stale-data');
    expect(body.trustScore).toBeGreaterThanOrEqual(70);
  });

  it('never lets an outage reset the clock on stale data', async () => {
    const { upstream, verify } = await harness({ maxOracleAgeMs: 60_000 });

    const fresh = await verify();
    expect(fresh.body.composition.outcome).not.toBe('rejected-stale-data');

    await upstream.stop();
    const during = await verify({ forceRefresh: true, invoiceId: '46' });

    // History vanished, so the verdict is rejected for low trust. What must not
    // happen is the missing feed being read as fresh, reassuring data.
    expect(during.body.isVerified).toBe(false);
    expect(evidenceOf(during.body as OracleVerificationResponse)).toMatch(INDEXER_UNAVAILABLE);
  });

  // ── Reputation feed (Soroban RPC) ──────────────────────────────────────────

  it('degrades to zero reputation when the RPC endpoint refuses the connection', async () => {
    const rpc = await startChaosUpstream();
    await rpc.stop();
    // `https:` because stellar-sdk 15.1.0 rejects a plain-HTTP endpoint in the
    // `rpc.Server` constructor unless `allowHttp` is passed, and
    // `fetchOnChainReputation` does not pass it. With `http:` the request never
    // reaches the socket and this would be a test of a URL scheme rather than of
    // an outage. See the limitation note in docs/oracle-service.md.
    const rpcUrl = rpc.baseUrl.replace(/^http:/, 'https:');

    // Positive control: the port is genuinely dead before the oracle touches it,
    // so a zeroed reputation is a connection failure and not a config mistake.
    expect(await refusalCodeOf(rpcUrl)).toBe('ECONNREFUSED');

    const { service, verify } = await harness({
      reputationProvider: undefined,
      reputationRpcUrl: rpcUrl,
      reputationContractId: CONTRACT_ID,
    });

    const { value: res, tookMs } = await elapsedMs(() => verify({ forceRefresh: true }));
    const body = res.body as OracleVerificationResponse;

    expect(res.status).toBe(200);
    // No deadline is applied to this feed, so the bound that *does* exist is the
    // SDK's own; asserting it keeps a regression to "hangs forever" visible.
    expect(tookMs).toBeLessThan(5_000);
    expect(service.health().reputationConfigured).toBe(true);
    expect(body.reputationScore).toBe(0);
    expect(body.isVerified).toBe(false);
    // The indexer answered, so the outage must not be attributed to it.
    expect(evidenceOf(body)).not.toMatch(INDEXER_UNAVAILABLE);
  });

  it('fails safe when the reputation lookup rejects for any other reason', async () => {
    const { verify } = await harness({
      reputationProvider: undefined,
      // Unresolvable host: a different transport failure than a refused port,
      // and one that surfaces as a plain fetch error rather than ECONNREFUSED.
      reputationRpcUrl: 'https://rpc.invalid.iln.test',
      reputationContractId: CONTRACT_ID,
    });

    const { value: res, tookMs } = await elapsedMs(() => verify({ forceRefresh: true }));

    expect(res.status).toBe(200);
    expect(tookMs).toBeLessThan(15_000);
    expect(res.body.reputationScore).toBe(0);
    expect(res.body.isVerified).toBe(false);
  });

  // ── The outage must be observable, not merely survivable ───────────────────

  it('survives a retry stampede without unhandled rejections', async () => {
    const unhandled: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onRejection);

    try {
      const { upstream, verify, service } = await harness();
      await upstream.stop();

      // Distinct invoice ids defeat the in-flight coalescing: 20 verifications
      // each independently discover the feed is gone.
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) => verify({ invoiceId: String(200 + index) }))
      );

      expect(results).toHaveLength(20);
      for (const res of results) {
        expect(res.status).toBe(200);
        expect(res.body.isVerified).toBe(false);
      }
      expect(unhandled).toEqual([]);

      // Concurrent appends go through the trail's serialisation queue; an
      // outage-driven burst must not fork or gap the hash chain.
      const integrity = await request(service.app).get('/v1/audit/integrity');
      expect(integrity.status).toBe(200);
      expect(integrity.body.valid).toBe(true);
      expect(integrity.body.entries).toBe(20);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('moves the outcome metric the rejection alert watches', async () => {
    const { upstream, service, verify } = await harness();
    await upstream.stop();

    await verify({ forceRefresh: true });

    const metrics = await request(service.app).get('/metrics');
    expect(metrics.status).toBe(200);
    // `OracleAllVerificationsRejected` keys off this series, so an outage pages
    // through the same path as any other incident rather than a bespoke one.
    expect(metrics.text).toMatch(
      /oracle_verification_outcome_total\{outcome="rejected-low-trust",external_status="unknown",cache_hit="false"\} [1-9]/
    );
  });

  it('reports degraded upstreams as a data problem, not a dead service', async () => {
    const { upstream, service, verify } = await harness();
    await upstream.stop();
    await verify({ forceRefresh: true });

    const health = await request(service.app).get('/v1/health');

    expect(health.status).toBe(200);
    // A refused feed is absorbed by design: `degraded` is reserved for the
    // verification path actually throwing, which is a different incident.
    expect(health.body.status).toBe('ok');
    expect(health.body.lastVerificationAt).toBeTruthy();
    expect(health.body.indexerBaseUrl).toBe(upstream.baseUrl);
  });
});
