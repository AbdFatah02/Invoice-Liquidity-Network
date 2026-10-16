# Runbook: Example SDK Resolution

**Control:** `scripts/check-example-sdk-resolution.mjs`
**Test:** `scripts/__tests__/check-example-sdk-resolution.test.mjs`
**Origin:** Issue #1214 (wave-9)
**Owner:** `frontend-platform`

---

## Purpose

Ensures consumer examples—specifically `examples/javascript-example` and other sample apps—consistently resolve the canonical `@iln/sdk` package without encountering `MODULE_NOT_FOUND` errors, path drift, or broken runtime contracts.

## Rules & Invariants

| Rule | Description |
|---|---|
| `manifest-integrity` | `sdk/package.json` must be present, carry canonical name `@iln/sdk`, and define valid exports. |
| `exports-contract` | `sdk/package.json` must export `.` pointing to modern ESM and CommonJS bundles. |
| `example-dependency` | Every example package manifest must declare `@iln/sdk` under its canonical name. |
| `resolution-path` | `file:` and `link:` dependency specifiers must resolve directly to the valid SDK root. |
| `symbol-contract` | The resolved SDK must export core runtime symbols: `ILNSdk`, `ILN_TESTNET`, `createKeypairSigner`, `SDK_VERSION`. |

## Operational Commands

```bash
# Run the example SDK resolution verification
node scripts/check-example-sdk-resolution.mjs

# Emit machine-readable JSON report
node scripts/check-example-sdk-resolution.mjs --json=artifacts/example-sdk-resolution.json

# Run automated regression tests
node --test scripts/__tests__/check-example-sdk-resolution.test.mjs
```

## Remediation

1. If an example fails with `example-dependency`:
   Ensure `package.json` specifies `"@iln/sdk": "file:../../sdk"` (or workspace specifier), not legacy package names.
2. If an example fails with `resolution-path`:
   Verify the relative path resolves directly to the `sdk/` directory.
3. If an example fails with `symbol-contract`:
   Verify that `sdk/src/index.ts` exports all required symbols (`ILNSdk`, `ILN_TESTNET`, `createKeypairSigner`, `SDK_VERSION`).
