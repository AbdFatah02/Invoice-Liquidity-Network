import { describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import {
  CANONICAL_PAYLOAD_PREFIX,
  buildCanonicalInvoicePayload,
  checkPayerSubstitution,
  verifyPayerSignature,
} from './canonicalPayload';
import type { IndexerInvoiceHistoryEntry, InvoiceStatus } from './types';

describe('Canonical Invoice Payload & Cryptographic Signature Verification (Issues #1228, #1229)', () => {
  const payerKeypair = Keypair.random();
  const payerPublicKey = payerKeypair.publicKey();
  const otherKeypair = Keypair.random();

  const validInvoiceParams = {
    invoiceId: '1001',
    payer: payerPublicKey,
    amount: '50000000',
  };

  const canonicalPayload = buildCanonicalInvoicePayload(validInvoiceParams);
  const validSignatureBuffer = payerKeypair.sign(Buffer.from(canonicalPayload, 'utf8'));
  const validHexSignature = validSignatureBuffer.toString('hex');
  const validBase64Signature = validSignatureBuffer.toString('base64');

  function makeHistoryEntry(
    id: number,
    payer: string,
    status: InvoiceStatus
  ): IndexerInvoiceHistoryEntry {
    return {
      id,
      freelancer: 'GCLWGQPMKXQSPF776IU33AH4PZNOOWNAWGGCD6ABCDEF1234567890AB',
      payer,
      amount: '50000000',
      due_date: Math.floor(Date.now() / 1000) + 86400 * 30,
      discount_rate: 300,
      status,
      created_at: Date.now() - 3600000,
      updated_at: Date.now(),
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 1: Success Conditions
  // ───────────────────────────────────────────────────────────────────────────
  describe('Success Conditions', () => {
    it('generates a deterministic canonical payload matching the protocol specification', () => {
      const payload = buildCanonicalInvoicePayload(validInvoiceParams);
      expect(payload).toBe(`${CANONICAL_PAYLOAD_PREFIX}:1001:${payerPublicKey}:50000000`);
    });

    it('verifies a valid Ed25519 signature formatted as hex', () => {
      const result = verifyPayerSignature({
        payer: payerPublicKey,
        signature: validHexSignature,
        canonicalPayload,
      });
      expect(result).toEqual({ valid: true });
    });

    it('verifies a valid Ed25519 signature formatted as base64', () => {
      const result = verifyPayerSignature({
        payer: payerPublicKey,
        signature: validBase64Signature,
        canonicalPayload,
      });
      expect(result).toEqual({ valid: true });
    });

    it('verifies signature when canonicalPayload is passed as Uint8Array buffer', () => {
      const result = verifyPayerSignature({
        payer: payerPublicKey,
        signature: validHexSignature,
        canonicalPayload: Buffer.from(canonicalPayload, 'utf8'),
      });
      expect(result).toEqual({ valid: true });
    });

    it('allows invoice verification when invoiceId does not exist in historical entries', () => {
      const history = [
        makeHistoryEntry(999, payerPublicKey, 'Paid'),
        makeHistoryEntry(1000, payerPublicKey, 'Funded'),
      ];
      const result = checkPayerSubstitution({
        requestInvoiceId: '1001',
        requestPayer: payerPublicKey,
        history,
      });
      expect(result.substituted).toBe(false);
    });

    it('allows invoice verification when invoiceId matches history and payer is identical', () => {
      const history = [makeHistoryEntry(1001, payerPublicKey, 'Pending')];
      const result = checkPayerSubstitution({
        requestInvoiceId: '1001',
        requestPayer: payerPublicKey,
        history,
      });
      expect(result.substituted).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 2: Failure Conditions
  // ───────────────────────────────────────────────────────────────────────────
  describe('Failure Conditions', () => {
    it('fails closed when signature does not match canonical payload', () => {
      const corruptedSig = Buffer.from(validSignatureBuffer);
      corruptedSig[0] ^= 0xff; // flip bits
      const result = verifyPayerSignature({
        payer: payerPublicKey,
        signature: corruptedSig.toString('hex'),
        canonicalPayload,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Cryptographic signature does not match canonical payload');
    });

    it('fails closed when signature was signed by a different keypair', () => {
      const otherSig = otherKeypair.sign(Buffer.from(canonicalPayload, 'utf8')).toString('hex');
      const result = verifyPayerSignature({
        payer: payerPublicKey,
        signature: otherSig,
        canonicalPayload,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Cryptographic signature does not match canonical payload');
    });

    it('fails closed when canonical payload is altered (tampered amount)', () => {
      const tamperedPayload = buildCanonicalInvoicePayload({
        ...validInvoiceParams,
        amount: '999999999',
      });
      const result = verifyPayerSignature({
        payer: payerPublicKey,
        signature: validHexSignature,
        canonicalPayload: tamperedPayload,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Cryptographic signature does not match canonical payload');
    });

    it('fails closed on missing or empty signature', () => {
      expect(
        verifyPayerSignature({ payer: payerPublicKey, signature: '', canonicalPayload }).valid
      ).toBe(false);
      expect(
        verifyPayerSignature({ payer: payerPublicKey, signature: undefined, canonicalPayload }).valid
      ).toBe(false);
    });

    it('fails closed on malformed signature encoding or invalid byte length', () => {
      const result = verifyPayerSignature({
        payer: payerPublicKey,
        signature: 'deadbeef', // only 4 bytes, not 64
        canonicalPayload,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Invalid Ed25519 signature length');
    });

    it('fails closed on invalid Stellar address format', () => {
      const result = verifyPayerSignature({
        payer: 'INVALID_STELLAR_ADDRESS',
        signature: validHexSignature,
        canonicalPayload,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Payer address is not a valid 56-character Stellar public key');
    });

    it.each(['Pending', 'Funded', 'Paid', 'Defaulted'] as InvoiceStatus[])(
      'rejects payer substitution across invoice lifecycle state: %s',
      (status) => {
        const recordedPayer = otherKeypair.publicKey();
        const history = [makeHistoryEntry(1001, recordedPayer, status)];

        const result = checkPayerSubstitution({
          requestInvoiceId: '1001',
          requestPayer: payerPublicKey,
          history,
        });

        expect(result.substituted).toBe(true);
        expect(result.recordedPayer).toBe(recordedPayer);
        expect(result.invoiceStatus).toBe(status);
        expect(result.reason).toContain(
          `Payer substitution rejected: invoice 1001 in state ${status} is bound to payer ${recordedPayer}, cannot substitute ${payerPublicKey}`
        );
      }
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 3: Replay / Restart Scenarios
  // ───────────────────────────────────────────────────────────────────────────
  describe('Replay / Restart Scenarios', () => {
    it('is strictly deterministic across multiple repeated verification calls', () => {
      for (let i = 0; i < 5; i++) {
        const result = verifyPayerSignature({
          payer: payerPublicKey,
          signature: validHexSignature,
          canonicalPayload,
        });
        expect(result.valid).toBe(true);
      }
    });

    it('rejects replaying a valid signature from one invoice onto a different invoiceId', () => {
      const replayPayload = buildCanonicalInvoicePayload({
        ...validInvoiceParams,
        invoiceId: '1002', // replaying signature for 1001 onto 1002
      });
      const result = verifyPayerSignature({
        payer: payerPublicKey,
        signature: validHexSignature,
        canonicalPayload: replayPayload,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Cryptographic signature does not match canonical payload');
    });

    it('maintains consistent substitution detection across restored history snapshots', () => {
      const history = [makeHistoryEntry(1001, otherKeypair.publicKey(), 'Funded')];
      // Simulate multiple restarts / cache lookups with the same history snapshot
      const res1 = checkPayerSubstitution({
        requestInvoiceId: '1001',
        requestPayer: payerPublicKey,
        history,
      });
      const res2 = checkPayerSubstitution({
        requestInvoiceId: '1001',
        requestPayer: payerPublicKey,
        history,
      });
      expect(res1).toEqual(res2);
      expect(res1.substituted).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 4: Boundary Conditions
  // ───────────────────────────────────────────────────────────────────────────
  describe('Boundary Conditions', () => {
    it('handles numeric 0, BigInt, and string numeric invoice IDs consistently', () => {
      const p1 = buildCanonicalInvoicePayload({ invoiceId: 0, payer: payerPublicKey, amount: 0 });
      const p2 = buildCanonicalInvoicePayload({
        invoiceId: '0',
        payer: payerPublicKey,
        amount: '0',
      });
      const p3 = buildCanonicalInvoicePayload({
        invoiceId: 0n,
        payer: payerPublicKey,
        amount: 0n,
      });
      expect(p1).toBe(p2);
      expect(p2).toBe(p3);
      expect(p1).toBe(`${CANONICAL_PAYLOAD_PREFIX}:0:${payerPublicKey}:0`);
    });

    it('handles maximum Safe Integer and huge BigInt amount representations without overflow', () => {
      const maxInt = Number.MAX_SAFE_INTEGER;
      const bigAmount = '18446744073709551615'; // 2^64 - 1
      const payload = buildCanonicalInvoicePayload({
        invoiceId: maxInt,
        payer: payerPublicKey,
        amount: bigAmount,
      });
      expect(payload).toBe(`${CANONICAL_PAYLOAD_PREFIX}:${maxInt}:${payerPublicKey}:${bigAmount}`);
    });

    it('trims leading/trailing whitespace around parameters', () => {
      const payload = buildCanonicalInvoicePayload({
        invoiceId: '  1001  ',
        payer: `  ${payerPublicKey}  `,
        amount: '  50000000  ',
      });
      expect(payload).toBe(`${CANONICAL_PAYLOAD_PREFIX}:1001:${payerPublicKey}:50000000`);
    });

    it('handles empty history list gracefully', () => {
      const result = checkPayerSubstitution({
        requestInvoiceId: '1001',
        requestPayer: payerPublicKey,
        history: [],
      });
      expect(result.substituted).toBe(false);
    });

    it('correctly scans history list with many entries in O(N) time', () => {
      const history: IndexerInvoiceHistoryEntry[] = [];
      for (let i = 0; i < 50; i++) {
        history.push(makeHistoryEntry(i, payerPublicKey, 'Paid'));
      }
      // Entry 25 substituted
      history[25] = makeHistoryEntry(25, otherKeypair.publicKey(), 'Funded');

      const result = checkPayerSubstitution({
        requestInvoiceId: 25,
        requestPayer: payerPublicKey,
        history,
      });
      expect(result.substituted).toBe(true);
      expect(result.invoiceStatus).toBe('Funded');
      expect(result.recordedPayer).toBe(otherKeypair.publicKey());
    });
  });
});
