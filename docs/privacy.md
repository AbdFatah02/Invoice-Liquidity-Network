# Privacy and Data Retention Policy

This document describes the data the Invoice Liquidity Network stores on behalf of users, how long each piece of data is retained, and how users can exercise their right to view, export, or delete their data across all services (Notifications, Indexer, KYB Provider Interface, and Oracle).

For protocol-level security and threat-model information, see [`security-guide.md`](security-guide.md) and [`threat-model.md`](threat-model.md).
For the processor and agreement evidence register, see [Third-Party Data-Processor Inventory](third-party-data-processor-inventory.md).

---

## 1. Notifications Service (`notifications/`)

### Right-to-erasure request process

Users may request deletion through the support/privacy contact published by
the operator. The operator records the request ID and received date, verifies
control of the relevant Stellar address using a signed challenge from the
wallet or equivalent documented account proof, and scopes the request against
the notifications service. A public address supplied in a URL or email alone
is not identity verification. Do not request or retain a secret key.

After verification, an authorized operator runs the notifications erasure
operation for that address. It disables in-memory preferences, removes all
subscriptions and their webhook retry rows, removes pending dispatch work,
and removes deduplication rows containing the address or its destinations.
Delivery audit rows required for the published 90-day investigation window
are retained but anonymized: address, destination, and free-text error fields
are cleared. The remaining event/time/channel/outcome fields are retained only
for that period and then removed by the existing retention sweep. The
operation is transactional and produces an audit record with request ID,
counts, operator, and timestamp but no address or destination. The operator
confirms completion to the verified requester and records any legally required
retention exception and expiry date.

This repository has no persistent user-account database beyond notification
preferences and subscriptions. Wallet accounts and ledger data are public
network records and are not deletable by this service. A deployment with
additional account stores must add their owners and deletion adapters to the
request checklist before describing a request as globally complete. Backups
expire on their separately configured lifecycle; restored backups must be
reconciled with completed erasure records before being returned to service.

The HTTP notification API does not itself prove requester identity. Intake and
wallet/account identity verification are operator-mediated; never expose an
unauthenticated endpoint that deletes records by address. After verification,
an authorized operator calls `POST /preferences/erasure/:address` with
`{ "requestId": "...", "operatorId": "..." }` and an `Authorization:
Bearer ...` header. Configure `ERASURE_OPERATOR_TOKEN` as a high-entropy secret
of at least 32 characters in the service environment. The request ID is
idempotent; a repeated completed ID returns HTTP 409. The endpoint is not a
public user self-service route. Keep the verification evidence in the
controlled request system, not in the notifications database.
Keep a minimal request receipt outside the erased data store only where
required to demonstrate completion, with its own access controls and
retention schedule.

The notifications service has in-memory preferences and SQLite-backed delivery data:

### 1a. Notification preferences (per Stellar address)

| Field | Purpose |
|-------|---------|
| `stellarAddress` | Identifies the user (Stellar public key). |
| `enabledChannels` | Which delivery channels the user has opted-in to (`email`, `sms`, `webhook`, `websocket`). |
| `frequency` | Delivery frequency: `realtime`, `daily`, or `weekly`. |
| `quietHours` | Optional `{ startHour, endHour, timezone }` window during which notifications are held back. |
| `triggerPreferences` | Per-trigger overrides (e.g. "don't notify me of `invoice_defaulted` events"). |
| `updatedAt` | ISO 8601 timestamp of the last edit. |

### 1b. Subscriptions (rows in the `subscriptions` SQLite table)

Each row describes one outbound subscription:

| Column | Purpose |
|--------|---------|
| `stellar_address` | Owning user. |
| `channel` | `email`, `webhook`, or `sms`. |
| `destination` | Delivery target (email address, URL, or E.164 phone number — the user-provided contact data). |
| `triggers` | JSON array of invoice-event triggers the user subscribed to. |
| `webhook_secret` | Optional HMAC signing secret for webhooks. |
| `created_at` | Subscription creation timestamp. |

### 1c. Delivery audit log (rows in `sent_notifications`, `webhook_delivery_logs`, and `delivery_audit_log`)

These records support compliance investigations ("was this specific notification actually delivered, and when?") as a durable, queryable audit log. Three kinds of records exist:

- **De-duplication state** (`sent_notifications`) and **webhook retry state** (`webhook_delivery_logs`).
- **Durable dispatch journal** (`dispatch_attempts`) — pending work is retained until completed; terminal delivered/failed rows are purged after 90 days.
- **Durable delivery-confirmation audit log** (`delivery_audit_log`) — one row per delivery outcome (whether `delivered` or `failed`), with attempt timestamps, channel, and final status. This table is the source of truth for `GET /audit/deliveries` (by recipient, event, or time range) and for the CLI `query-audit` tool.

They are not visible to users by default but are included in the export endpoint.

**Retention behavior** (`notifications/src/db.ts`, `notifications/src/retention.ts`):
- **Preferences**: Held in process memory only; lost on process restart. They are not persisted to SQLite.
- **Subscriptions**: Persisted in SQLite until unsubscribe/deletion. A deletion request removes the subscription and its webhook retry records.
- **`sent_notifications`**: Purged 30 days after `sent_at`.
- **`webhook_delivery_logs` and `delivery_audit_log`**: Purged 90 days after `created_at`.
- **`dispatch_attempts`**: Terminal delivered/failed rows are purged 90 days after `created_at`; pending work is not automatically deleted so an outage cannot silently discard delivery work.
- **Redeemed unsubscribe tokens**: Purged 90 days after `redeemed_at`.
- **Retention deletion audit**: Every run records the category, cutoff, eligible/deleted counts, mode, and time in `retention_deletion_audit`. It contains no recipient or destination data and is retained for compliance review.

The retention job runs at process startup and every 24 hours by default. It starts in **dry-run mode**; scheduled deletion is enabled only by setting `NOTIFICATIONS_RETENTION_DRY_RUN=false`. If eligible rows exceed `RETENTION_MAX_DELETE_ROWS` (default 10,000), the run deletes nothing and emits an error-level alert for the deployment's log alerting. Review the audit rows before raising the limit. `RETENTION_SWEEP_INTERVAL_MS` controls the interval. Operators can preview or run a bounded sweep using `pnpm --filter iln-notifications exec tsx src/audit-cli.ts --purge --dry-run --max-rows 10000`.

The HTTP purge endpoint is an operational/manual path; the scheduled worker is the enforcement mechanism. Client-side notification history follows the frontend application's retention practices and is outside this service's deletion job.

---

## 2. Indexer Service (`indexer/`)

- **Data Collected**: The indexer aggregates on-chain transaction data (e.g., wallet addresses, invoice token IDs, transfer events, and settlement actions).
- **Data Retention & Archive**: The indexer keeps recent records in its primary database for 90 days, then moves them to the archive database. Archived invoices/events are permanently purged after 2,555 days (approximately seven years), on the same daily scheduler. `ARCHIVE_PURGE_OLDER_THAN_DAYS` configures that period. These records originate from public ledgers; wallet addresses may still be personal data where they can be linked to an individual.
- **Backups**: Optional local backups retain the configured maximum count (30 by default); optional cloud backup lifecycle/region is controlled by the operator and is not enforced by the indexer. The documented nightly GitHub Actions backup artifact is retained for seven days. Backups can therefore outlive a live-database purge until their own retention expires.

---

## 3. KYB Provider Interface

- **Data Collected**: If the external KYB (Know Your Business) provider integration is enabled, this service securely routes business identity verification payloads.
- **Data Retention & Archive**: The oracle accepts an injected provider adapter; no production provider adapter or provider-side retention control is included in this repository. The audit trail stores a reduced verdict payload and does not store KYB business names, registration numbers, raw details, or provider reasons. Provider data may be present in the live response; production KYB-required checks bypass the oracle response cache. Provider-side records and logs remain subject to the provider's contract and retention policy and must be reviewed before enabling that provider. The prior 14-day local KYB-log statement was not backed by an implemented local logging/deletion path and is withdrawn.

---

## 4. Oracle Service (`oracle-service/`)

- **Data Collected**: The oracle service fetches and verifies off-chain asset pricing and invoice status updates.
- **Data Retention & Archive**: The oracle audit trail retains reduced verification attestations for 365 days. Retention is enforced at startup and hourly by `AuditTrail.enforceRetention`; purges are recorded through signed retention anchors. The durable audit includes payer wallet addresses and invoice identifiers, which may be personal data depending on linkability. Oracle cache entries are short-lived (300 seconds by default), but the last-known-good in-memory entry remains until process restart; Redis expiry behavior is separate from the durable audit window.

## 5. Cross-Border Processing and Data Residency

The trust-liquidity model identifies SME suppliers in LATAM and Southeast Asia and US enterprise buyers, but it does not select launch countries. Those regions contain materially different privacy, localization, and international-transfer rules; this repository therefore cannot make a country-specific legal-compliance finding.

The current code/configuration does not pin or attest a storage/processing region. Indexer primary/archive SQLite paths and notification SQLite paths are deployment-local; indexer deployment documentation recommends Railway but does not select a Railway region. Oracle SQLite audit storage, optional Redis cache, optional cloud backups, GitHub Actions backup artifacts, the KYB provider, Stellar RPCs, email/SMS providers, and customer webhook destinations can involve separate locations and subprocessors. No region restriction or cross-border transfer mechanism is enforced by this codebase.

Before onboarding residents of any launch country, record the exact countries and data-subject cohorts, map each data flow and processor/location, and have qualified counsel confirm applicable localization, transfer, notice, consent, contract, and impact-assessment requirements. In particular, assess the applicable national transfer rules for each selected LATAM and Southeast Asian country (including Brazil's LGPD transfer framework where Brazil is in scope) and applicable US state/sector obligations for buyer data. Select and configure compliant hosting, backup, and provider regions and required transfer safeguards before launch. Until that review and deployment evidence exist, regional data-residency compliance is **unverified and a launch gate**; no infrastructure region change can be responsibly selected from the broad regional target alone.

---

## 6. What we **do not** store

| ❌ Not stored | Why |
|---------------|-----|
| Stellar secret keys | The infrastructure services are observer-only. |
| IP addresses | Failures are surfaced via application logs; PII is not retained alongside delivery records. |
| Tracking pixels / open-tracking data | We respect the user's inbox. |
| Third-party analytics identifiers | None are embedded in the templates or payloads. |

---

## 7. Contact

- Email: security@invoiceliquidity.network
- For data-export / deletion requests, please email the security contact.

*Retention behavior described above reflects the code paths and deployment defaults in this repository. Provider-side processing, actual deployed regions, backup lifecycle configuration, and country-specific legal compliance require deployment evidence and review before launch.*
