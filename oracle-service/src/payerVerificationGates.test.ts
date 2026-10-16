import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createOracleApp, type CreateOracleAppResult } from './index';
import { buildCanonicalInvoicePayload } from './canonicalPayload';
import {
  healthyHistory,
  makeReputation,
} from './testFixtures';
import type { IndexerInvoiceHistoryEntry, InvoiceStatus } from './types';

describe('Payer Signature & Substitution Gates Integration (Issues #1228, #1229)', () => {
  let appInstance: CreateOracleAppResult | null = null;

  afterEach(async () => {
    if (appInstance) {
      await appInstance.close();
      appInstance = null;
    }
  });

  const payerKeypair = Keypair.random();
  const payerPublicKey = payerKeypair.publicKey();
  const attackerKeypair = Keypair.random();

  function getPayerHealthyHistory(): IndexerInvoiceHistoryEntry[] {
    return healthyHistory(Date.now()).map((h) => ({
      ...h,
      payer: payerPublicKey,
    }));
  }

  function getPayerReputation() {
    return makeReputation(Date.now(), { address: payerPublicKey, score: 95 });
  }

  function makeHistoryEntry(
    id: number,
    payer: string,
    status: InvoiceStatus
  ): IndexerInvoiceHistoryEntry {
    const nowMs = Date.now();
    return {
      id,
      freelancer: 'GCLWGQPMKXQSPF776IU33AH4PZNOOWNAWGGCD6ABCDEF1234567890AB',
      payer,
      amount: '10000000',
      due_date: Math.floor(nowMs / 1000) + 86400 * 30,
      discount_rate: 300,
      status,
      created_at: nowMs - 3600000,
      updated_at: nowMs,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 1: Success Integration
  // ───────────────────────────────────────────────────────────────────────────
  describe('Success Integration', () => {
    it('verifies successfully when canonical signature matches and no substitution occurs', async () => {
      const canonical = buildCanonicalInvoicePayload({
        invoiceId: '2001',
        payer: payerPublicKey,
        amount: '10000000',
      });
      const sig = payerKeypair.sign(Buffer.from(canonical, 'utf8')).toString('hex');

      appInstance = await createOracleApp({
        historyProvider: async () => getPayerHealthyHistory(),
        reputationProvider: async () => getPayerReputation(),
        requireKyb: false,
        requirePayerSignature: true,
      });

      const res = await request(appInstance.app)
        .post('/v1/verify')
        .send({
          payer: payerPublicKey,
          invoiceId: '2001',
          amount: '10000000',
          payerSignature: sig,
        });

      expect(res.status).toBe(200);
      expect(res.body.isVerified).toBe(true);
      expect(res.body.authorization.decision).toBe('allow');
      expect(res.body.authorization.primary).toBeNull();
      expect(res.body.evidence).toContain(
        'Payer signature verified against canonical invoice payload'
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 2: Failure Integration
  // ───────────────────────────────────────────────────────────────────────────
  describe('Failure Integration', () => {
    it('fails closed with PAYER_SIGNATURE_INVALID when signature does not match canonical payload', async () => {
      const canonical = buildCanonicalInvoicePayload({
        invoiceId: '2002',
        payer: payerPublicKey,
        amount: '10000000',
      });
      // Signed with attacker keypair instead of declared payer
      const invalidSig = attackerKeypair.sign(Buffer.from(canonical, 'utf8')).toString('hex');

      appInstance = await createOracleApp({
        historyProvider: async () => getPayerHealthyHistory(),
        reputationProvider: async () => getPayerReputation(),
        requireKyb: false,
      });

      const res = await request(appInstance.app)
        .post('/v1/verify')
        .send({
          payer: payerPublicKey,
          invoiceId: '2002',
          amount: '10000000',
          payerSignature: invalidSig,
        });

      expect(res.status).toBe(200);
      expect(res.body.isVerified).toBe(false);
      expect(res.body.authorization.decision).toBe('deny');
      expect(res.body.authorization.primary).toBe('PAYER_SIGNATURE_INVALID');
      expect(res.body.fraudSignals.some((s: string) => s.includes('Payer signature invalid'))).toBe(
        true
      );
    });

    it('fails closed with PAYER_SIGNATURE_INVALID when requirePayerSignature is true and signature is omitted', async () => {
      appInstance = await createOracleApp({
        historyProvider: async () => getPayerHealthyHistory(),
        reputationProvider: async () => getPayerReputation(),
        requireKyb: false,
        requirePayerSignature: true,
      });

      const res = await request(appInstance.app)
        .post('/v1/verify')
        .send({
          payer: payerPublicKey,
          invoiceId: '2003',
          amount: '10000000',
        });

      expect(res.status).toBe(200);
      expect(res.body.isVerified).toBe(false);
      expect(res.body.authorization.decision).toBe('deny');
      expect(res.body.authorization.primary).toBe('PAYER_SIGNATURE_INVALID');
    });

    it.each(['Pending', 'Funded', 'Paid', 'Defaulted'] as InvoiceStatus[])(
      'rejects payer substitution in state %s with PAYER_SUBSTITUTION_REJECTED',
      async (status) => {
        const legitimatePayer = Keypair.random().publicKey();

        appInstance = await createOracleApp({
          historyProvider: async () => [makeHistoryEntry(3001, legitimatePayer, status)],
          reputationProvider: async () => makeReputation(Date.now(), { score: 95 }),
          requireKyb: false,
        });

        // Attacker attempts to verify existing invoice 3001 under attacker's public key
        const res = await request(appInstance.app)
          .post('/v1/verify')
          .send({
            payer: attackerKeypair.publicKey(),
            invoiceId: '3001',
            amount: '50000000',
          });

        expect(res.status).toBe(200);
        expect(res.body.isVerified).toBe(false);
        expect(res.body.authorization.decision).toBe('deny');
        expect(res.body.authorization.primary).toBe('PAYER_SUBSTITUTION_REJECTED');
        expect(
          res.body.fraudSignals.some((s: string) =>
            s.includes('Payer substitution rejected')
          )
        ).toBe(true);
      }
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 3: Replay / Restart Scenarios
  // ───────────────────────────────────────────────────────────────────────────
  describe('Replay / Restart Scenarios', () => {
    it('idempotently serves verified verdict across repeated requests', async () => {
      const canonical = buildCanonicalInvoicePayload({
        invoiceId: '4001',
        payer: payerPublicKey,
        amount: '10000000',
      });
      const sig = payerKeypair.sign(Buffer.from(canonical, 'utf8')).toString('hex');

      appInstance = await createOracleApp({
        historyProvider: async () => getPayerHealthyHistory(),
        reputationProvider: async () => getPayerReputation(),
        requireKyb: false,
      });

      const res1 = await request(appInstance.app)
        .post('/v1/verify')
        .send({
          payer: payerPublicKey,
          invoiceId: '4001',
          amount: '10000000',
          payerSignature: sig,
        });

      const res2 = await request(appInstance.app)
        .post('/v1/verify')
        .send({
          payer: payerPublicKey,
          invoiceId: '4001',
          amount: '10000000',
          payerSignature: sig,
        });

      expect(res1.body.isVerified).toBe(true);
      expect(res2.body.isVerified).toBe(true);
      expect(res2.body.authorization.decision).toBe('allow');
    });

    it('rejects replay of authentic signature when amount or invoice payload is modified', async () => {
      const originalCanonical = buildCanonicalInvoicePayload({
        invoiceId: '4002',
        payer: payerPublicKey,
        amount: '10000000',
      });
      const originalSig = payerKeypair.sign(Buffer.from(originalCanonical, 'utf8')).toString('hex');

      appInstance = await createOracleApp({
        historyProvider: async () => getPayerHealthyHistory(),
        reputationProvider: async () => getPayerReputation(),
        requireKyb: false,
      });

      // Attacker replays originalSig but requests a much higher amount
      const res = await request(appInstance.app)
        .post('/v1/verify')
        .send({
          payer: payerPublicKey,
          invoiceId: '4002',
          amount: '500000000',
          payerSignature: originalSig,
        });

      expect(res.body.isVerified).toBe(false);
      expect(res.body.authorization.decision).toBe('deny');
      expect(res.body.authorization.primary).toBe('PAYER_SIGNATURE_INVALID');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 4: Boundary Conditions
  // ───────────────────────────────────────────────────────────────────────────
  describe('Boundary Conditions', () => {
    it('supports snake_case parameters payer_signature and invoice_id seamlessly', async () => {
      const canonical = buildCanonicalInvoicePayload({
        invoiceId: '5001',
        payer: payerPublicKey,
        amount: '10000000',
      });
      const sig = payerKeypair.sign(Buffer.from(canonical, 'utf8')).toString('hex');

      appInstance = await createOracleApp({
        historyProvider: async () => getPayerHealthyHistory(),
        reputationProvider: async () => getPayerReputation(),
        requireKyb: false,
      });

      const res = await request(appInstance.app)
        .post('/v1/verify')
        .send({
          payer: payerPublicKey,
          invoice_id: '5001',
          amount: '10000000',
          payer_signature: sig,
        });

      expect(res.status).toBe(200);
      expect(res.body.isVerified).toBe(true);
      expect(res.body.authorization.decision).toBe('allow');
    });

    it('handles numeric string boundary invoice IDs without precision loss', async () => {
      const bigInvoiceId = '9007199254740991'; // MAX_SAFE_INTEGER
      const canonical = buildCanonicalInvoicePayload({
        invoiceId: bigInvoiceId,
        payer: payerPublicKey,
        amount: '10000000',
      });
      const sig = payerKeypair.sign(Buffer.from(canonical, 'utf8')).toString('hex');

      appInstance = await createOracleApp({
        historyProvider: async () => getPayerHealthyHistory(),
        reputationProvider: async () => getPayerReputation(),
        requireKyb: false,
      });

      const res = await request(appInstance.app)
        .post('/v1/verify')
        .send({
          payer: payerPublicKey,
          invoiceId: bigInvoiceId,
          amount: '10000000',
          payerSignature: sig,
        });

      expect(res.status).toBe(200);
      expect(res.body.invoiceId).toBe(bigInvoiceId);
      expect(res.body.isVerified).toBe(true);
    });
  });
});
