# SDK Migration Guide

This guide details the steps required to upgrade your application between
versions of the stable **`@iln/sdk`** package. This migration guide covers
the current stable package only. Every code example below was checked against
the latest release and is accurate for that package.

> **Note:** `@iln/sdk-next` is a separate experimental package with a different API surface. For migrating between `@iln/sdk` and `@iln/sdk-next`, see the [SDK vs SDK-next Migration Guide](sdk-next-migration.md).

> **Compatibility:** See [SDK Compatibility Matrix](SDK_COMPATIBILITY_MATRIX.md) for supported dependency versions.

### Package name: `@invoice-liquidity/sdk` → `@iln/sdk` <!-- sdk-name-check: allow-legacy -->

Older docs and examples called this package `@invoice-liquidity/sdk`. <!-- sdk-name-check: allow-legacy -->
The package in `sdk/` has always been named **`@iln/sdk`**, and that is the
only name this repository releases. The exports are the same, so migrating
means changing the specifier and nothing else:

```diff
- "@invoice-liquidity/sdk": "^0.1.0"      // sdk-name-check: allow-legacy
+ "@iln/sdk": "^0.1.0"
```

```diff
- import { ILNSdk, ILN_TESTNET } from "@invoice-liquidity/sdk"; // sdk-name-check: allow-legacy
+ import { ILNSdk, ILN_TESTNET } from "@iln/sdk";
```

Also update any `pnpm --filter`, bundler `external`/`alias`, or
`paths` entries that use the old name. A filter on the old name matches no
package and pnpm still exits 0, so the command does nothing and reports
success. `@iln/react` declares `@iln/sdk` (`^0.1.0`) as a **peer**
dependency: install it alongside `@iln/react` in your app.

CI enforces the canonical names with `scripts/check-sdk-package-names.mjs`.
See [runbooks/sdk-package-names.md](runbooks/sdk-package-names.md).

---

## Overview of Breaking Changes

The latest release introduces several enhancements to improve type safety, handle decimals without precision loss, manage offline transactions, and catch errors predictably.

| Feature | Change Type | Impact |
|:---|:---|:---|
| **Invoice Status Types** | Breaking | `invoice.status` has transitioned from a raw string to a TypeScript `InvoiceStatus` enum. |
| **Error Handling** | Breaking | The SDK now throws specific typed errors inheriting from `ILNError` instead of generic `Error` objects. |
| **Amounts & Precision** | Non-Breaking / Recommended | Introduction of `BigAmount` precision utility class for handling USDC/EURC 7-decimal transformations. |
| **Caching Layer** | Breaking | Caching is now enabled by default (60s TTL). Applications requiring bypass must explicitly configure the client. |
| **REST API / SSE** | Breaking | Endpoints inside the indexer and SSE streams now default to versioned `/v1/` routes. |

---

## Upgrade Steps

Follow these steps to upgrade your project:

### Step 1: Update Dependencies
Update `@iln/sdk` and (if using React) `@iln/react` in your `package.json`:

```bash
# Using npm
npm install @iln/sdk@latest @iln/react@latest

# Using pnpm
pnpm add @iln/sdk@latest @iln/react@latest

# Using yarn
yarn add @iln/sdk@latest @iln/react@latest
```

### Step 2: Refactor Status String Checks
Replace any hardcoded string comparisons against `invoice.status` with the new `InvoiceStatus` enum or helper predicates (`isPending`, `isFunded`, `isPaid`, `isDefaulted`, `isDisputed`, `isTerminal`).

### Step 3: Refactor Error Catch Blocks
Update your `try/catch` statements to intercept structured error classes rather than inspecting generic error messages.

### Step 4: Configure Cache Behavior (Optional)
If your application depends on immediate on-chain reading without caching, disable caching in the constructor:

```ts
const sdk = new ILNSdk({
  ...ILN_TESTNET,
  cache: { enabled: false }, // Disable cache to force on-chain RPC reads
});
```

---

## Code Examples

### 1. Invoice Status Checks

**Before (v0.1.0):**
```ts
const invoice = await sdk.getInvoice(invoiceId);

if (invoice.status === 'Paid') {
  console.log('Payment completed');
} else if (invoice.status === 'Funded') {
  console.log('Funding completed');
}
```

**After (v1.0.0):**
```ts
import { InvoiceStatus, isPaid, isFunded } from '@iln/sdk';

const invoice = await sdk.getInvoice(invoiceId);

// Option A: Use Helper Predicates (Recommended)
if (isPaid(invoice.status)) {
  console.log('Payment completed');
} else if (isFunded(invoice.status)) {
  console.log('Funding completed');
}

// Option B: Compare with InvoiceStatus Enum
if (invoice.status === InvoiceStatus.Paid) {
  console.log('Payment completed');
}
```

---

### 2. Error Handling

**Before (v0.1.0):**
```ts
try {
  await sdk.submitInvoice(params);
} catch (error: any) {
  if (error.message.includes('Insufficient balance')) {
    alert('You need more funds.');
  } else {
    alert('Something went wrong: ' + error.message);
  }
}
```

**After (v1.0.0):**
```ts
import { InsufficientBalanceError, ValidationError, ILNError } from '@iln/sdk';

try {
  await sdk.submitInvoice(params);
} catch (error) {
  if (error instanceof InsufficientBalanceError) {
    alert('You need more funds.');
  } else if (error instanceof ValidationError) {
    alert('Invalid inputs: ' + error.message);
  } else if (error instanceof ILNError) {
    alert('ILN Protocol error: ' + error.message);
  } else {
    alert('Unknown error occurred');
  }
}
```

---

### 3. Precision & Decimal Amounts

**Before (v0.1.0):**
```ts
// Risk of floating point issues: e.g. 10.15 USDC
const rawAmount = 10.15;
const amount = BigInt(Math.floor(rawAmount * 10_000_000)); // 101500000n
```

**After (v1.0.0):**
```ts
import { BigAmount } from '@iln/sdk';

// Safe 7-decimal parsing without floating point inaccuracies
const amount = BigAmount.fromNumber(10.15, 7).toBigInt(); // 101500000n
```

---

## Testing Checklist

After implementing the code upgrades, run these tests to verify functionality:

- [ ] **Typecheck compilation**: Verify typescript compiler output passes without warnings:
  ```bash
  npx tsc --noEmit
  ```
- [ ] **Invoice Lifecycle Flows**:
  - [ ] Submit invoice (signed by freelancer) and verify status is `InvoiceStatus.Pending`.
  - [ ] Fund invoice (signed by LP) and verify status is `InvoiceStatus.Funded`.
  - [ ] Mark paid (signed by payer) and verify status is `InvoiceStatus.Paid`.
- [ ] **Error Path Validation**: Trigger invalid due dates or empty addresses to confirm `ValidationError` is thrown and handled cleanly by your UI.
- [ ] **Wallet Connection Recovery**: Disconnect Freighter wallet to ensure `WalletNotConnectedError` is thrown during transaction submission.
- [ ] **SSE Live Stream Events**: Listen to invoice updates using `subscribeToInvoice` and check that callbacks receive versioned event streams correctly.

---

## Rollback Instructions

If you run into issues in production and need to revert back immediately, follow these steps:

1. **Revert package installations**:
   Downgrade the SDK versions to the previous working release:
   ```bash
   pnpm add @iln/sdk@0.1.0 @iln/react@0.1.0
   ```
2. **Revert status enum code**:
   Change `InvoiceStatus` enum and predicate checks back to raw string comparisons (e.g. `=== "Paid"`).
3. **Revert error-catching types**:
   Convert specific catch conditions (e.g. `instanceof InsufficientBalanceError`) back to generic `error.message` check logic.
4. **Rebuild & Redeploy**:
   Clean up cached packages and rebuild:
   ```bash
   pnpm run build
   ```
