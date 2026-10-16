# Runbook: Payer Cryptographic Signature Verification

**Control:** `oracle-service/src/canonicalPayload.ts`, `oracle-service/src/verifier.ts`
**Test:** `oracle-service/src/canonicalPayload.test.ts`, `oracle-service/src/payerVerificationGates.test.ts`
**Origin:** Issue #1228 (wave-9)
**Owner:** `oracle-team` / `smart-contract-sync`

---

## Purpose

Enforces fail-closed cryptographic verification of payer signatures against canonical invoice payloads in the Oracle Service. Prevents unauthorized verification requests, payload tampering (e.g. modified amount or invoice identifier), and unauthorized third-party submissions.

## Rules & Invariants

| Rule | Description |
|---|---|
| `canonical-serialization` | Payloads must serialize deterministically into `ILN:INVOICE_AUTH:<invoiceId>:<payer>:<amount>`. |
| `ed25519-verification` | Stellar Keypair verifies 64-byte Ed25519 signatures (hex or base64) against the canonical UTF-8 payload. |
| `fail-closed-policy` | If signature verification fails or signature is corrupted/missing when required, the verdict evaluates to `isVerified: false` with taxonomy code `PAYER_SIGNATURE_INVALID`. |
| `audit-logging` | All denials emit structured logs with event `oracle.payer_authorization.denied` and record Prometheus counters. |

## Operational Evidence & Metrics

- **Structured Log:** `{"event":"oracle.payer_authorization.denied","stage":"verdict","code":"PAYER_SIGNATURE_INVALID","payer":"...","invoiceId":"..."}`
- **Prometheus Metric:** `oracle_payer_authorization_failures_total{code="PAYER_SIGNATURE_INVALID",category="policy"}`
- **Decisions Metric:** `oracle_payer_authorization_decisions_total{decision="deny",stage="verdict"}`

## Operational Commands

```bash
# Run unit tests covering canonical serialization and signature verification
npx pnpm --filter @iln/oracle-service test src/canonicalPayload.test.ts

# Run end-to-end HTTP integration tests
npx pnpm --filter @iln/oracle-service test src/payerVerificationGates.test.ts
```

## Remediation & Recovery

1. **Investigate Log Event**:
   Search logs for `event: "oracle.payer_authorization.denied"` with `code: "PAYER_SIGNATURE_INVALID"`.
2. **Inspect Payload & Signature**:
   Check if the client passed `payerSignature` or `payer_signature`. Verify the signing keypair matches the declared `payer` public key (`G...`, 56 characters).
3. **Verify Canonical Format**:
   Ensure the invoice parameters (`invoiceId`, `payer`, `amount`) match the canonical format `ILN:INVOICE_AUTH:<invoiceId>:<payer>:<amount>`.
