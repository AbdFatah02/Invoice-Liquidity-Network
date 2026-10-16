# Runbook: Payer Substitution Rejection Across Lifecycle States

**Control:** `oracle-service/src/canonicalPayload.ts`, `oracle-service/src/verifier.ts`
**Test:** `oracle-service/src/canonicalPayload.test.ts`, `oracle-service/src/payerVerificationGates.test.ts`
**Origin:** Issue #1229 (wave-9)
**Owner:** `oracle-team` / `smart-contract-sync`

---

## Purpose

Enforces payer immutability across the entire invoice lifecycle. Once an invoice ID exists in on-chain or indexer history in any state (`Pending`, `Funded`, `Paid`, or `Defaulted`), any verification request attempting to associate a different payer public key with that invoice ID is rejected fail-closed.

## Rules & Invariants

| Rule | Description |
|---|---|
| `payer-immutability` | An invoice's payer cannot change once created. Every historical record binds `invoiceId` to its original `payer`. |
| `lifecycle-coverage` | Substitution rejection applies across all four states: `Pending`, `Funded`, `Paid`, `Defaulted`. |
| `fail-closed-taxonomy` | Attempts to substitute the payer yield `isVerified: false` with taxonomy code `PAYER_SUBSTITUTION_REJECTED`. |
| `audit-attribution` | Denial events are logged with structured JSON containing the attempted substitute payer and invoice ID. |

## Operational Evidence & Metrics

- **Structured Log:** `{"event":"oracle.payer_authorization.denied","stage":"verdict","code":"PAYER_SUBSTITUTION_REJECTED","payer":"...","invoiceId":"..."}`
- **Prometheus Metric:** `oracle_payer_authorization_failures_total{code="PAYER_SUBSTITUTION_REJECTED",category="policy"}`
- **Decisions Metric:** `oracle_payer_authorization_decisions_total{decision="deny",stage="verdict"}`

## Operational Commands

```bash
# Run unit tests covering substitution rejection across lifecycle states
npx pnpm --filter @iln/oracle-service test src/canonicalPayload.test.ts

# Run end-to-end HTTP integration tests
npx pnpm --filter @iln/oracle-service test src/payerVerificationGates.test.ts
```

## Remediation & Recovery

1. **Identify Attempted Substitution**:
   Filter logs for `code: "PAYER_SUBSTITUTION_REJECTED"`. The log entry notes both the attempted payer and the recorded on-chain payer.
2. **Review On-Chain State**:
   Query indexer or Soroban RPC for the invoice state. If the invoice was previously issued or funded by another payer, the request is illegitimate and correctly blocked.
3. **Correct Request Parameters**:
   If legitimate, ensure the verification client submits the actual recorded payer public key rather than a mediator or surrogate address.
