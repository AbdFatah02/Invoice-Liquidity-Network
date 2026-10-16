import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import {
  PAYER_AUTHORIZATION_FAILURES,
  PAYER_AUTHORIZATION_FAILURE_CODES,
  PAYER_AUTHORIZATION_TAXONOMY_VERSION,
  classifyPayerVerdict,
  enforcePayerAuthorization,
} from './authorization';
import { buildOracleCacheKey, createOracleCache } from './cache';
import { MIN_CONFIDENCE, MIN_TRUST_SCORE, composeVerdict } from './composition';
import { createOracleApp, type CreateOracleAppResult } from './index';
import { MockKYBProvider } from './kyb/mockProvider';
import {
  TEST_PAYER,
  fraudulentHistory,
  healthyHistory,
  makeComposition,
  makeReputation,
  makeResponse,
} from './testFixtures';
import { OracleVerifier } from './verifier';

/**
 * Payer authorization failure taxonomy (issue #1232): stable codes for every
 * way a payer check can be denied, and the fail-closed rule that a published
 * `isVerified: true` never coexists with a failure code.
 */

const NOW = Date.now();
const REQUEST = { payer: TEST_PAYER, amount: '10000000', invoiceId: '42' };

function rejectingKyb(): MockKYBProvider {
  return new MockKYBProvider({
    knownBusinesses: {
      [TEST_PAYER]: {
        isVerified: false,
        businessName: 'Revoked LLC',
        registrationNumber: 'R-0',
        jurisdiction: 'XX',
      },
    },
  });
}

function verifier(overrides: Partial<ConstructorParameters<typeof OracleVerifier>[0]> = {}) {
  return new OracleVerifier({
    historyProvider: async () => healthyHistory(NOW),
    reputationProvider: async () => makeReputation(NOW, { score: 90 }),
    now: () => NOW,
    ...overrides,
  });
}

describe('taxonomy table', () => {
  it('defines a category, status and retry hint for every code', () => {
    expect(PAYER_AUTHORIZATION_TAXONOMY_VERSION).toBe('payer-authz-v1');
    expect(PAYER_AUTHORIZATION_FAILURE_CODES).toHaveLength(14);
    for (const code of PAYER_AUTHORIZATION_FAILURE_CODES) {
      const def = PAYER_AUTHORIZATION_FAILURES[code];
      expect(['request', 'policy', 'freshness', 'dependency', 'internal']).toContain(def.category);
      expect(def.httpStatus).toBeGreaterThanOrEqual(200);
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  it('marks policy denials as non-retryable and dependency failures as retryable', () => {
    for (const code of PAYER_AUTHORIZATION_FAILURE_CODES) {
      const def = PAYER_AUTHORIZATION_FAILURES[code];
      if (def.category === 'policy') expect(def.retryable).toBe(false);
      if (def.category === 'dependency') expect(def.retryable).toBe(true);
    }
  });

  it('is frozen so codes cannot be rewritten at runtime', () => {
    expect(Object.isFrozen(PAYER_AUTHORIZATION_FAILURES)).toBe(true);
  });
});

describe('classifyPayerVerdict', () => {
  it('allows a clean verified verdict', () => {
    expect(classifyPayerVerdict(makeResponse())).toEqual({
      taxonomy: PAYER_AUTHORIZATION_TAXONOMY_VERSION,
      decision: 'allow',
      primary: null,
      failures: [],
    });
  });

  it.each([
    ['rejected-fraud-signals', 'PAYER_FRAUD_SIGNALS'],
    ['rejected-low-trust', 'PAYER_LOW_TRUST'],
    ['rejected-stale-data', 'PAYER_DATA_STALE'],
    ['rejected-kyb-unavailable', 'PAYER_KYB_UNAVAILABLE'],
    ['rejected-kyb-unverified', 'PAYER_KYB_UNVERIFIED'],
  ] as const)('maps composition outcome %s to %s', (outcome, code) => {
    const decision = classifyPayerVerdict(
      makeResponse({ isVerified: false, composition: makeComposition({ outcome }) })
    );
    expect(decision.decision).toBe('deny');
    expect(decision.primary).toBe(code);
  });

  it('ranks a degraded last-known-good verdict ahead of its stored outcome', () => {
    const decision = classifyPayerVerdict(
      makeResponse({
        isVerified: false,
        stale: true,
        degraded: true,
        composition: makeComposition({ outcome: 'rejected-low-trust' }),
      })
    );
    expect(decision.failures.map((f) => f.code)).toEqual([
      'PAYER_DEGRADED_LAST_KNOWN_GOOD',
      'PAYER_LOW_TRUST',
      'PAYER_DATA_STALE',
    ]);
  });

  it('reports every applicable failure, primary first', () => {
    const decision = classifyPayerVerdict(
      makeResponse({
        isVerified: false,
        fraudSignals: ['burst'],
        kybResult: { provider: 'kyb', isVerified: false },
        composition: makeComposition({ outcome: 'rejected-fraud-signals' }),
      })
    );
    expect(decision.primary).toBe('PAYER_FRAUD_SIGNALS');
    expect(decision.failures.map((f) => f.code)).toEqual([
      'PAYER_FRAUD_SIGNALS',
      'PAYER_KYB_UNVERIFIED',
    ]);
  });

  it('never classifies an unexplained denial as an allow', () => {
    const decision = classifyPayerVerdict(makeResponse({ isVerified: false }));
    expect(decision).toMatchObject({ decision: 'deny', primary: 'PAYER_LOW_TRUST' });
  });

  it('classifies payer substitution rejections as PAYER_SUBSTITUTION_REJECTED', () => {
    const decision = classifyPayerVerdict(
      makeResponse({
        isVerified: false,
        fraudSignals: ['Payer substitution rejected: invoice 42 bound to GD... cannot substitute GB...'],
      })
    );
    expect(decision.decision).toBe('deny');
    expect(decision.primary).toBe('PAYER_SUBSTITUTION_REJECTED');
    expect(decision.failures.map((f) => f.code)).toContain('PAYER_SUBSTITUTION_REJECTED');
  });

  it('classifies payer signature failures as PAYER_SIGNATURE_INVALID', () => {
    const decision = classifyPayerVerdict(
      makeResponse({
        isVerified: false,
        fraudSignals: ['Payer signature invalid: Cryptographic signature does not match canonical payload'],
      })
    );
    expect(decision.decision).toBe('deny');
    expect(decision.primary).toBe('PAYER_SIGNATURE_INVALID');
    expect(decision.failures.map((f) => f.code)).toContain('PAYER_SIGNATURE_INVALID');
  });
});

describe('enforcePayerAuthorization (fail closed)', () => {
  it('flips isVerified when the verdict disagrees with its own evidence', () => {
    // The pre-#1232 shape: composition said verified, KYB said no.
    const inconsistent = makeResponse({
      isVerified: true,
      kybResult: { provider: 'kyb', isVerified: false },
    });
    const enforced = enforcePayerAuthorization(inconsistent);
    expect(enforced.isVerified).toBe(false);
    expect(enforced.authorization?.primary).toBe('PAYER_KYB_UNVERIFIED');
  });

  it('is idempotent across repeated application', () => {
    const once = enforcePayerAuthorization(makeResponse({ fraudSignals: ['x'] }));
    const twice = enforcePayerAuthorization(once);
    expect(twice).toEqual(once);
  });
});

describe('boundary: trust and confidence thresholds', () => {
  function atThreshold(trustScore: number, baseConfidence: number) {
    const verdict = composeVerdict({
      trustScore,
      baseConfidence,
      fraudSignals: [],
      isFresh: true,
      external: undefined,
    });
    return enforcePayerAuthorization(
      makeResponse({ trustScore, isVerified: verdict.isVerified, composition: verdict.composition })
    );
  }

  it('allows a payer exactly at the minimum trust score and confidence', () => {
    const response = atThreshold(MIN_TRUST_SCORE, MIN_CONFIDENCE);
    expect(response.isVerified).toBe(true);
    expect(response.authorization?.decision).toBe('allow');
  });

  it('denies one point below the minimum trust score as PAYER_LOW_TRUST', () => {
    const response = atThreshold(MIN_TRUST_SCORE - 1, MIN_CONFIDENCE);
    expect(response.isVerified).toBe(false);
    expect(response.authorization?.primary).toBe('PAYER_LOW_TRUST');
  });

  it('denies just below the minimum confidence as PAYER_LOW_TRUST', () => {
    const response = atThreshold(MIN_TRUST_SCORE, MIN_CONFIDENCE - 0.01);
    expect(response.authorization?.primary).toBe('PAYER_LOW_TRUST');
  });
});

describe('verifier integration', () => {
  it('success: allows a healthy payer that passes KYB', async () => {
    const response = await verifier({ kybProvider: new MockKYBProvider() }).verify(REQUEST);
    expect(response.isVerified).toBe(true);
    expect(response.authorization).toMatchObject({ decision: 'allow', failures: [] });
  });

  it('failure: an explicit KYB rejection denies with PAYER_KYB_UNVERIFIED', async () => {
    const response = await verifier({ kybProvider: rejectingKyb() }).verify(REQUEST);
    expect(response.isVerified).toBe(false);
    expect(response.composition.outcome).toBe('rejected-kyb-unverified');
    expect(response.authorization?.primary).toBe('PAYER_KYB_UNVERIFIED');
  });

  it('failure: a fraudulent history denies with PAYER_FRAUD_SIGNALS', async () => {
    const response = await verifier({
      historyProvider: async () => fraudulentHistory(NOW),
    }).verify(REQUEST);
    expect(response.isVerified).toBe(false);
    expect(response.authorization?.primary).toBe('PAYER_FRAUD_SIGNALS');
  });

  it('failure: a required KYB provider that throws denies with PAYER_KYB_UNAVAILABLE', async () => {
    const response = await verifier({
      requireKyb: true,
      kybProvider: {
        name: 'down',
        verifyPayer: async () => {
          throw new Error('timeout');
        },
      },
    }).verify(REQUEST);
    expect(response.authorization?.primary).toBe('PAYER_KYB_UNAVAILABLE');
    expect(response.authorization?.failures[0].retryable).toBe(true);
  });

  it('replay: a cached verdict replays with an identical authorization decision', async () => {
    const { cache } = await createOracleCache();
    const first = await verifier({ cache, kybProvider: rejectingKyb() }).verify(REQUEST);
    const replay = await verifier({ cache, kybProvider: rejectingKyb() }).verify(REQUEST);

    expect(replay.cacheHit).toBe(true);
    expect(replay.authorization).toEqual(first.authorization);
  });

  it('restart: a legacy cache entry without a taxonomy block is re-classified fail-closed', async () => {
    const { cache } = await createOracleCache();
    // Written by a pre-#1232 instance: verified, yet carrying a KYB rejection.
    const legacy = makeResponse({
      isVerified: true,
      kybResult: { provider: 'MockKYBProvider', isVerified: false },
    });
    delete legacy.authorization;
    await cache.set(buildOracleCacheKey(REQUEST), legacy, 60);

    // A fresh process sharing the cache must not publish the stored `true`.
    const restarted = verifier({ cache, historyProvider: async () => healthyHistory(NOW) });
    const response = await restarted.verify(REQUEST);

    expect(response.cacheHit).toBe(true);
    expect(response.isVerified).toBe(false);
    expect(response.authorization?.primary).toBe('PAYER_KYB_UNVERIFIED');
  });
});

describe('HTTP surface and operator evidence', () => {
  let created: CreateOracleAppResult;

  afterEach(async () => {
    await created?.close();
  });

  async function build(overrides: Parameters<typeof createOracleApp>[0] = {}) {
    created = await createOracleApp({
      indexerBaseUrl: 'http://indexer.local',
      historyProvider: async () => healthyHistory(NOW),
      reputationProvider: async () => makeReputation(NOW, { score: 90 }),
      enableRateLimit: false,
      ...overrides,
    });
    return created;
  }

  async function metricsText(app: CreateOracleAppResult['app']): Promise<string> {
    return (await request(app).get('/metrics')).text;
  }

  it('exposes the active taxonomy version as an always-on gauge', async () => {
    const { app } = await build();
    expect(await metricsText(app)).toContain(
      `oracle_payer_authorization_taxonomy_info{version="${PAYER_AUTHORIZATION_TAXONOMY_VERSION}"} 1`
    );
  });

  it('returns PAYER_REQUEST_MALFORMED with the legacy error string preserved', async () => {
    const { app } = await build();
    const res = await request(app).post('/verify').send({ payer: TEST_PAYER });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: 'payer, amount, and invoiceId are required',
      code: 'PAYER_REQUEST_MALFORMED',
      category: 'request',
      retryable: false,
      taxonomy: PAYER_AUTHORIZATION_TAXONOMY_VERSION,
    });
    expect(await metricsText(app)).toMatch(
      /oracle_payer_authorization_failures_total\{code="PAYER_REQUEST_MALFORMED",category="request",primary="true",cache_hit="false"\} 1/
    );
  });

  it('returns PAYER_ADDRESS_INVALID for a non-Stellar payer', async () => {
    const { app } = await build();
    const res = await request(app)
      .post('/verify')
      .send({ payer: 'not a key!', amount: '1', invoiceId: 1 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PAYER_ADDRESS_INVALID');
  });

  it('attaches the decision to verdicts and counts denials by code', async () => {
    const { app } = await build({ historyProvider: async () => fraudulentHistory(NOW) });
    const res = await request(app)
      .post('/verify')
      .send({ payer: TEST_PAYER, amount: '10000000', invoiceId: 42 });

    expect(res.status).toBe(200);
    expect(res.body.isVerified).toBe(false);
    expect(res.body.authorization).toMatchObject({
      decision: 'deny',
      primary: 'PAYER_FRAUD_SIGNALS',
    });

    const text = await metricsText(app);
    expect(text).toContain(
      'oracle_payer_authorization_decisions_total{decision="deny",stage="verdict"} 1'
    );
    expect(text).toMatch(/code="PAYER_FRAUD_SIGNALS",category="policy",primary="true"/);
  });

  it('counts allowed payers so the denial ratio has a denominator', async () => {
    const { app } = await build();
    const res = await request(app)
      .post('/verify')
      .send({ payer: TEST_PAYER, amount: '10000000', invoiceId: 42 });

    expect(res.body.authorization?.decision).toBe('allow');
    expect(await metricsText(app)).toContain(
      'oracle_payer_authorization_decisions_total{decision="allow",stage="verdict"} 1'
    );
  });

  it('returns ORACLE_SOURCES_UNAVAILABLE when every source is down with no cache', async () => {
    const down = async () => {
      throw new Error('down');
    };
    const { app } = await build({ historyProvider: down, reputationProvider: down });
    const res = await request(app)
      .post('/verify')
      .send({ payer: TEST_PAYER, amount: '10000000', invoiceId: 42 });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      error: 'Oracle unavailable',
      degraded: true,
      code: 'ORACLE_SOURCES_UNAVAILABLE',
      retryable: true,
    });
  });

  it('returns PAYER_RATE_LIMITED once the admission window is exhausted', async () => {
    const { app } = await build({
      enableRateLimit: true,
      rateLimitWindowMs: 60_000,
      rateLimitMaxRequests: 1,
    });
    const body = { payer: TEST_PAYER, amount: '10000000', invoiceId: 42 };
    await request(app).post('/verify').send(body);
    const limited = await request(app).post('/verify').send(body);

    expect(limited.status).toBe(429);
    expect(limited.body.code).toMatch(/^PAYER_(RATE_LIMITED|ABUSE_BLOCKED)$/);
    expect(limited.body.retryable).toBe(true);
  });
});
