import { describe, expect, it } from 'vitest';
import request from 'supertest';

import { createOracleCache } from './cache';
import { createOracleApp } from './index';
import { MockKYBProvider } from './kyb/mockProvider';
import { OracleVerifier } from './verifier';
import type { IndexerInvoiceHistoryEntry, ReputationSnapshot } from './types';

const PAYER = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';

const REQUEST = {
  payer: PAYER,
  amount: '10000000',
  invoiceId: '42',
  maxOracleAgeMs: 0,
};

const healthyHistory: IndexerInvoiceHistoryEntry[] = [
  {
    id: 1,
    freelancer: 'G1',
    payer: PAYER,
    amount: '8000000',
    due_date: 0,
    discount_rate: 300,
    status: 'Paid',
    funder: 'G2',
    funded_at: 1700000000000,
    created_at: 1700000000000,
    updated_at: 1700864000000,
  },
  {
    id: 2,
    freelancer: 'G1',
    payer: PAYER,
    amount: '10000000',
    due_date: 0,
    discount_rate: 300,
    status: 'Paid',
    funder: 'G2',
    funded_at: 1700432000000,
    created_at: 1700432000000,
    updated_at: 1701296000000,
  },
  {
    id: 3,
    freelancer: 'G1',
    payer: PAYER,
    amount: '12000000',
    due_date: 0,
    discount_rate: 300,
    status: 'Paid',
    funder: 'G2',
    funded_at: 1700864000000,
    created_at: 1700864000000,
    updated_at: 1701728000000,
  },
  {
    id: 4,
    freelancer: 'G1',
    payer: PAYER,
    amount: '14000000',
    due_date: 0,
    discount_rate: 300,
    status: 'Defaulted',
    funder: 'G2',
    funded_at: 1701296000000,
    created_at: 1701296000000,
    updated_at: 1702160000000,
  },
];

const reputation: ReputationSnapshot = {
  address: PAYER,
  score: 95,
  totalPaid: 1000000000n,
  invoiceCount: 4,
  lastActivity: Date.now(),
  rank: 1,
};

describe('KYB Provider Fail-Closed Hardening (Issue #1233)', () => {
  describe('Criterion 1 & 2: Production behavior, failure, and boundary conditions', () => {
    it('success: allows a payer when KYB provider is healthy and verifies', async () => {
      const mockKyb = new MockKYBProvider({
        knownBusinesses: {
          [PAYER]: {
            isVerified: true,
            businessName: 'Valid Corp',
            registrationNumber: 'REG-123',
            jurisdiction: 'US-DE',
            riskScore: 5,
          },
        },
      });

      const verifier = new OracleVerifier({
        historyProvider: async () => healthyHistory,
        reputationProvider: async () => reputation,
        kybProvider: mockKyb,
        requireKyb: true,
      });

      const response = await verifier.verify(REQUEST);
      expect(response.isVerified).toBe(true);
      expect(response.authorization?.decision).toBe('allow');
      expect(response.authorization?.primary).toBeNull();
      expect(response.kybResult?.isVerified).toBe(true);
    });

    it('failure: fails closed when configured KYB provider throws an error', async () => {
      const failingKyb = new MockKYBProvider({
        unavailable: true,
        unavailableError: 'KYB upstream network timeout',
      });

      const verifier = new OracleVerifier({
        historyProvider: async () => healthyHistory,
        reputationProvider: async () => reputation,
        kybProvider: failingKyb,
        requireKyb: true,
      });

      const response = await verifier.verify(REQUEST);
      expect(response.isVerified).toBe(false);
      expect(response.composition.outcome).toBe('rejected-kyb-unavailable');
      expect(response.authorization?.decision).toBe('deny');
      expect(response.authorization?.primary).toBe('PAYER_KYB_UNAVAILABLE');
      expect(response.authorization?.failures[0].category).toBe('dependency');
      expect(response.authorization?.failures[0].retryable).toBe(true);
      expect(response.evidence).toContain(
        'Required KYB provider is unavailable; retry verification before onboarding.'
      );
    });

    it('failure: fails closed when requireKyb is false but configured provider throws', async () => {
      const failingKyb = {
        name: 'unstable-kyb',
        verifyPayer: async () => {
          throw new Error('Connection reset by peer');
        },
      };

      const verifier = new OracleVerifier({
        historyProvider: async () => healthyHistory,
        reputationProvider: async () => reputation,
        kybProvider: failingKyb,
        requireKyb: false,
      });

      const response = await verifier.verify(REQUEST);
      expect(response.isVerified).toBe(false);
      expect(response.composition.outcome).toBe('rejected-kyb-unavailable');
      expect(response.authorization?.primary).toBe('PAYER_KYB_UNAVAILABLE');
    });

    it('failure: fails closed when required KYB has no provider configured', async () => {
      const verifier = new OracleVerifier({
        historyProvider: async () => healthyHistory,
        reputationProvider: async () => reputation,
        kybProvider: undefined,
        requireKyb: true,
      });

      const response = await verifier.verify(REQUEST);
      expect(response.isVerified).toBe(false);
      expect(response.composition.outcome).toBe('rejected-kyb-unavailable');
      expect(response.authorization?.primary).toBe('PAYER_KYB_UNAVAILABLE');
    });

    it('boundary condition: recovers immediately when provider transitions from unavailable to available', async () => {
      const provider = new MockKYBProvider({ unavailable: true });

      const verifier = new OracleVerifier({
        historyProvider: async () => healthyHistory,
        reputationProvider: async () => reputation,
        kybProvider: provider,
        requireKyb: true,
      });

      // While unavailable: fails closed
      const failureResp = await verifier.verify(REQUEST);
      expect(failureResp.isVerified).toBe(false);
      expect(failureResp.authorization?.primary).toBe('PAYER_KYB_UNAVAILABLE');

      // Provider recovers
      provider.setUnavailable(false);

      // Subsequent attempt succeeds without restart
      const successResp = await verifier.verify(REQUEST);
      expect(successResp.isVerified).toBe(true);
      expect(successResp.authorization?.decision).toBe('allow');
    });

    it('boundary condition: distinguishes explicit rejection (policy) from outage (dependency)', async () => {
      const rejectingProvider = new MockKYBProvider({ defaultVerified: false });
      const throwingProvider = new MockKYBProvider({ unavailable: true });

      const policyVerifier = new OracleVerifier({
        historyProvider: async () => healthyHistory,
        reputationProvider: async () => reputation,
        kybProvider: rejectingProvider,
        requireKyb: true,
      });

      const depVerifier = new OracleVerifier({
        historyProvider: async () => healthyHistory,
        reputationProvider: async () => reputation,
        kybProvider: throwingProvider,
        requireKyb: true,
      });

      const policyResp = await policyVerifier.verify(REQUEST);
      expect(policyResp.authorization?.primary).toBe('PAYER_KYB_UNVERIFIED');
      expect(policyResp.authorization?.failures[0].category).toBe('policy');
      expect(policyResp.authorization?.failures[0].retryable).toBe(false);

      const depResp = await depVerifier.verify(REQUEST);
      expect(depResp.authorization?.primary).toBe('PAYER_KYB_UNAVAILABLE');
      expect(depResp.authorization?.failures[0].category).toBe('dependency');
      expect(depResp.authorization?.failures[0].retryable).toBe(true);
    });

    it('replay: unavailable dependency errors are not cached to prevent retry lockout', async () => {
      const { cache } = await createOracleCache();
      let callCount = 0;
      const flappyProvider = {
        name: 'flappy',
        verifyPayer: async () => {
          callCount += 1;
          if (callCount === 1) {
            throw new Error('503 Service Unavailable');
          }
          return {
            provider: 'flappy',
            isVerified: true,
            businessName: 'Recovered Corp',
            registrationNumber: 'REG-999',
            jurisdiction: 'US-DE',
            riskScore: 10,
            verifiedAt: new Date().toISOString(),
          };
        },
      };

      const verifier = new OracleVerifier({
        cache,
        historyProvider: async () => healthyHistory,
        reputationProvider: async () => reputation,
        kybProvider: flappyProvider,
        requireKyb: false,
      });

      // First call fails closed
      const first = await verifier.verify(REQUEST);
      expect(first.isVerified).toBe(false);
      expect(first.authorization?.primary).toBe('PAYER_KYB_UNAVAILABLE');

      // Second call retries provider instead of serving stale cached outage
      const second = await verifier.verify(REQUEST);
      expect(second.isVerified).toBe(true);
      expect(second.authorization?.decision).toBe('allow');
      expect(callCount).toBe(2);
    });
  });

  describe('Criterion 3: Operational evidence: HTTP health, metrics, and logs', () => {
    it('surfaces KYB degradation in /health and /v1/health when provider fails', async () => {
      const failingKyb = new MockKYBProvider({ unavailable: true });
      const service = await createOracleApp({
        historyProvider: async () => healthyHistory,
        reputationProvider: async () => reputation,
        kybProvider: failingKyb,
        requireKyb: true,
        enableRateLimit: false,
      });

      try {
        // Trigger verification request to drive source health tracking
        const verifyRes = await request(service.app).post('/v1/verify').send(REQUEST).expect(200);

        expect(verifyRes.body.isVerified).toBe(false);
        expect(verifyRes.body.authorization?.primary).toBe('PAYER_KYB_UNAVAILABLE');

        // Check health endpoint reflects degraded status
        const healthRes = await request(service.app).get('/health').expect(200);
        expect(healthRes.body.status).toBe('degraded');

        // Check metrics endpoint exports PAYER_KYB_UNAVAILABLE failure counter
        const metricsRes = await request(service.app).get('/metrics').expect(200);
        expect(metricsRes.text).toContain('code="PAYER_KYB_UNAVAILABLE"');
      } finally {
        await service.close();
      }
    });
  });
});
