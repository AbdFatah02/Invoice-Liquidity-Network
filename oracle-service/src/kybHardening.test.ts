import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { MemoryAuditStore } from './audit-store';
import { buildOracleCacheKey, createOracleCache } from './cache';
import { createOracleApp, type CreateOracleAppResult } from './index';
import { MockKYBProvider } from './kyb/mockProvider';
import { createOracleMetrics } from './metrics';
import { TEST_PAYER, healthyHistory, makeReputation, makeResponse } from './testFixtures';
import type {
  KYBVerificationResult,
  OracleCacheReaderWriter,
  OracleServiceOptions,
  VerificationProvider,
} from './types';
import { DEFAULT_KYB_DECISION_TTL_MS, OracleVerifier } from './verifier';

/**
 * KYB hardening, wave-9 (#1234–#1237):
 *
 *  - #1234 production wiring refuses the mock KYB adapter (and any adapter
 *    that declares itself a mock) at boot.
 *  - #1235 production wiring requires an explicit, required KYB provider at
 *    boot, with the loaded configuration visible on /health and /metrics.
 *  - #1236 every publication records KYB provider provenance — who checked,
 *    what they concluded, when, and whether this publication replayed it.
 *  - #1237 a recorded KYB decision expires after `kybDecisionTtlMs` and is
 *    revalidated against the provider instead of being replayed from cache,
 *    including across process restarts.
 */

const NOW = 1_701_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const REQUEST = { payer: TEST_PAYER, amount: '10000000', invoiceId: '42' };

interface StubState {
  calls: number;
  down?: boolean;
}

function stubKyb(
  options: {
    name?: string;
    isMock?: boolean;
    verified?: boolean;
    verifiedAt?: () => string | undefined;
    state?: StubState;
  } = {}
): VerificationProvider {
  const name = options.name ?? 'stub-kyb';
  const state = options.state ?? { calls: 0 };
  return {
    name,
    isMock: options.isMock,
    async verifyPayer(): Promise<KYBVerificationResult> {
      state.calls += 1;
      if (options.state?.down) {
        throw new Error('KYB provider unreachable');
      }
      const isVerified = options.verified ?? true;
      return {
        provider: name,
        isVerified,
        businessName: 'Stub Trading Co',
        registrationNumber: 'REG-STUB-1',
        jurisdiction: 'US-DE',
        verifiedAt: options.verifiedAt?.() ?? new Date().toISOString(),
        signals: isVerified ? [] : ['Stub rejection'],
      };
    },
  };
}

function makeVerifier(
  input: {
    cache?: OracleCacheReaderWriter;
    kybProvider?: VerificationProvider;
    requireKyb?: boolean;
    kybDecisionTtlMs?: number;
    nowRef?: { value: number };
    metrics?: ReturnType<typeof createOracleMetrics>;
  } = {}
): OracleVerifier {
  const nowRef = input.nowRef ?? { value: NOW };
  return new OracleVerifier({
    historyProvider: async () => healthyHistory(nowRef.value),
    reputationProvider: async () => makeReputation(nowRef.value, { score: 90 }),
    kybProvider: input.kybProvider,
    requireKyb: input.requireKyb ?? false,
    kybDecisionTtlMs: input.kybDecisionTtlMs,
    cacheTtlSeconds: 3600,
    now: () => nowRef.value,
    cache: input.cache,
    metrics: input.metrics,
  });
}

async function sharedCache(): Promise<OracleCacheReaderWriter> {
  return (await createOracleCache()).cache;
}

// ---------------------------------------------------------------------------
// #1236 — KYB provider provenance in verification results
// ---------------------------------------------------------------------------

describe('#1236 KYB decision provenance', () => {
  it('records a live provider decision with provider, status and decision instant', async () => {
    const checkedAt = new Date(NOW - 60_000).toISOString();
    const verifier = makeVerifier({ kybProvider: stubKyb({ verifiedAt: () => checkedAt }) });

    const response = await verifier.verify(REQUEST);

    expect(response.kybProvenance).toEqual({
      provider: 'stub-kyb',
      status: 'verified',
      source: 'live',
      checkedAt,
      ageMs: 60_000,
    });
  });

  it('records an explicit provider rejection as unverified', async () => {
    const verifier = makeVerifier({ kybProvider: stubKyb({ verified: false }) });

    const response = await verifier.verify(REQUEST);

    expect(response.kybProvenance).toMatchObject({
      provider: 'stub-kyb',
      status: 'unverified',
      source: 'live',
    });
  });

  it('records a throwing provider as unavailable, never as a failed identity check', async () => {
    const verifier = makeVerifier({ kybProvider: stubKyb({ state: { calls: 0, down: true } }) });

    const response = await verifier.verify(REQUEST);

    expect(response.kybProvenance).toMatchObject({
      provider: 'stub-kyb',
      status: 'unavailable',
      source: 'live',
    });
  });

  it('records an absent provider as not-configured, so silence is explicit', async () => {
    const verifier = makeVerifier();

    const response = await verifier.verify(REQUEST);

    expect(response.kybProvenance).toEqual({
      provider: 'not-configured',
      status: 'not-configured',
      source: 'live',
      checkedAt: new Date(NOW).toISOString(),
      ageMs: 0,
    });
  });

  it('replay: a cache hit re-labels the original observation as cache and ages it', async () => {
    const nowRef = { value: NOW };
    const cache = await sharedCache();
    const state: StubState = { calls: 0 };
    const checkedAt = new Date(NOW).toISOString();
    const verifier = makeVerifier({
      nowRef,
      cache,
      kybProvider: stubKyb({ state, verifiedAt: () => checkedAt }),
    });

    const first = await verifier.verify(REQUEST);
    expect(first.kybProvenance).toMatchObject({ source: 'live', checkedAt });

    nowRef.value += 5 * 60_000;
    const replay = await verifier.verify(REQUEST);

    expect(replay.cacheHit).toBe(true);
    expect(state.calls).toBe(1);
    expect(replay.kybProvenance).toEqual({
      provider: 'stub-kyb',
      status: 'verified',
      source: 'cache',
      checkedAt,
      ageMs: 5 * 60_000,
    });
  });

  it('restart: a fresh process sharing the cache replays the recorded provenance', async () => {
    const nowRef = { value: NOW };
    const cache = await sharedCache();
    const checkedAt = new Date(NOW).toISOString();
    await makeVerifier({
      nowRef,
      cache,
      kybProvider: stubKyb({ verifiedAt: () => checkedAt }),
    }).verify(REQUEST);

    nowRef.value += 60_000;
    const restarted = makeVerifier({ nowRef, cache, kybProvider: stubKyb() });
    const replay = await restarted.verify(REQUEST);

    expect(replay.cacheHit).toBe(true);
    expect(replay.kybProvenance).toMatchObject({
      provider: 'stub-kyb',
      source: 'cache',
      checkedAt,
      ageMs: 60_000,
    });
  });
});

// ---------------------------------------------------------------------------
// #1237 — KYB decision expiry and revalidation
// ---------------------------------------------------------------------------

describe('#1237 KYB decision expiry and revalidation', () => {
  it('replays a decision younger than the TTL without touching the provider', async () => {
    const nowRef = { value: NOW };
    const cache = await sharedCache();
    const state: StubState = { calls: 0 };
    const verifier = makeVerifier({
      nowRef,
      cache,
      kybDecisionTtlMs: HOUR_MS,
      kybProvider: stubKyb({ state, verifiedAt: () => new Date(nowRef.value).toISOString() }),
    });

    await verifier.verify(REQUEST);
    nowRef.value += HOUR_MS - 1;
    const replay = await verifier.verify(REQUEST);

    expect(replay.cacheHit).toBe(true);
    expect(state.calls).toBe(1);
  });

  it('revalidates a decision exactly at the TTL boundary and counts the revalidation', async () => {
    const nowRef = { value: NOW };
    const cache = await sharedCache();
    const state: StubState = { calls: 0 };
    const metrics = createOracleMetrics();
    const verifier = makeVerifier({
      nowRef,
      cache,
      metrics,
      kybDecisionTtlMs: HOUR_MS,
      kybProvider: stubKyb({ state, verifiedAt: () => new Date(nowRef.value).toISOString() }),
    });

    await verifier.verify(REQUEST);
    nowRef.value += HOUR_MS; // boundary: age === TTL must expire
    const revalidated = await verifier.verify(REQUEST);

    expect(revalidated.cacheHit).toBe(false);
    expect(state.calls).toBe(2);
    expect(revalidated.kybProvenance).toMatchObject({
      source: 'live',
      checkedAt: new Date(NOW + HOUR_MS).toISOString(),
    });

    const revalidations = await metrics.kybRevalidationsTotal.get();
    expect(
      revalidations.values.find((v) => v.labels.reason === 'expired-decision')?.value
    ).toBe(1);
  });

  it('restart: a shared cache cannot resurrect an expired decision', async () => {
    const nowRef = { value: NOW };
    const cache = await sharedCache();
    await makeVerifier({
      nowRef,
      cache,
      kybDecisionTtlMs: HOUR_MS,
      kybProvider: stubKyb({ verifiedAt: () => new Date(nowRef.value).toISOString() }),
    }).verify(REQUEST);

    nowRef.value += HOUR_MS + 1;
    const restartedState: StubState = { calls: 0 };
    const restarted = makeVerifier({
      nowRef,
      cache,
      kybDecisionTtlMs: HOUR_MS,
      kybProvider: stubKyb({
        state: restartedState,
        verifiedAt: () => new Date(nowRef.value).toISOString(),
      }),
    });
    const response = await restarted.verify(REQUEST);

    expect(response.cacheHit).toBe(false);
    expect(restartedState.calls).toBe(1);
    expect(response.kybProvenance?.checkedAt).toBe(new Date(NOW + HOUR_MS + 1).toISOString());
  });

  it('revalidates a pre-#1236 cache row that carries only kybResult.verifiedAt', async () => {
    const cache = await sharedCache();
    const legacy = makeResponse({
      kybResult: {
        provider: 'legacy-kyb',
        isVerified: true,
        verifiedAt: new Date(NOW - 2 * HOUR_MS).toISOString(),
      },
    });
    await cache.set(buildOracleCacheKey(REQUEST), legacy, 3600);

    const state: StubState = { calls: 0 };
    const response = await makeVerifier({
      cache,
      kybDecisionTtlMs: HOUR_MS,
      kybProvider: stubKyb({ state }),
    }).verify(REQUEST);

    expect(response.cacheHit).toBe(false);
    expect(state.calls).toBe(1);
    expect(response.kybProvenance).toMatchObject({ provider: 'stub-kyb', source: 'live' });
  });

  it('fail-closed: after expiry an unreachable provider is unavailable, not a replayed pass', async () => {
    const nowRef = { value: NOW };
    const cache = await sharedCache();
    const state: StubState = { calls: 0 };
    const verifier = makeVerifier({
      nowRef,
      cache,
      kybDecisionTtlMs: HOUR_MS,
      kybProvider: stubKyb({ state, verifiedAt: () => new Date(nowRef.value).toISOString() }),
    });

    const first = await verifier.verify(REQUEST);
    expect(first.kybProvenance?.status).toBe('verified');

    nowRef.value += HOUR_MS + 1;
    state.down = true;
    const response = await verifier.verify(REQUEST);

    expect(response.cacheHit).toBe(false);
    expect(response.kybResult).toBeUndefined();
    expect(response.kybProvenance).toMatchObject({ status: 'unavailable', source: 'live' });
    // The expired pass is gone, not laundered through the cache: nothing in
    // this publication still claims a provider-verified entity. (With
    // requireKyb: false an unavailable provider stays advisory by design; the
    // required-KYB fail-closed path is covered in verifier.test.ts.)
    expect(response.evidence.join(' ')).not.toMatch(/KYB verification \(stub-kyb\): VERIFIED/);
  });
});

// ---------------------------------------------------------------------------
// #1234 / #1235 — production wiring, enforced at boot
// ---------------------------------------------------------------------------

describe('#1234/#1235 production KYB wiring', () => {
  const envKeys = ['NODE_ENV', 'ORACLE_SIGNING_KEY', 'ORACLE_KYB_DECISION_TTL_MS'] as const;
  let saved: Record<string, string | undefined>;
  let created: CreateOracleAppResult | undefined;

  beforeEach(() => {
    saved = {};
    for (const key of envKeys) saved[key] = process.env[key];
  });

  afterEach(async () => {
    await created?.close();
    created = undefined;
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  /**
   * An explicit (non-production) audit store and signing store sidestep those
   * components' own production guards, so the failure under test is always the
   * KYB wiring and nothing else.
   */
  function appOptions(
    extra: Partial<OracleServiceOptions> = {}
  ): Partial<OracleServiceOptions> {
    return {
      auditStore: new MemoryAuditStore(),
      signingKeyStore: null,
      historyProvider: async () => healthyHistory(NOW),
      reputationProvider: async () => makeReputation(NOW),
      enableRateLimit: false,
      ...extra,
    };
  }

  it('#1235 refuses to boot in production without an explicit KYB provider', async () => {
    process.env.NODE_ENV = 'production';

    await expect(createOracleApp(appOptions())).rejects.toThrow(/explicit KYB provider/);
  });

  it('#1235 refuses to boot in production with requireKyb disabled', async () => {
    process.env.NODE_ENV = 'production';

    await expect(
      createOracleApp(appOptions({ kybProvider: stubKyb(), requireKyb: false }))
    ).rejects.toThrow(/requireKyb disabled/);
  });

  it('#1234 refuses the mock KYB adapter in production', async () => {
    process.env.NODE_ENV = 'production';

    await expect(
      createOracleApp(appOptions({ kybProvider: new MockKYBProvider() }))
    ).rejects.toThrow(/mock KYB provider "MockKYBProvider"/);
  });

  it('#1234 refuses any adapter that declares itself a mock, whatever its name', async () => {
    process.env.NODE_ENV = 'production';

    await expect(
      createOracleApp(appOptions({ kybProvider: stubKyb({ name: 'vendor-api', isMock: true }) }))
    ).rejects.toThrow(/mock KYB provider "vendor-api"/);
  });

  it('#1235 boots in production with a live provider and publishes the wiring', async () => {
    process.env.NODE_ENV = 'production';

    created = await createOracleApp(appOptions({ kybProvider: stubKyb({ name: 'vendor-api' }) }));

    expect(created.health().kyb).toEqual({
      configured: true,
      provider: 'vendor-api',
      required: true,
      decisionTtlMs: DEFAULT_KYB_DECISION_TTL_MS,
    });
  });

  it('keeps fixtures usable outside production', async () => {
    delete process.env.NODE_ENV;

    created = await createOracleApp(appOptions({ kybProvider: new MockKYBProvider() }));

    expect(created.health().kyb).toMatchObject({
      configured: true,
      provider: 'MockKYBProvider',
      required: false,
      decisionTtlMs: DEFAULT_KYB_DECISION_TTL_MS,
    });
  });

  it('rejects a non-positive decision TTL at boot', async () => {
    process.env.ORACLE_KYB_DECISION_TTL_MS = '0';

    await expect(createOracleApp(appOptions())).rejects.toThrow(/KYB decision TTL/);
  });

  it('serves the loaded wiring and recorded provenance on /health and /metrics', async () => {
    delete process.env.NODE_ENV;
    created = await createOracleApp(appOptions({ kybProvider: stubKyb() }));

    const health = await request(created.app).get('/v1/health');
    expect(health.body.kyb).toMatchObject({ configured: true, provider: 'stub-kyb', required: false });

    const verified = await request(created.app)
      .post('/v1/verify')
      .send({ payer: TEST_PAYER, amount: '10000000', invoiceId: 42 });
    expect(verified.status).toBe(200);
    expect(verified.body.kybProvenance).toMatchObject({
      provider: 'stub-kyb',
      status: 'verified',
      source: 'live',
    });

    const metrics = await request(created.app).get('/v1/metrics');
    expect(metrics.text).toContain('oracle_kyb_config_info');
    expect(metrics.text).toMatch(
      /oracle_kyb_provenance_total\{[^}]*provider="stub-kyb"[^}]*status="verified"[^}]*source="live"/
    );
  });
});
