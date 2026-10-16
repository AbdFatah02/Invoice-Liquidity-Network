# Third-Party Integration Guide

This guide explains how third-party developers (accounting tools, ERP systems, DeFi aggregators) can query the Invoice Liquidity Network (ILN) contract state, subscribe to real-time events, and submit transactions on behalf of users.

---

## Table of Contents
1. [Authentication Patterns](#1-authentication-patterns)
2. [Querying Invoice State](#2-querying-invoice-state)
3. [Listening to Contract Events (Horizon Streaming)](#3-listening-to-contract-events-horizon-streaming)
4. [Submitting Invoices Programmatically](#4-submitting-invoices-programmatically)
5. [Building a Custom LP Dashboard](#5-building-a-custom-lp-dashboard)
6. [Handling Multi-Token Precision](#6-handling-multi-token-precision)
7. [Horizon API Rate Limits & Best Practices](#7-horizon-api-rate-limits--best-practices)

---

## Before you begin: cold-validation notes

This guide was written to be followed by a developer with no prior ILN context. The most common friction points from a fresh external integration pass are:

- package names and import paths must match the repo exactly (`@iln/sdk` rather than older naming variants);
- a funded Stellar testnet account is required before invoking any contract call;
- RPC endpoints and contract IDs must be verified against the current network target;
- streaming event consumers need an event filter and a ledger cursor; and
- the guide assumes the integrator has already configured a local or testnet secret key environment.

The guidance below is structured to remove that ambiguity and should be followed in order from setup to event subscription to submission.

## 1. Authentication Patterns

ILN supports two primary transaction signing models depending on the environment:

### User-Signed Transactions (Client-Side)
- **Use Case**: Web applications, client-facing dashboards (e.g., Freighter wallet).
- **Behavior**: The dApp builds a transaction, passes it to Freighter for the user's signature, and submits it. The application never accesses the user's private key.
- **Safety**: Highly secure, zero liability for developers.

### Server-Side Signing (Automated ERP/Cron Jobs)
- **Use Case**: Background sync services, accounting tools, automated payment systems.
- **Behavior**: The server uses a secret key (`S...`) stored in environment variables to sign transactions programmatically.
- **Safety**: Secure the secret key using hardware security modules (HSM), AWS Secrets Manager, or Google Cloud Secret Manager. Never hardcode keys.

---

## 2. Querying Invoice State

### Via TypeScript SDK

Use the `@iln/sdk` to query details of any invoice by ID:

```typescript
import { ILNSdk, ILN_TESTNET } from "@iln/sdk";

// Initialize SDK
const sdk = new ILNSdk({
  contractId: ILN_TESTNET.contractId,
  rpcUrl: ILN_TESTNET.rpcUrl,
  networkPassphrase: ILN_TESTNET.networkPassphrase,
});

async function fetchInvoiceDetails(invoiceId: bigint) {
  try {
    const invoice = await sdk.getInvoice(invoiceId);
    console.log("Invoice Details:", {
      id: invoice.id.toString(),
      freelancer: invoice.freelancer,
      payer: invoice.payer,
      amount: invoice.amount.toString(),
      dueDate: new Date(invoice.dueDate * 1000).toISOString(),
      discountRate: `${(invoice.discountRate / 100).toFixed(2)}%`,
      status: invoice.status, // "Pending" | "Funded" | "Paid" | "Defaulted"
      funder: invoice.funder,
      fundedAt: invoice.fundedAt ? new Date(invoice.fundedAt * 1000).toISOString() : null,
    });
  } catch (error) {
    console.error("Failed to query invoice:", error);
  }
}

fetchInvoiceDetails(1n);
```

### Via Raw Stellar CLI Command

You can query the contract directly using the `stellar-cli` interface:

```bash
stellar contract invoke \
  --id CD3TE3IAHM737P236XZL2OYU275ZKD6MN7YH7PYYAXYIGEH55OPEWYJC \
  --source-account S... \
  --network testnet \
  -- \
  get_invoice \
  --invoice_id 1
```

---

## 3. Listening to Contract Events (Horizon Streaming)

Instead of polling, third-party applications should subscribe to [Soroban](glossary.md#soroban) events using the [Horizon](glossary.md#horizon) streaming API or the RPC server `/events` endpoint.

### Horizon SSE Event Stream Example (TypeScript)

Use the `@stellar/stellar-sdk` to stream event records matching the ILN contract ID:

```typescript
import { rpc } from "@stellar/stellar-sdk";
import { ILN_TESTNET } from "@iln/sdk";

const server = new rpc.Server(ILN_TESTNET.rpcUrl);

async function startEventStream() {
  console.log("Subscribing to ILN contract events...");

  // Poll or stream events using getEvents
  let lastLedger = (await server.getLatestLedger()).sequence;

  setInterval(async () => {
    try {
      const response = await server.getEvents({
        startLedger: lastLedger,
        filters: [
          {
            type: "contract",
            contractIds: [ILN_TESTNET.contractId],
          },
        ],
        limit: 10,
      });

      for (const event of response.events) {
        console.log("Received Contract Event:", {
          id: event.id,
          ledger: event.ledger,
          topic: event.topic.map((t) => t.toString()), // topics tell you which event (e.g. submit_invoice)
          value: event.value,
        });
      }

      if (response.events.length > 0) {
        lastLedger = Math.max(...response.events.map((e) => e.ledger)) + 1;
      }
    } catch (error) {
      console.error("Error fetching contract events:", error);
    }
  }, 5000);
}

startEventStream();
```

---

## 4. Submitting Invoices Programmatically

### Client-Side (Freighter Wallet)

```typescript
import { ILNSdk, ILN_TESTNET, createFreighterSigner } from "@iln/sdk";

const sdk = new ILNSdk({
  ...ILN_TESTNET,
  signer: createFreighterSigner(),
});

async function submitUserInvoice() {
  const invoiceId = await sdk.submitInvoice({
    freelancer: "GB...", // User's public key
    payer: "GD...",
    amount: 100_000_000n, // Decimals-scaled bigint
    dueDate: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60), // 30 days
    discountRate: 500, // 5.00%
  });
  console.log(`Invoice submitted successfully. ID: ${invoiceId}`);
}
```

### Server-Side (Keypair Signer)

```typescript
import { ILNSdk, ILN_TESTNET, createKeypairSigner } from "@iln/sdk";

const sdk = new ILNSdk({
  ...ILN_TESTNET,
  signer: createKeypairSigner(process.env.STELLAR_SECRET_KEY!),
});

async function submitSystemInvoice() {
  const invoiceId = await sdk.submitInvoice({
    freelancer: "GB...", // The system's or delegated user's public address
    payer: "GD...",
    amount: 500_000_000n,
    dueDate: Math.floor(Date.now() / 1000) + (14 * 24 * 60 * 60),
    discountRate: 300, // 3.00%
  });
  console.log(`Server-side invoice submission successful. ID: ${invoiceId}`);
}
```

### Raw Stellar CLI Command to Submit Invoice

```bash
stellar contract invoke \
  --id CD3TE3IAHM737P236XZL2OYU275ZKD6MN7YH7PYYAXYIGEH55OPEWYJC \
  --source-account S... \
  --network testnet \
  -- \
  submit_invoice \
  --freelancer GB... \
  --payer GD... \
  --amount 100000000 \
  --due_date 1782800000 \
  --discount_rate 500
```

---

## 5. Building a Custom LP Dashboard

For DeFi aggregators and [Liquidity Providers (LPs)](glossary.md#lp-liquidity-provider), monitoring yield and funding invoices requires extracting status data.

### Querying & Yield Computations

```typescript
import { ILNSdk, ILN_TESTNET } from "@iln/sdk";

const sdk = new ILNSdk(ILN_TESTNET);

async function getLPMetrics(lpAddress: string, activeInvoiceIds: bigint[]) {
  let totalFunded = 0n;
  let expectedReturn = 0n;

  for (const id of activeInvoiceIds) {
    const invoice = await sdk.getInvoice(id);
    if (invoice.funder === lpAddress) {
      totalFunded += invoice.amount;
      
      // Calculate return based on [discount rate](glossary.md#discount-rate) (e.g. 500 [basis points](glossary.md#basis-points-bps) = 5.00%)
      const discountAmount = (invoice.amount * BigInt(invoice.discountRate)) / 10000n;
      
      if (invoice.status === "Paid") {
        expectedReturn += discountAmount;
      }
    }
  }

  console.log(`LP Portfolio Summary for ${lpAddress}:`);
  console.log(`Total Funded: ${totalFunded.toString()}`);
  console.log(`Total Earned Yield: ${expectedReturn.toString()}`);
}
```

---

## 6. Handling Multi-Token Precision

ILN accepts multiple allowlisted tokens (e.g. USDC, EURC, and XLM). Each asset has distinct decimals:

| Token | Decimals | Format Code | Smallest Unit ([Stroop](glossary.md#stroop)/Base Unit) |
|---|---|---|---|
| **USDC** | 6 | USDC | `1` = `0.000001 USDC` |
| **EURC** | 6 | EURC | `1` = `0.000001 EURC` |
| **XLM** | 7 | XLM | `1` = `0.0000001 XLM` |

Always process amounts as `bigint` base units on-chain, and format them using token-aware utilities:

```typescript
const DECIMALS_MAP = {
  USDC: 6,
  EURC: 6,
  XLM: 7,
} as const;

export function toBaseUnits(amountString: string, token: keyof typeof DECIMALS_MAP): bigint {
  const decimals = DECIMALS_MAP[token];
  const parts = amountString.split(".");
  const whole = BigInt(parts[0] || "0");
  const fractionStr = (parts[1] || "").slice(0, decimals).padEnd(decimals, "0");
  const fraction = BigInt(fractionStr);
  const scale = 10n ** BigInt(decimals);
  return whole * scale + fraction;
}

export function toDisplayAmount(baseUnits: bigint, token: keyof typeof DECIMALS_MAP): string {
  const decimals = DECIMALS_MAP[token];
  const scale = 10n ** BigInt(decimals);
  const whole = baseUnits / scale;
  const fraction = baseUnits % scale;
  const fractionStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fractionStr ? `${whole}.${fractionStr}` : `${whole}`;
}

// Examples:
console.log(toBaseUnits("100.50", "USDC")); // 100500000n
console.log(toBaseUnits("100.50", "XLM"));  // 1005000000n
```

---

## 7. Horizon API Rate Limits & Best Practices

Public [Horizon](glossary.md#horizon) endpoints enforce rate limits to maintain network stability.

### Key Guidelines

1. **Handle HTTP 429 (Too Many Requests)**:
   Implement exponential backoff when requests fail.
   ```typescript
   async function callWithRetry<T>(fn: () => Promise<T>, retries = 5, delay = 1000): Promise<T> {
     try {
       return await fn();
     } catch (error: any) {
       if (error.response?.status === 429 && retries > 0) {
         console.warn(`Rate limited. Retrying in ${delay}ms...`);
         await new Promise((resolve) => setTimeout(resolve, delay));
         return callWithRetry(fn, retries - 1, delay * 2);
       }
       throw error;
     }
   }
   ```
2. **Reuse Client Connections**:
   Do not instantiate `rpc.Server` or Horizon clients inside loops. Cache the instance.
3. **Use Dedicated RPC Nodes for Production**:
   Public infrastructure (`https://soroban-testnet.stellar.org`) is for development. Use dedicated services (e.g. Blockdaemon, NowNodes) for production.
4. **Cache Static Data**:
   Invoice state for `Paid` or `Defaulted` invoices never changes. Cache these in a local database (e.g. SQLite/PostgreSQL) instead of querying RPC servers repeatedly.
