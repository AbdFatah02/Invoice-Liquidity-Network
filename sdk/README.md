# `@iln/sdk`

> This is the **stable, recommended SDK** for integrators. `packages/sdk`
> (`@iln/sdk-next`) is an experimental, modular/browser-first rewrite that
> hasn't reached feature parity yet — see
> [`docs/sdk-next-migration.md`](../docs/sdk-next-migration.md) for the full
> comparison and current status.

[![npm version](https://img.shields.io/npm/v/@iln/sdk)](https://www.npmjs.com/package/@iln/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/actions/workflows/ci.yml/badge.svg)](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/actions/workflows/ci.yml)

Typed JavaScript and TypeScript SDK for the Invoice Liquidity Network Soroban contract on Stellar.

New to ILN terminology? See the protocol [glossary](../docs/glossary.md) for Stellar, invoice factoring, and security terms used by the SDK.

By participating in this project, you agree to abide by our [Code of Conduct](../CODE_OF_CONDUCT.md).

## Supported Node.js versions

The SDK supports **Node.js 20.x and 22.x** (active LTS lines) — matching the
`"engines": { "node": ">=20" }` field in `package.json`. Every push and pull
request runs the SDK test suite against Node.js 20 and 22 via the `sdk-node-matrix`
job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). Newer Node.js
versions are expected to work but are not part of the guaranteed compatibility matrix.

## Quick Start

```bash
npm install @iln/sdk
```

```ts
import { ILNSdk, ILN_TESTNET, createFreighterSigner } from "@iln/sdk";

const sdk = new ILNSdk({ ...ILN_TESTNET, signer: createFreighterSigner() });
const invoiceId = await sdk.submitInvoice({ freelancer: "G...", payer: "G...", amount: 25_000_000n, dueDate: Math.floor(Date.now() / 1000) + 604800, discountRate: 300 });
await sdk.fundInvoice({ funder: "G...", invoiceId });
const invoice = await sdk.getInvoice(invoiceId);
console.log(invoice.status); // "Funded"
```

## Install

```bash
npm install @iln/sdk
```

## Quickstart

### Browser + Freighter

```ts
import { ILNSdk, ILN_TESTNET, createFreighterSigner } from "@iln/sdk";

const sdk = new ILNSdk({
  ...ILN_TESTNET,
  signer: createFreighterSigner(),
});

const invoiceId = await sdk.submitInvoice({
  freelancer: "G...",
  payer: "G...",
  amount: 25_000_000n,
  dueDate: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  discountRate: 300,
});

await sdk.fundInvoice({
  funder: "G...",
  invoiceId,
});

await sdk.markPaid({
  invoiceId,
});

const invoice = await sdk.getInvoice(invoiceId);
console.log(invoice.status);
```

### Node.js

```ts
import { ILNSdk, ILN_TESTNET, createKeypairSigner } from "@iln/sdk";

const sdk = new ILNSdk({
  ...ILN_TESTNET,
  signer: createKeypairSigner(process.env.STELLAR_SECRET_KEY!),
});

const invoice = await sdk.getInvoice(1n);
console.log(invoice);
```

> **Security note:** The SDK performs limited input validation and relies on the configured Soroban RPC/Horizon node and signer implementation for contract simulation, transaction preparation, and submission. See [SDK trust model](../docs/sdk-trust-model.md) for details.

## Request timeouts

SDK network calls fail fast with `TimeoutError` when the configured deadline is exceeded.

Defaults:

- Read operations: `10_000ms`
- Write operations: `30_000ms`
- Simulation operations: `15_000ms`
- `timeoutMs`: fallback default for all categories when operation-specific values are not supplied

```ts
import { ILNSdk, ILN_TESTNET, TimeoutError } from "@iln/sdk";

const sdk = new ILNSdk({
  ...ILN_TESTNET,
  timeoutMs: 30_000,
  timeouts: {
    readMs: 10_000,
    writeMs: 30_000,
    simulationMs: 15_000,
  },
});

try {
  await sdk.getInvoice(1n);
} catch (error) {
  if (error instanceof TimeoutError) {
    console.error(`${error.operation} timed out after ${error.timeoutMs}ms`);
  }
}
```

Read timeouts apply to read-only contract queries, write timeouts apply to account loading, transaction preparation, submission, and polling, and simulation timeouts apply to pre-submit simulations.

## Token Amounts

SDK methods accept token amounts as `bigint` base units. USDC and EURC use 6 decimals, while XLM uses 7 decimals through the native SAC wrapper. See the [multi-token support guide](../docs/tokens/multi-token-support.md) for supported tokens, trustlines, testnet acquisition, and token-aware parsing examples.

## API

```ts
submitInvoice(params: {
  freelancer: string;
  payer: string;
  amount: bigint;
  dueDate: number;
  discountRate: number;
}): Promise<bigint>;

fundInvoice(params: {
  funder: string;
  invoiceId: bigint;
}): Promise<void>;

markPaid(params: {
  invoiceId: bigint;
}): Promise<void>;

claimDefault(params: {
  funder: string;
  invoiceId: bigint;
}): Promise<void>;

getInvoice(invoiceId: bigint): Promise<Invoice>;
```

## Invoice type

The canonical domain definitions live in `@iln/shared`; the SDK re-exports them for compatibility.

```ts
import { InvoiceStatus, isPending, isFunded, isTerminal, InvoiceStatusColor } from "@iln/sdk";

// Enum for full type safety and autocomplete
InvoiceStatus.Pending   // "Pending"
InvoiceStatus.Funded    // "Funded"
InvoiceStatus.Paid      // "Paid"
InvoiceStatus.Defaulted // "Defaulted"
InvoiceStatus.Disputed  // "Disputed"

// Helper predicates
isPending(invoice.status)   // true / false
isFunded(invoice.status)
isTerminal(invoice.status)  // true for Paid | Defaulted | Disputed

// UI color mapping
InvoiceStatusColor[invoice.status] // e.g. "#10B981"

interface Invoice {
  id: bigint;
  freelancer: string;
  payer: string;
  amount: bigint;
  dueDate: number;
  discountRate: number;
  status: InvoiceStatus;
  funder: string | null;
  fundedAt: number | null;
}
```

## Notifications

The SDK provides a `NotificationsClient` to programmatically manage your invoice notification subscriptions.

```ts
import { NotificationsClient, NotificationTrigger } from "@iln/sdk";

const notifications = new NotificationsClient("http://localhost:4001");

// Subscribe to email notifications
const emailSub = await notifications.subscribeEmail(
  "G...",
  "user@example.com",
  [NotificationTrigger.InvoiceFunded, NotificationTrigger.InvoiceSettled]
);

// Subscribe to webhook
const webhookSub = await notifications.subscribeWebhook(
  "G...",
  "https://my-app.com/webhook",
  [NotificationTrigger.DueDateWarning]
);

// Test webhook
const testResult = await notifications.testWebhook(webhookSub.id);
console.log(testResult.success); // true

// List subscriptions
const subs = await notifications.listSubscriptions("G...");

// Unsubscribe
await notifications.unsubscribe(emailSub.id);
```

## Analytics (opt-in)

The SDK can emit anonymous, privacy-preserving usage events to help the maintainers understand which methods are most used and where errors occur most frequently.

**Off by default.** Enable with the `ILN_ANALYTICS` environment variable:

```bash
ILN_ANALYTICS=1 node your-app.js
```

**What is collected (and nothing else):**

| Field        | Example            | Notes                    |
| ------------ | ------------------ | ------------------------ |
| `method`     | `"submitInvoice"`  | SDK method name          |
| `success`    | `true`             | Outcome                  |
| `errorCode`  | `"NetworkError"`   | Only on failure          |
| `network`    | `"testnet"`        | `testnet` or `mainnet`   |
| `version`    | `"0.1.0"`          | SDK version              |

**What is never collected:** wallet addresses, invoice IDs, amounts, secret keys, or any other identifying information.

Events are sent to `https://analytics.iln.finance/event` (configurable via `ILN_ANALYTICS_ENDPOINT`). The collector validates that no PII fields are present before writing to the database. Failure to reach the endpoint is silently ignored and never throws.

Privacy policy: ILN analytics are aggregate and anonymous. No personal data, no wallet addresses, no correlation to individual users. Data is used solely to prioritise SDK development.

## Development

```bash
cd sdk
npm install
npm test
```

## Debug Logging

Enable SDK debug logging with the `ILN_DEBUG` environment variable:

```bash
ILN_DEBUG=1 node ./dist/index.js
```

When enabled, the SDK emits namespaced debug output under `iln:sdk:invoice` using `console.debug`.

## Integration tests (testnet)

The integration suite runs real transactions against the deployed Stellar testnet contract.

```bash
cd sdk
FREELANCER_SECRET=S... \
PAYER_SECRET=S... \
FUNDER_SECRET=S... \
npm run test:integration
```

Required environment variables:

- `FREELANCER_SECRET` - funded Stellar testnet secret for invoice submission
- `PAYER_SECRET` - funded Stellar testnet secret for `mark_paid`
- `FUNDER_SECRET` - funded Stellar testnet secret for funding and default claim

If these variables are not set, integration tests are skipped automatically so CI and local unit test runs remain unaffected.

## E2E tests (local node)

The SDK provides an end-to-end test suite that runs against a local Stellar node. This tests the complete invoice lifecycle (including partial payments, disputes, and cancellations) natively on a local network.

To run the E2E tests:

1. Start the local node environment:
   ```bash
   docker-compose -f ../tests/e2e/docker-compose.yml up -d
   ```
2. Wait for the node (Horizon) to become healthy.
3. Run the tests:
   ```bash
   npm run test:e2e-local
   ```
4. Tear down the local node:
   ```bash
   docker-compose -f ../tests/e2e/docker-compose.yml down
   ```
