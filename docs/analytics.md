# Analytics Integration Guide

## Overview

ILN analytics expose indexed invoice state for dashboards, portfolio views, and risk monitoring. Integrators can read protocol totals, [LP](glossary.md#lp-liquidity-provider) performance, [freelancer](glossary.md#freelancer) activity, invoice history, and ranked LP yield without calling [Soroban](glossary.md#soroban) RPC directly.

The indexer watches ILN contract events, fetches the latest `get_invoice(id)` state from Soroban RPC, stores normalized rows in SQLite, and serves REST endpoints. The SDK analytics module wraps those endpoints with TypeScript types and a small in-memory cache.

Analytics are derived from on-chain invoice data only:

- invoice amount, [due date](glossary.md#due-date), [discount rate](glossary.md#discount-rate), lifecycle status, [freelancer](glossary.md#freelancer), [payer](glossary.md#payer), funder, and funding timestamp
- contract status transitions emitted by `submitted`, `funded`, `paid`, and `defaulted` events
- realized LP yield from paid invoices

## Metric Definitions

All monetary values are in token base units. For USDC-like assets this repo treats `10_000_000` units as `1 USDC`.

Contract formulas verified against `backend/contracts/invoice_liquidity/src/lib.rs` and arithmetic tests in `backend/contracts/invoice_liquidity/src/tests_arithmetic.rs` in the [ILN-Smart-Contract](https://github.com/Invoice-Liquidity-Network/ILN-Smart-Contract) submodule ([cross-repo dependencies](./cross-repo-dependencies.md)):

| Metric | Formula | Notes |
| --- | --- | --- |
| Discount amount | `floor(amount * discount_rate / 10_000)` | `discount_rate` is [basis points](glossary.md#basis-points-bps). `300` means `3.00%`. |
| Freelancer payout | `amount - discount_amount` | Paid to the freelancer once an invoice becomes fully funded. |
| LP realized yield | `discount_amount` for invoices with status `Paid` | `mark_paid` transfers `amount + discount_amount` to the LP. |
| Default recovery | `discount_amount` for invoices with status `Defaulted` | `claim_default` returns only the escrowed discount to the LP; it is not counted as realized yield. |
| Protocol total volume | `sum(invoice.amount)` across indexed invoices | Includes every indexed invoice status. |
| Protocol total yield | `sum(discount_amount)` for `Paid` invoices | Excludes `Funded`, `Pending`, and `Defaulted` invoices. |
| Default rate | `defaulted_terminal_invoices / terminal_invoices` | Terminal invoices are `Paid` or `Defaulted`. Returns `0` when there are no terminal invoices. |
| LP deployed | `sum(invoice.amount)` where `invoice.funder == address` | Includes funded, paid, and defaulted invoices indexed for that LP. |
| LP invoice count | `count(invoices)` where `invoice.funder == address` | Includes all statuses with that funder. |
| LP default rate | same default-rate formula, scoped to `invoice.funder == address` | Only paid/defaulted invoices are in the denominator. |
| Freelancer submitted | `count(invoices)` where `invoice.freelancer == address` | Includes every status. |
| Freelancer funded | count where freelancer matches and status is `Funded`, `Paid`, or `Defaulted` | These statuses indicate the freelancer received funding. |
| Freelancer total received | `sum(amount - discount_amount)` for funded freelancer invoices | Based on contract funding payout. |
| Average discount | `sum(discount_rate) / submitted` | Returned in basis points; `0` when there are no invoices. |

The contract also updates [payer](glossary.md#payer) [reputation score](glossary.md#reputation-score): `mark_paid` increments score by `1`; `claim_default` subtracts `5`, floored at `0`. The public analytics API does not currently expose payer score history.

## Indexer API Reference

Default local base URL: `http://localhost:3001`.

Large integer amounts are returned as decimal strings in JSON so clients do not lose precision.

### `GET /health`

Returns service health.

Response:

```json
{ "status": "ok" }
```

### `GET /stats`

Returns protocol-level analytics.

Response:

```json
{
  "totalInvoices": 42,
  "totalVolume": "125000000000",
  "totalYield": "3750000000",
  "defaultRate": 0.08
}
```

### `GET /lps/:address/stats`

Returns analytics for one liquidity provider.

Parameters:

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `address` | path | string | yes | Stellar public key for the LP/funder. |

Response:

```json
{
  "deployed": "75000000000",
  "yield": "2250000000",
  "invoiceCount": 18,
  "defaultRate": 0.05555555555555555
}
```

### `GET /freelancers/:address/stats`

Returns analytics for one freelancer.

Parameters:

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `address` | path | string | yes | Stellar public key for the freelancer. |

Response:

```json
{
  "submitted": 12,
  "funded": 9,
  "totalReceived": "87300000000",
  "avgDiscount": 300
}
```

### `GET /history/:address?role=freelancer|payer|funder`

Returns invoices associated with an address in the selected role.

Parameters:

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `address` | path | string | yes | Stellar public key to filter by. |
| `role` | query | string | no | One of `freelancer`, `payer`, or `funder`. Defaults to `freelancer`. |

Response:

```json
[
  {
    "id": 7,
    "freelancer": "G...",
    "payer": "G...",
    "amount": "250000000",
    "due_date": 1767139200,
    "discount_rate": 300,
    "status": "Paid",
    "funder": "G...",
    "funded_at": 1764547200,
    "created_at": 1764547000123,
    "updated_at": 1764548000456
  }
]
```

Invalid roles return `400`:

```json
{ "error": "Invalid role - expected freelancer, payer, or funder" }
```

### `GET /lps/top?limit=10&period=all|week|month`

Returns LPs sorted by realized yield, then invoice count.

Parameters:

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | number | no | Maximum number of LPs. Defaults to `10`; capped at `100`. |
| `period` | query | string | no | `all`, `week`, or `month`. Defaults to `all`. |

Response:

```json
[
  {
    "address": "G...",
    "yield": "2250000000",
    "invoiceCount": 18
  }
]
```

Invalid periods return `400`:

```json
{ "error": "Invalid period - expected all, week, or month" }
```

### `GET /invoices`

Returns raw indexed invoice rows. Filters are ANDed together.

Query parameters:

| Name | Type | Description |
| --- | --- | --- |
| `status` | string | `Pending`, `Funded`, `Paid`, or `Defaulted`. |
| `freelancer` | string | Freelancer public key. |
| `payer` | string | Payer public key. |
| `funder` | string | LP/funder public key. |

Request:

```http
GET /invoices?status=Paid&funder=G...
```

Response:

```json
{
  "invoices": [
    {
      "id": 7,
      "freelancer": "G...",
      "payer": "G...",
      "amount": "250000000",
      "due_date": 1767139200,
      "discount_rate": 300,
      "status": "Paid",
      "funder": "G...",
      "funded_at": 1764547200,
      "created_at": 1764547000123,
      "updated_at": 1764548000456
    }
  ]
}
```

### `GET /invoice/:id`

Returns one raw indexed invoice row.

Parameters:

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | integer | yes | Positive invoice ID. |

Response:

```json
{
  "invoice": {
    "id": 7,
    "freelancer": "G...",
    "payer": "G...",
    "amount": "250000000",
    "due_date": 1767139200,
    "discount_rate": 300,
    "status": "Paid",
    "funder": "G...",
    "funded_at": 1764547200,
    "created_at": 1764547000123,
    "updated_at": 1764548000456
  }
}
```

Errors:

```json
{ "error": "Invalid invoice ID - must be a positive integer" }
```

```json
{ "error": "Invoice #7 not found" }
```

## SDK Analytics Module Reference

Import from the published SDK package:

```ts
import { AnalyticsSDK } from "@iln/sdk";
```

Constructor:

```ts
new AnalyticsSDK(baseUrl?: string, defaultTtl?: number)
```

`baseUrl` defaults to `https://api.iln.network`. `defaultTtl` is an in-memory cache TTL in milliseconds and defaults to `300_000` (5 minutes).

Types and methods:

```ts
interface ProtocolStats {
  totalInvoices: number;
  totalVolume: bigint;
  totalYield: bigint;
  defaultRate: number;
}

interface LPStats {
  deployed: bigint;
  yield: bigint;
  invoiceCount: number;
  defaultRate: number;
}

interface FreelancerStats {
  submitted: number;
  funded: number;
  totalReceived: bigint;
  avgDiscount: number;
}

interface AnalyticsInvoice {
  id: number;
  freelancer: string;
  payer: string;
  amount: bigint;
  due_date: number;
  discount_rate: number;
  status: string;
  funder: string | null;
}

interface LPStat {
  address: string;
  yield: bigint;
  invoiceCount: number;
}

class AnalyticsSDK {
  getProtocolStats(): Promise<ProtocolStats>;
  getLPStats(address: string): Promise<LPStats>;
  getFreelancerStats(address: string): Promise<FreelancerStats>;
  getInvoiceHistory(
    address: string,
    role: "freelancer" | "payer" | "funder"
  ): Promise<AnalyticsInvoice[]>;
  getTopLPs(limit?: number, period?: "all" | "week" | "month"): Promise<LPStat[]>;
  clearCache(): void;
}
```

The SDK converts decimal string amounts returned by the indexer into `bigint` values.

## Data Freshness

The indexer polls Soroban RPC every `POLL_INTERVAL_MS`; the default is `5000` ms. Each poll processes new contract events, fetches latest invoice state via `get_invoice(id)`, and upserts local SQLite rows.

Expected freshness is:

- normal operation: approximately one poll interval plus RPC response time
- local default configuration: usually 5-10 seconds after the event appears on RPC
- SDK consumers: add up to the configured SDK cache TTL; default cache TTL is 5 minutes

Use `new AnalyticsSDK(baseUrl, 0)` or call `clearCache()` when a dashboard needs fresh reads after a known transaction.

## Example: Simple Analytics Widget

```ts
import { AnalyticsSDK } from "@iln/sdk";

const api = new AnalyticsSDK("http://localhost:3001", 30_000);
const usd = (units: bigint) => `$${(Number(units) / 10_000_000).toFixed(2)}`;

export async function renderAnalyticsWidget(el: HTMLElement) {
  const [stats, top] = await Promise.all([
    api.getProtocolStats(),
    api.getTopLPs(3, "all"),
  ]);

  el.innerHTML = `
    <strong>ILN analytics</strong>
    <p>${stats.totalInvoices} invoices indexed</p>
    <p>${usd(stats.totalVolume)} total volume</p>
    <p>${usd(stats.totalYield)} LP yield</p>
    <p>${(stats.defaultRate * 100).toFixed(1)}% default rate</p>
    <ol>${top.map((lp) =>
      `<li>${lp.address.slice(0, 6)}... ${usd(lp.yield)}</li>`
    ).join("")}</ol>
  `;
}
```

## Query-Load Isolation

Analytics aggregation queries (`getProtocolStats`, `getLPStats`, `getFreelancerStats`, `getTopLPs`) perform full-table scans and grouping operations that can be expensive as the invoice table grows. To prevent these from degrading production read latency, the indexer provides two isolation mechanisms:

### Read-Only Replica Connection

Set `ANALYTICS_DB_PATH` to route all analytics queries to a dedicated read-only SQLite connection. This connection opens the database in read-only mode and is separate from the primary connection used for production reads and writes. In SQLite WAL mode, a read-only connection can read concurrently without blocking writers or being blocked by them, and its I/O does not contend with the primary connection's page cache.

In production, this should point to the same WAL database file (the OS-level read isolation comes from separate file descriptors and page caches) or to a filesystem-level snapshot/replica if stricter isolation is needed.

```env
ANALYTICS_DB_PATH=indexer.db    # same file, separate read-only connection
```

### Query Budget Enforcement

`ANALYTICS_QUERY_BUDGET_MS` (default: 5000 ms) sets a time budget for analytics queries. Queries exceeding this budget are logged as warnings and counted by the `iln_analytics_query_exceeded_budget_total` Prometheus counter. Alerting rules should fire when this counter increments, as it indicates an analytics query is approaching the threshold where it could affect production latency through shared I/O bandwidth.

### SDK Analytics Collector (Cloudflare Worker)

The SDK usage analytics pipeline (`workers/analytics-collector/`) is fully isolated by design: it runs as a Cloudflare Worker writing to a separate Postgres database via Hyperdrive. It shares no infrastructure with the indexer's SQLite-backed production path.

### Monitoring

| Metric | Type | Description |
| --- | --- | --- |
| `iln_analytics_query_duration_seconds` | Histogram | Duration of analytics aggregation queries |
| `iln_analytics_query_exceeded_budget_total` | Counter | Analytics queries exceeding the configured time budget |
| `iln_db_query_duration_seconds` | Histogram | Production query path duration (should not spike when analytics queries run) |

**Recommended alert**: fire when `rate(iln_analytics_query_exceeded_budget_total[5m]) > 0` — this means analytics queries are slow enough to risk impacting production I/O.

## Limitations

- The analytics API does not include off-chain invoice documents, payer identity checks, credit bureau data, KYC status, payment rails outside the ILN contract, or manual dispute outcomes.
- The indexer only knows events it has processed. If it starts from a later ledger, older invoices are absent until backfilled.
- Large amounts are serialized as strings over HTTP. Use `bigint` in TypeScript when doing calculations.
- Multi-funder partial funding is represented on-chain, but the current indexer invoice row stores one `funder` field for the full-funding path. Analytics that require per-contribution attribution need event-level or funder-list indexing.
- Default rate only considers terminal `Paid` and `Defaulted` invoices. Pending and funded invoices are still in flight and are excluded from that denominator.
- Yield is realized only after `mark_paid`. A defaulted invoice may return the escrowed discount, but it is not treated as yield.
