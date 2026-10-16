# Step-by-Step Migration Guide: `@iln/sdk` to `@iln/sdk-next`

This document details the step-by-step migration path from the legacy SDK (`@iln/sdk` located in `sdk/`) to the modular, browser-first SDK rewrite (`@iln/sdk-next` located in `packages/sdk/`).

> [!NOTE]
> `@iln/sdk-next` is the experimental, modular/browser-first rewrite focused on bundle footprint reduction, native Web Crypto API support, and zero Node.js polyfills for modern browser environments.

---

## Architectural & API Differences

| Category | `@iln/sdk` (`sdk/`) | `@iln/sdk-next` (`packages/sdk/`) |
| :--- | :--- | :--- |
| **Main Class** | `ILNSdk` | `InvoiceClient` |
| **Target Runtime** | Node.js + Browser polyfills | Browser-first (Web Crypto) + Node.js ES Modules |
| **Browser Bundle** | Transpiled CJS/ESM | Dedicated `dist/browser/index.js` via Vite |
| **Cryptography** | Node.js `crypto` | Web Crypto API (`crypto.subtle`, `crypto.getRandomValues`) |
| **Method Signature Style** | Options object (`{ freelancer, payer, ... }`) | Structured positional & typed parameter objects |
| **Error Handling** | Class-based `ILNError` hierarchy | Normalized `ILNError` with error codes |

---

## Find-and-Replace / Codemod Quick Reference

| Legacy `@iln/sdk` Pattern | New `@iln/sdk-next` Pattern | Notes |
| :--- | :--- | :--- |
| `import { ILNSdk } from '@iln/sdk'` | `import { InvoiceClient } from '@iln/sdk-next'` | Renamed client export |
| `new ILNSdk({ ...ILN_TESTNET })` | `new InvoiceClient({ contractId, rpcUrl, horizonUrl, signer })` | Config-object constructor is preferred; a legacy `(serverUrl, contractId, options?)` positional form is also supported for transaction-history-only usage |
| `sdk.submitInvoice({ freelancer, payer, amount, dueDate, discountRate })` | `client.submitInvoice({ freelancer, payer, amount, dueDate, discountRate, token })` | `token` (the funding token's contract ID) is a **required** field on `sdk-next`; `freelancer` is optional and defaults to the configured signer's address |
| `sdk.fundInvoice({ funder, invoiceId })` | `client.fundInvoice(invoiceId, amount?)` | The second positional argument is an **optional funding amount**, not the funder address — `funder` defaults to the configured signer and can only be overridden via the object form `fundInvoice({ invoiceId, funder, amount })` |
| `sdk.getInvoice(invoiceId)` | `client.getInvoice(invoiceId)` | Returns typed `Invoice`; does not require a `signer` |

> This table was audited against `packages/sdk/src/clients/InvoiceClient.ts`
> on 2026-08-25 to correct two prior inaccuracies: `token` was missing from
> the `submitInvoice` example, and `fundInvoice`'s second argument was
> documented as the funder address when it is actually an optional funding
> amount.

---

## Runnable Before & After Examples

### 1. Submit Invoice

**Before (`@iln/sdk`):**
```typescript
import { ILNSdk, ILN_TESTNET, createFreighterSigner } from '@iln/sdk';

const sdk = new ILNSdk({
  ...ILN_TESTNET,
  signer: createFreighterSigner(),
});

const invoiceId = await sdk.submitInvoice({
  freelancer: 'GBRPYHIL2CI3FNQ4BXLFMNDLFIMTXHRGY2TEWLYYACGNDWDRV4TVTBU5',
  payer: 'GA2C5RFPE6GCKMY3US5PAB4BO4FRGSRTCMGV35EOWFCG3LXDTR27TMZG',
  amount: 25_000_000n,
  dueDate: Math.floor(Date.now() / 1000) + 604800,
  discountRate: 300,
});
console.log('Submitted invoice ID:', invoiceId);
```

**After (`@iln/sdk-next`):**
```typescript
import { InvoiceClient } from '@iln/sdk-next';

const client = new InvoiceClient({
  contractId: 'CA3D26RZE4CJGDWIDVRWS5PGAEV7R3Y5QG5W2VDJ3CQ626FJG5423F7E',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  horizonUrl: 'https://horizon-testnet.stellar.org',
  signer, // required for writes; freelancer defaults to signer.getPublicKey()
});

const { invoiceId } = await client.submitInvoice({
  payer: 'GA2C5RFPE6GCKMY3US5PAB4BO4FRGSRTCMGV35EOWFCG3LXDTR27TMZG',
  amount: 25_000_000n,
  dueDate: Math.floor(Date.now() / 1000) + 604800,
  discountRate: 300,
  token: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC', // required
});
console.log('Submitted invoice ID:', invoiceId);
```

---

### 2. Fund Invoice

**Before (`@iln/sdk`):**
```typescript
import { ILNSdk, ILN_TESTNET } from '@iln/sdk';

const sdk = new ILNSdk({ ...ILN_TESTNET });

await sdk.fundInvoice({
  funder: 'GC3KW5E4ZJ4Z627FJG5423F7ECA3D26RZE4CJGDWIDVRWS5PGAEV7R3Y',
  invoiceId: 1n,
});
```

**After (`@iln/sdk-next`):**
```typescript
import { InvoiceClient } from '@iln/sdk-next';

const client = new InvoiceClient({
  contractId: 'CA3D26RZE4CJGDWIDVRWS5PGAEV7R3Y5QG5W2VDJ3CQ626FJG5423F7E',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  signer, // funder defaults to signer.getPublicKey()
});

// Positional form: fundInvoice(invoiceId, amount?) — the second argument is
// an optional funding amount, not the funder address.
await client.fundInvoice(1n);

// To fund from a different address than the configured signer, or to fund a
// specific partial amount, use the object form instead:
await client.fundInvoice({
  invoiceId: 1n,
  funder: 'GC3KW5E4ZJ4Z627FJG5423F7ECA3D26RZE4CJGDWIDVRWS5PGAEV7R3Y',
  amount: 10_000_000n,
});
```

---

### 3. Get Invoice

**Before (`@iln/sdk`):**
```typescript
import { ILNSdk, ILN_TESTNET } from '@iln/sdk';

const sdk = new ILNSdk({ ...ILN_TESTNET });
const invoice = await sdk.getInvoice(1n);

console.log('Status:', invoice.status);
```

**After (`@iln/sdk-next`):**
```typescript
import { InvoiceClient } from '@iln/sdk-next';

const client = new InvoiceClient(
  'https://horizon-testnet.stellar.org',
  'CA3D26RZE4CJGDWIDVRWS5PGAEV7R3Y5QG5W2VDJ3CQ626FJG5423F7E'
);

const invoice = await client.getInvoice(1n);
console.log('Status:', invoice.status);
```

---

## Browser Support & Vite Configuration

`@iln/sdk-next` provides browser bundles with zero Node.js runtime dependencies:

```typescript
// packages/sdk/vite.browser.config.ts (actual, as of this writing)
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  plugins: [wasm()],
  build: {
    lib: {
      entry: 'src/index.browser.ts',
      formats: ['es'],
      fileName: 'index',
    },
    outDir: 'dist/browser',
    target: 'es2022',
  },
  resolve: {
    conditions: ['browser'],
  },
});
```

To cross-link or view legacy migration steps, see [`docs/sdk-migration-guide.md`](sdk-migration-guide.md).

## Supported Version Window & Deprecation Policy (Issue #1035)

This section covers `@iln/sdk` (`sdk/`) — the package `packages/react`'s hooks,
`cli/src`, and `examples/typescript-example` actually import today. (`@iln/sdk-next`,
covered by the rest of this document, is the forward migration target; once
consumers finish migrating to it, this policy moves with them.)

### Supported window

**The current minor and the two before it (N, N-1, N-2) are supported.**
A consumer pinned to any of those three can upgrade `@iln/sdk` patch releases
within its own minor without code changes, and the backward-compatibility
matrix below is what makes that guarantee enforceable rather than aspirational.

### Enforcement mechanism

`scripts/check-sdk-compat-matrix.mjs` installs each supported minor and runs
it against three fixtures modeled on real consumer code
(`tests/sdk-integration/compat-matrix/fixtures/`: frontend hooks, CLI
commands, example scripts). It runs in CI on every change to `sdk/` or those
consumer paths, and is callable from a release pipeline to gate a
release-candidate cut (`.github/workflows/sdk-compat-matrix.yml`). A failure
against any supported version fails the build — see
[docs/test-runtime-budgets.md](./test-runtime-budgets.md)'s enforcement
model for the sibling mechanism this one intentionally mirrors (hard-fail
CI, not a warning annotation).

**Current status**: `@iln/sdk` has never had a tagged or published release —
there is no N-1 or N-2 yet, only N (the working tree). The matrix resolves
versions from `sdk-v<semver>` git tags and degrades gracefully to a
working-tree self-check when fewer than three tagged minors exist (today,
zero). **The first time a second `sdk-v*` tag is created, this document's
"supported window" becomes real** — no code or workflow changes are needed
for the matrix to pick it up; `scripts/lib/sdk-compat-versions.mjs` resolves
the tag list at run time.

### Deprecation policy

- A minor is deprecated the moment it falls outside the N-2 window (i.e. as
  soon as a new minor makes it N-3).
- Deprecation is announced in `CHANGELOG.md` and, for a security-relevant
  change, a GitHub Security Advisory per [SECURITY.md](../SECURITY.md).
- A deprecated minor keeps working — this policy is about the compatibility
  *matrix's* window, not a runtime kill-switch. Nothing here revokes an
  already-installed SDK version.

### Package naming

`sdk/package.json`'s name is `@iln/sdk` and `packages/sdk/package.json`'s is
`@iln/sdk-next`. The stale references that called the stable SDK by a retired
name (the `sdk-e2e-local-node.yml` `pnpm --filter` target, the
`examples/lp-automation` dependency, and `@example` docstrings in
`sdk/src/*.ts`) were migrated in #1218, and
`scripts/check-sdk-package-names.mjs` now fails CI if one reappears — see
[runbooks/sdk-package-names.md](runbooks/sdk-package-names.md).
