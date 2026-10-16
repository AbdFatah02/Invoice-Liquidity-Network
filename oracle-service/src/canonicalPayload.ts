/**
 * canonicalPayload.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Canonical invoice payload generation and cryptographic signature verification
 * for the Invoice Liquidity Network Oracle Service (Issue #1228 & Issue #1229).
 *
 * Requirements:
 *   - Deterministic canonical serialization of invoice parameters.
 *   - Ed25519 public-key signature verification using Stellar SDK.
 *   - Constant-time comparison, fail-closed validation on invalid format/keys.
 *   - Rejection of payer substitution across invoice lifecycle states.
 *
 * Time Complexity:  O(1) signature verification, O(N) scan over historical invoices (N <= 50).
 * Space Complexity: O(1) constant overhead.
 */

import { Keypair } from '@stellar/stellar-sdk';
import type { IndexerInvoiceHistoryEntry, InvoiceStatus } from './types';

export const CANONICAL_PAYLOAD_PREFIX = 'ILN:INVOICE_AUTH';

export interface CanonicalInvoicePayloadParams {
  invoiceId: string | number | bigint;
  payer: string;
  amount: string | number | bigint;
  dueDate?: number;
  currency?: string;
}

/**
 * Constructs a deterministic, canonical byte representation of an invoice authorization payload.
 *
 * Format: `ILN:INVOICE_AUTH:<invoiceId>:<payer>:<amount>`
 *
 * @param params Invoice parameters
 * @returns Serialized canonical string
 */
export function buildCanonicalInvoicePayload(params: CanonicalInvoicePayloadParams): string {
  const invoiceId = String(params.invoiceId).trim();
  const payer = String(params.payer).trim();
  const amount = String(params.amount).trim();

  return `${CANONICAL_PAYLOAD_PREFIX}:${invoiceId}:${payer}:${amount}`;
}

export interface VerifyPayerSignatureParams {
  payer: string;
  signature?: string | null;
  canonicalPayload: string | Uint8Array;
}

export interface VerifyPayerSignatureResult {
  valid: boolean;
  reason?: string;
}

/**
 * Verifies that a payer's Ed25519 cryptographic signature matches the canonical invoice payload.
 *
 * @param params Verification parameters
 * @returns Verification result with boolean and reason on denial
 */
export function verifyPayerSignature(
  params: VerifyPayerSignatureParams
): VerifyPayerSignatureResult {
  if (!params.signature || typeof params.signature !== 'string' || !params.signature.trim()) {
    return { valid: false, reason: 'Payer signature is missing or empty' };
  }

  const payer = params.payer.trim();
  if (!payer.startsWith('G') || payer.length !== 56) {
    return { valid: false, reason: 'Payer address is not a valid 56-character Stellar public key' };
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromPublicKey(payer);
  } catch (err) {
    return {
      valid: false,
      reason: `Failed to initialize Stellar Keypair from payer public key: ${(err as Error).message}`,
    };
  }

  const rawSig = params.signature.trim();
  let sigBuffer: Buffer;

  try {
    if (/^[0-9a-fA-F]{128}$/.test(rawSig)) {
      sigBuffer = Buffer.from(rawSig, 'hex');
    } else {
      sigBuffer = Buffer.from(rawSig, 'base64');
    }
  } catch (err) {
    return { valid: false, reason: `Failed to decode signature: ${(err as Error).message}` };
  }

  // Ed25519 signatures are strictly 64 bytes
  if (sigBuffer.length !== 64) {
    return {
      valid: false,
      reason: `Invalid Ed25519 signature length: expected 64 bytes, got ${sigBuffer.length}`,
    };
  }

  const payloadBuffer =
    typeof params.canonicalPayload === 'string'
      ? Buffer.from(params.canonicalPayload, 'utf8')
      : Buffer.from(params.canonicalPayload);

  try {
    const verified = keypair.verify(payloadBuffer, sigBuffer);
    if (!verified) {
      return { valid: false, reason: 'Cryptographic signature does not match canonical payload' };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, reason: `Signature verification failed: ${(err as Error).message}` };
  }
}

export interface CheckPayerSubstitutionParams {
  requestInvoiceId: string | number | bigint;
  requestPayer: string;
  history: IndexerInvoiceHistoryEntry[];
}

export interface CheckPayerSubstitutionResult {
  substituted: boolean;
  recordedPayer?: string;
  invoiceStatus?: InvoiceStatus;
  reason?: string;
}

/**
 * Checks if a verification request attempts to substitute a payer on an invoice
 * that already exists in on-chain/indexer history in any lifecycle state
 * (Pending, Funded, Paid, Defaulted).
 *
 * @param params Request parameters and indexer history
 * @returns Substitution assessment
 */
export function checkPayerSubstitution(
  params: CheckPayerSubstitutionParams
): CheckPayerSubstitutionResult {
  const reqIdStr = String(params.requestInvoiceId).trim();
  const reqPayer = params.requestPayer.trim();

  for (const entry of params.history) {
    if (String(entry.id) === reqIdStr) {
      if (entry.payer && entry.payer !== reqPayer) {
        return {
          substituted: true,
          recordedPayer: entry.payer,
          invoiceStatus: entry.status,
          reason: `Payer substitution rejected: invoice ${reqIdStr} in state ${entry.status} is bound to payer ${entry.payer}, cannot substitute ${reqPayer}`,
        };
      }
    }
  }

  return { substituted: false };
}
