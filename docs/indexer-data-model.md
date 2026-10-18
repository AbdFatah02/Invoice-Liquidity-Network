# ILN Indexer Data Model

## Cache freshness

The optional Redis cache in [`indexer/src/cache.ts`](../indexer/src/cache.ts) has one fixed duration: invoice records and invoice-list results default to **30 seconds** (`INVOICE_TTL_SECONDS`). Callers may pass a different TTL to `cacheSet`; the indexer defines no other fixed cache-duration constants.

Invoice mutations invalidate both `invoice:{id}` and all `invoices:*` list entries. Cache failures are non-fatal and fall back to database reads, so cache presence is not a consistency guarantee.

This document describes the on-chain data model for third-party indexers (The Graph, custom Postgres, SQLite) that want to index Invoice Liquidity Network (ILN) contract state.

---

## Table of Contents

1. [Field Types and Units](#field-types-and-units)
2. [Invoice State Machine](#invoice-state-machine)
3. [Events and State Transitions](#events-and-state-transitions)
4. [Reputation Computation](#reputation-computation)
5. [Handling Ledger Finality (no reorgs)](#handling-ledger-finality-no-reorgs)
6. [Recommended Indexer Schema (ERD)](#recommended-indexer-schema-erd)
7. [Worked Examples](#worked-examples)

---

## Two indexer packages — data model scope

This document describes the canonical on-chain data model as implemented by
`indexer/` (`iln-indexer`), the **production deployment service** that polls
the Soroban RPC. All field types, event names, and schema examples below
reflect that package.

A separate utility library, `packages/indexer/` (`@iln/indexer`), also exists.
It reads from the **Horizon REST API** rather than the Soroban RPC and uses a
different event-type vocabulary. The table below maps between the two:

| On-chain action | `indexer/` (this doc) | `@iln/indexer` (`packages/indexer/`) |
|---|---|---|
| Invoice submitted | `submitted` | `InvoiceCreated` |
| Invoice funded | `funded` | `InvoiceFunded` |
| Invoice paid | `paid` | `InvoiceRepaid` |
| Invoice defaulted | `defaulted` | `InvoiceDefaulted` |

`@iln/indexer` does not persist data — it is a stateless client wrapper. The
schema, cursor model, and worked examples below apply only to `indexer/`.
See [`docs/indexer/README.md`](./indexer/README.md) for a full comparison of
the two packages.

---

## Field Types and Units

| Field | Contract Type | Indexer Storage | Notes |
|-------|--------------|-----------------|-------|
| `id` | `u64` | `INTEGER` / `BIGINT` | Auto-incrementing per-invoice identifier |
| `freelancer` | `Address` | `TEXT` (Stellar G-address) | Payout recipient |
| `payer` | `Address` | `TEXT` (Stellar G-address) | Settlement obligor |
| `funder` | `Option<Address>` | `TEXT` or `NULL` | Primary LP; null until first funding |
| `amount` | `i128` | `TEXT` (stringify) | Stored as string — can exceed `Number.MAX_SAFE_INTEGER`; parse with `BigInt()` |
| `due_date` | `u32` | `INTEGER` | **Unix timestamp in seconds**, not ledger number |
| `funded_at` | `Option<u32>` | `INTEGER` or `NULL` | Unix timestamp when fully funded; null until funded |
| `discount_rate` | `u32` | `INTEGER` | **Basis points** (bps). 300 = 3.00% |
| `status` | `InvoiceStatus` | `TEXT` enum | See state machine below |
| `ledger` | — | `INTEGER` | Soroban ledger sequence number where event was emitted |
| `ledger_closed_at` | — | `TEXT` (ISO 8601) | Wall-clock time of ledger close |
| `event_id` | — | `TEXT` | Unique Soroban event ID, e.g. `"0000001234-0-0"` |

### Amount Units

**Amounts are always in the token's smallest indivisible unit** (analogous to stroops for XLM, microunits for USDC/EURC). The ILN implementation uses:

| Token | 1 whole unit | Smallest unit |
|-------|-------------|---------------|
| XLM | 1 XLM | 1 stroop = 10⁻⁷ XLM |
| USDC | 1 USDC | 1 unit = 10⁻⁷ USDC (contract-specific) |
| EURC | 1 EURC | 1 unit = 10⁻⁷ EURC (contract-specific) |

> The contract enforces a minimum invoice amount of **1,000,000 units** (approximately 0.1 whole tokens). Always store and compare amounts as `BigInt` or `NUMERIC(38)` — JavaScript's `Number` type loses precision above 2⁵³.

### Discount Rate (Basis Points)

`discount_rate` is always an integer number of **basis points** (bps). Divide by `10_000` to get the decimal rate.

```
3.00% yield → discount_rate = 300
0.50% yield → discount_rate = 50
```

Payer pays back `amount`. Freelancer receives `amount - discount`. LP earns the discount.

```
yield = (amount × discount_rate) / 10_000
freelancer_payout = amount - yield
lp_profit = yield
```

### Timestamps vs Ledger Numbers

| Use | Field | Type |
|-----|-------|------|
| Invoice due date | `due_date` | Unix seconds (`u32`) |
| Ledger ordering | `ledger` | Soroban ledger sequence |
| Wall-clock time | `ledger_closed_at` | ISO 8601 string |

Never use `ledger` for time math — ledger cadence is ~5 s on average but is not guaranteed. Use `due_date` (Unix seconds) for deadline comparisons.

---

## Invoice State Machine

```
                        ┌─────────────────────────────────────┐
                        │                                     │
    submit_invoice      │                                     ▼
    ──────────────► Pending ──── fund_invoice (full) ────► Funded
                        │                                     │
                        │        fund_invoice (partial)       │  mark_paid
                        │        ──────────────────────►      │  ──────────► Paid
                        │        PartiallyFunded              │
                        │                  │                  │  due_date passes
                        │                  │ fund (completes) │  + no payment
                        │                  └─────────────────►└──────────────► Defaulted
                        │
                        │  cancel_invoice
                        └──────────────────────────────────────────────────► Cancelled
                        │
                        │  due_date passes (never funded)
                        └──────────────────────────────────────────────────► Expired
```

### Status Values

| Status | Description | Terminal? |
|--------|-------------|-----------|
| `Pending` | Invoice submitted; awaiting LP funding | No |
| `PartiallyFunded` | One or more LPs have contributed, but invoice not fully funded | No |
| `Funded` | Invoice fully funded; payer must settle by `due_date` | No |
| `Paid` | Payer settled; LP receives principal + yield | **Yes** |
| `Defaulted` | Payer did not settle by `due_date`; LP may claim principal | **Yes** |
| `Appealed` | Payer appealed a default; admin review pending | No |
| `Disputed` | Payer disputed before settlement; admin review pending | No |
| `Expired` | Never funded and `due_date` passed | **Yes** |
| `Cancelled` | Freelancer cancelled a `Pending` invoice | **Yes** |

Terminal statuses never transition further. Index them and stop polling.

---

## Events and State Transitions

The ILN contract emits one event per significant state transition. The event topic (first element) is a symbol string identifying the event type.

### Event Schema (on-chain)

```
topic[0]  →  Symbol (event type name)
value     →  u64 (invoice_id)
```

> The indexer should always **re-fetch the full invoice state from the RPC** after receiving an event rather than inferring state from the event payload alone. This ensures correctness when events arrive out of order or the indexer resumes after a gap.

### Event → Status Mapping

| `topic[0]` | Triggered by | Resulting status |
|------------|-------------|-----------------|
| `submitted` | `submit_invoice` / `submit_invoice_auction` | `Pending` |
| `funded` | `fund_invoice` (full funding) | `Funded` |
| `paid` | `mark_paid` | `Paid` |
| `defaulted` | `claim_default` (LP triggers after due date) | `Defaulted` |

> `PartiallyFunded` is a status set by partial `fund_invoice` calls. No dedicated event is emitted for partial funding — monitor RPC state after any `funded` event to detect partial vs. full funding.

### Event ID Format

Soroban event IDs follow the pattern:

```
{ledger_sequence_padded}-{tx_index}-{event_index}
```

Example: `"0000001234-0-0"`

Use the event ID as a **primary key** in your events table to deduplicate. `INSERT OR IGNORE` (SQLite) or `ON CONFLICT DO NOTHING` (Postgres) is the correct pattern.

---

## Reputation Computation

Reputation is tracked on-chain per address and is read from the contract — not computed by the indexer. However, indexers can reconstruct the score from events to provide local caching.

### Score Formula

The on-chain reputation contract applies the following rules:

| Event | Score Change |
|-------|-------------|
| `submit_invoice` emitted | `invoices_submitted += 1` |
| `paid` event received | `invoices_paid += 1` |
| `defaulted` event received | `invoices_defaulted += 1`; penalty applied to score |

The raw score is in range `0–100+` (can exceed 100 for highly reliable actors).

**Decay**: The score decays over time based on ledger inactivity (`last_activity_ledger`). The decay rate is governed by `decay_rate_bps` in the protocol config. Indexers cannot compute decay without knowing the current ledger — always read live reputation via `get_reputation(address)`.

**Bonus tier**: Addresses with score ≥ `high_rep_threshold` receive a bonus discount reduction of `bonus_bps` on future invoices. The effective rate is:

```
effective_rate = max(base_rate - bonus_bps, min_discount_rate_bps)
```

### Recommended Indexer Approach for Reputation

Do not cache raw scores indefinitely — decay makes them stale. Use the on-chain query for any user-facing display, and use local event counts only for analytics:

```sql
-- Count reputation events per address
SELECT
  payer,
  COUNT(*) FILTER (WHERE status = 'Paid')      AS paid_count,
  COUNT(*) FILTER (WHERE status = 'Defaulted') AS default_count,
  COUNT(*)                                      AS total_as_payer
FROM invoices
GROUP BY payer;
```

---

## Handling Ledger Finality (no reorgs)

**Stellar has no chain reorganizations.** Once a ledger is closed and the Soroban RPC reports it as `CLOSED`, it is final. There is no concept of a "deep enough confirmation depth" as with EVM chains.

Implications for indexers:

| EVM concern | Stellar equivalent | Action |
|-------------|-------------------|--------|
| Reorg / chain tip rewind | RPC node lag, desync, or validator branch switch | Reconcile cursor, rollback removed events, restore invoice state |
| Uncle blocks | Not applicable | — |
| Pending mempool | Transactions are PENDING until ledger close | Track status `PENDING` vs `CLOSED` |
| Safe/finalized heads | Confirmation depth policy (`CONFIRMATION_DEPTH = 10`) | Process events at confirmation depth |

### Cursor-Based Polling & Re-org Handling

Persist the last processed ledger sequence in a `cursor` table to resume after restarts:

```sql
CREATE TABLE IF NOT EXISTS cursor (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  last_ledger  INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fork_decisions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  detected_at       INTEGER NOT NULL,
  from_ledger       INTEGER NOT NULL,
  to_ledger         INTEGER NOT NULL,
  tip_ledger        INTEGER NOT NULL,
  status            TEXT    NOT NULL,
  recovery_attempts INTEGER NOT NULL DEFAULT 0,
  events_removed    INTEGER NOT NULL DEFAULT 0,
  invoices_affected INTEGER NOT NULL DEFAULT 0,
  resolved_at       INTEGER
);

CREATE TABLE IF NOT EXISTS reorg_quarantine (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id    INTEGER NOT NULL,
  from_ledger    INTEGER NOT NULL,
  to_ledger      INTEGER NOT NULL,
  reason         TEXT    NOT NULL,
  error_details  TEXT,
  quarantined_at INTEGER NOT NULL
);
```

#### Reorganization & Fork Replacement Guarantees

1. **Tip Rewind Detection**: When `latestKnownLedger < stored`, the poller detects a chain tip rewind.
2. **Fork Replacement Persistence**: A `fork_decisions` entry is recorded (`status: 'in_progress'`) prior to rollback for restart safety.
3. **Removed Event Rollback**: Events with `ledger > targetLedger` are deleted. Invoices created exclusively on the abandoned fork are deleted, and invoices with prior history are restored to their last valid state (`Pending`, `Funded`, etc.).
4. **Idempotent Replay**: Event application and invoice mutation are executed atomically within SQLite transactions (`applyEventWithInvoice`), ensuring safe replay and restart behavior without state corruption or duplication.
5. **Incomplete Reorg Quarantine**: In-progress fork decisions track `recovery_attempts`. If rollback fails or exhausts `MAX_REORG_RECOVERY_ATTEMPTS` (3), the decision is transitioned to `'quarantined'` and recorded in `reorg_quarantine`, preventing poller crash loops.
6. **Cursor Monotonicity Invariants**: `setCursorLedger` guarantees that the stored cursor cannot regress during normal forward indexing. Rewinds are strictly rejected outside of authorized rollback operations.
7. **Property-Based Verification**: Random property tests (`fast-check`) continuously verify cursor monotonicity, replay idempotency, rollback boundedness, and quarantine isolation under high permutations of inputs.

---

## Recommended Indexer Schema (ERD)

```
┌──────────────────────────────────────────────┐
│                   invoices                   │
├──────────────┬──────────┬────────────────────┤
│ id           │ INTEGER  │ PK (contract u64)  │
│ freelancer   │ TEXT     │ NOT NULL           │
│ payer        │ TEXT     │ NOT NULL           │
│ funder       │ TEXT     │ nullable           │
│ amount       │ TEXT     │ NOT NULL (BigInt)  │
│ due_date     │ INTEGER  │ NOT NULL (unix s)  │
│ discount_rate│ INTEGER  │ NOT NULL (bps)     │
│ status       │ TEXT     │ NOT NULL           │
│ funded_at    │ INTEGER  │ nullable (unix s)  │
│ created_at   │ INTEGER  │ NOT NULL (unix ms) │
│ updated_at   │ INTEGER  │ NOT NULL (unix ms) │
└──────────────┴──────────┴────────────────────┘
         │                        │
         │ 1                    * │
         ▼                        ▼
┌──────────────────────────────────────────────┐
│                    events                    │
├──────────────────┬──────────┬────────────────┤
│ event_id         │ TEXT     │ PK (soroban id)│
│ event_type       │ TEXT     │ NOT NULL       │
│ invoice_id       │ INTEGER  │ FK → invoices  │
│ ledger           │ INTEGER  │ NOT NULL       │
│ ledger_closed_at │ TEXT     │ NOT NULL (ISO) │
│ created_at       │ INTEGER  │ NOT NULL       │
└──────────────────┴──────────┴────────────────┘

┌──────────────────────────────────────────────┐
│                    cursor                    │
├──────────────┬──────────┬────────────────────┤
│ id           │ INTEGER  │ PK (always = 1)    │
│ last_ledger  │ INTEGER  │ last processed     │
│ updated_at   │ INTEGER  │ unix ms            │
└──────────────┴──────────┴────────────────────┘
```

### Recommended Indexes

```sql
CREATE INDEX idx_invoices_status     ON invoices(status);
CREATE INDEX idx_invoices_freelancer ON invoices(freelancer);
CREATE INDEX idx_invoices_payer      ON invoices(payer);
CREATE INDEX idx_invoices_funder     ON invoices(funder);
CREATE INDEX idx_invoices_due_date   ON invoices(due_date);
CREATE INDEX idx_events_invoice_id   ON events(invoice_id);
CREATE INDEX idx_events_ledger       ON events(ledger);
```

### Postgres Schema (production)

```sql
CREATE TABLE invoices (
  id            BIGINT       PRIMARY KEY,
  freelancer    TEXT         NOT NULL,
  payer         TEXT         NOT NULL,
  funder        TEXT,
  amount        NUMERIC(38)  NOT NULL,        -- i128-safe
  due_date      INTEGER      NOT NULL,
  discount_rate INTEGER      NOT NULL,
  status        TEXT         NOT NULL DEFAULT 'Pending',
  funded_at     INTEGER,
  created_at    BIGINT       NOT NULL,
  updated_at    BIGINT       NOT NULL
);

CREATE TYPE iln_event_type AS ENUM ('submitted', 'funded', 'paid', 'defaulted');

CREATE TABLE events (
  event_id         TEXT          PRIMARY KEY,
  event_type       iln_event_type NOT NULL,
  invoice_id       BIGINT        NOT NULL REFERENCES invoices(id),
  ledger           INTEGER       NOT NULL,
  ledger_closed_at TIMESTAMPTZ   NOT NULL,
  created_at       BIGINT        NOT NULL
);

CREATE TABLE cursor (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  last_ledger  INTEGER NOT NULL DEFAULT 0,
  updated_at   BIGINT  NOT NULL
);
```

---

## Worked Examples

### Example 1: Standard Invoice Lifecycle (Pending → Funded → Paid)

```
Ledger 100: submit_invoice(freelancer=G_A, payer=G_B, amount=10_000_000, due_date=T+30d, discount_rate=300)
  → Event: topic=["submitted"], value=1
  → Indexer fetches invoice 1: { status: "Pending", funder: null, funded_at: null }
  → INSERT invoices(id=1, freelancer=G_A, payer=G_B, amount="10000000", status="Pending", ...)

Ledger 150: fund_invoice(funder=G_C, invoice_id=1, fund_amount=10_000_000)
  → Event: topic=["funded"], value=1
  → Indexer fetches invoice 1: { status: "Funded", funder: "G_C", funded_at: 1740000900 }
  → UPDATE invoices SET status="Funded", funder="G_C", funded_at=1740000900 WHERE id=1
  → INSERT events(event_id="0000000150-0-0", event_type="funded", invoice_id=1, ledger=150, ...)

Ledger 800: mark_paid(payer=G_B, invoice_id=1)
  → Event: topic=["paid"], value=1
  → Indexer fetches invoice 1: { status: "Paid" }
  → UPDATE invoices SET status="Paid" WHERE id=1
  → INSERT events(event_id="0000000800-0-0", event_type="paid", invoice_id=1, ledger=800, ...)

Final state: status="Paid", LP earned yield = (10_000_000 × 300) / 10_000 = 300_000 units
```

### Example 2: Default Lifecycle (Funded → Defaulted)

```
Ledger 100: submit_invoice(..., due_date=T+1d, ...)
  → status: "Pending"

Ledger 110: fund_invoice(...)
  → status: "Funded"

[due_date passes — payer does not call mark_paid]

Ledger 1200: claim_default(funder=G_C, invoice_id=1)
  → Event: topic=["defaulted"], value=1
  → Indexer fetches invoice 1: { status: "Defaulted" }
  → UPDATE invoices SET status="Defaulted" WHERE id=1

LP receives principal back; no yield earned on default.
```

### Example 3: Partial Funding → Full Funding → Paid

```
Ledger 100: submit_invoice(amount=20_000_000)
  → status: "Pending"

Ledger 120: fund_invoice(funder=G_C, fund_amount=10_000_000)  ← partial
  → No dedicated event emitted
  → Indexer polls RPC: { status: "PartiallyFunded", amount_funded: 10_000_000 }

Ledger 140: fund_invoice(funder=G_D, fund_amount=10_000_000)  ← completes funding
  → Event: topic=["funded"], value=1
  → Indexer fetches: { status: "Funded", funder: "G_C" }   (primary LP = first funder)

Ledger 400: mark_paid(...)
  → Event: topic=["paid"], value=1
  → status: "Paid"
```

> For partial funding, subscribe to RPC polling rather than relying solely on the `funded` event. The event fires only when the invoice transitions to `Funded`.

### Example 4: Cancelled Invoice

```
Ledger 100: submit_invoice(...)
  → status: "Pending"

Ledger 105: cancel_invoice(freelancer=G_A, invoice_id=1)
  → No indexed event in core event set
  → Indexer detects status change on next poll: { status: "Cancelled" }
  → UPDATE invoices SET status="Cancelled" WHERE id=1
```

> `Cancelled` and `Expired` are terminal states with no dedicated events in the core event set. Use periodic RPC polling for `Pending` invoices approaching or past their `due_date` to catch `Expired` transitions.

---

## Accuracy Verification

This document was derived from:
- [invoice-contract.md](contracts/invoice-contract.md) — contract function signatures and events
- [reputation-contract.md](contracts/reputation-contract.md) — reputation scoring rules
- [`indexer/src/types.ts`](../indexer/src/types.ts) — canonical type definitions
- [`indexer/src/db.ts`](../indexer/src/db.ts) — reference SQLite schema and query patterns
- [`indexer/src/processor.ts`](../indexer/src/processor.ts) — event processing and deduplication logic

> **Note on `packages/indexer/`:** The `@iln/indexer` utility library
> (`packages/indexer/src/types.ts`) defines its own `ILNEventType` and
> `ContractEvent` types that differ from the types above. Those types reflect
> the Horizon API payload shape, not the Soroban RPC shape. Do not use
> `packages/indexer/src/types.ts` as a reference for the on-chain data model
> described here.

Contact the smart contract team to verify any discrepancies between this document and the deployed contract.
