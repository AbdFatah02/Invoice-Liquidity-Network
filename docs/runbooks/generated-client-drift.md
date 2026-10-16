# Runbook: Generated-Client Drift Detection

**Control:** `scripts/check-sdk-client-drift.mjs`
**Test:** `scripts/__tests__/check-sdk-client-drift.test.mjs`
**Gating Integration:** `scripts/check-sdk-release-gates.mjs`
**Origin:** Issue #1209 (wave-9)
**Owner:** `sdk-core`

---

## Purpose

Detects and prevents drift between the Soroban smart contract ABI specifications and the generated client types in `@iln/sdk` (`sdk/src/generated/types.ts`). Ensures that SDK releases never ship with stale or mismatched contract error codes, structs, or entry points.

## Rules & Invariants

| Rule | Description |
|---|---|
| `generated-file-exists` | `sdk/src/generated/types.ts` must exist on disk. |
| `autogen-header` | The file must contain valid auto-generated header directives and regeneration commands. |
| `spec-hash-integrity` | If `backend/target/spec.json` is present, the spec hash in the generated file must match the SHA-256 hash of the spec. |
| `contract-error-contract` | The `ContractError` enum must define all 10 canonical error codes matching the contract (`InvoiceNotFound`, `AlreadyFunded`, `AlreadyPaid`, `NotFunder`, `NotPayer`, `NotDueYet`, `InvalidAmount`, `InvalidDiscount`, `InvalidDueDate`, `Unauthorized`). |
| `sdk-export-contract` | `sdk/src/index.ts` must re-export `ContractError` from `./generated/types`. |

## Operational Commands

```bash
# Run standalone generated-client drift detection
node scripts/check-sdk-client-drift.mjs

# Export machine-readable report
node scripts/check-sdk-client-drift.mjs --json=artifacts/sdk-client-drift.json

# Run release gates verification (includes client drift gate)
node scripts/check-sdk-release-gates.mjs

# Run regression test suite
node --test scripts/__tests__/check-sdk-client-drift.test.mjs
```

## Remediation

1. When `spec-hash-integrity` fails:
   The smart contract spec in `backend/target/spec.json` has changed. Re-run type generation:
   ```bash
   pnpm generate:types
   ```
2. When `contract-error-contract` fails:
   Verify that all contract error definitions in `ILN-Smart-Contract` are reflected in the generator template in `scripts/generate-types.ts` and regenerate.
