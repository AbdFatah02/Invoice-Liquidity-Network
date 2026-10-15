# ILN Notification Service

A Node.js + Express backend service for sending Stellar ILN invoice notifications via email, webhook, and SMS.

## Architecture

The service follows a poll-deliver pipeline:

```
Stellar RPC
    │
    ▼
┌─────────┐    ┌───────────┐    ┌────────────┐    ┌─────────────┐
│  Poller  │───▶│ Processor │───▶│  Delivery  │───▶│ Email/Webhook/SMS │
└─────────┘    └───────────┘    └────────────┘    └─────────────┘
                    │
                    ▼
              ┌──────────┐
              │ Scheduled│  (due_soon, overdue)
              │ Notifs   │
              └──────────┘
```

### Poller (`src/poller.ts`)

Polls the Stellar Soroban contract for events in batches of 200. Maintains a cursor ledger in SQLite to avoid reprocessing. On startup, resumes from the last stored cursor (or falls back to `NOTIFICATIONS_START_LEDGER` or the latest ledger minus 1000). Uses exponential backoff on retryable errors with a maximum of 5 consecutive retries before extended pause.

### Processor (`src/processor.ts`)

Decodes each contract event via `scValToNative`, deduplicates by event ID, fetches the invoice from the contract via RPC simulation, and upserts it into the local SQLite DB. Maps event types to notification triggers:

| Event Type | Trigger | Recipients |
|---|---|---|
| `funded` | `invoice_funded` | Freelancer, Payer |
| `paid` | `invoice_paid` | Freelancer, LP (funder) |
| `defaulted` | `invoice_defaulted` | LP (funder) |
| — | `invoice_due_soon` | LP (funded invoices due within `DUE_WARNING_HOURS`) |
| — | `invoice_overdue` | Payer |

### Delivery (`src/delivery.ts`)

Routes notifications to channel-specific senders:

- **Email**: Via [Resend](https://resend.com) SDK. Sends HTML-rendered emails with HMAC-signed unsubscribe links.
- **Webhook**: HTTP POST with HMAC signature in `X-ILN-Signature` header. Retries up to 3 times with exponential backoff (base 500ms). Logs delivery attempts to `webhook_delivery_logs` table.
- **SMS**: Via [Twilio](https://www.twilio.com). Requires `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`.

Failed deliveries after exhausting retries are placed in a dead-letter queue
for inspection via the retry metrics endpoint. A destination that exhausts its
retry budget is circuit-broken for 60 seconds; subsequent delivery attempts
fail immediately for that destination while other destinations continue.

### Multi-Channel Delivery (`src/multi-channel.ts`)

Alternative delivery path supporting concurrent multi-channel delivery with fallback chains. Uses injectable adapter interfaces (`EmailAdapter`, `SmsAdapter`, `WebhookAdapter`) for testability.

### Digest (`src/digest.ts`)

Buffers notification events for users preferring daily or weekly digests. The `DigestScheduler` ticks at a configurable interval (default 1 minute), flushes accumulated events on schedule boundary, and renders HTML via `digest.template.ts`.

### Rate Limiter (`src/rate-limiter.ts`)

Sliding-window rate limiting combines a per-user bucket with a bucket scoped
to each `(channel, destination)` recipient. One busy email address, webhook URL,
or phone number therefore cannot consume another recipient's quota. Configure
the recipient threshold with `RATE_LIMIT_PER_RECIPIENT`; the legacy
`RATE_LIMIT_PER_CHANNEL` variable remains a fallback.

## User Preferences

Users control notification behavior via the preferences API (`src/preferences-api.ts`):

- **Channels**: Enable/disable email, webhook, or SMS independently
- **Frequency**: `realtime`, `daily`, or `weekly` digest
- **Quiet hours**: Suppress delivery during a configurable time window (with timezone support)
- **Per-trigger overrides**: Enable/disable individual event types (e.g., disable `invoice_funded` but keep `invoice_paid`)

### API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Service health check |
| `POST` | `/subscribe` | Create notification subscription |
| `DELETE` | `/unsubscribe` | Remove subscription |
| `GET` | `/subscriptions/:address` | List subscriptions for address |
| `GET` | `/subscriptions/:id/logs` | Webhook delivery logs |
| `POST` | `/test-webhook` | Test webhook endpoint |
| `GET` | `/analytics` | Delivery analytics |
| `GET` | `/analytics/channel-comparison` | Channel performance comparison |
| `GET` | `/analytics/trends?days=N` | Delivery trends over time |
| `GET` | `/preferences/:address` | Get user preferences |
| `PUT` | `/preferences/:address` | Create/update preferences |
| `PATCH` | `/preferences/:address` | Partial update preferences |
| `DELETE` | `/preferences/:address` | Reset preferences to defaults |
| `POST` | `/preferences/:address/unsubscribe` | One-click unsubscribe |
| `POST` | `/preferences/unsubscribe/token/:token` | Token-based unsubscribe |
| `GET` | `/preferences/:address/export` | GDPR data export |

## Local Development

### Prerequisites

- Node.js 20+
- A Stellar RPC endpoint (public testnet works for development)
- Resend API key (for email delivery)
- (Optional) Twilio credentials (for SMS)

### Setup

1. Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

Required environment variables:

| Variable | Description |
|---|---|
| `NOTIFICATIONS_RPC_URL` | Stellar RPC endpoint URL |
| `NOTIFICATIONS_CONTRACT_ID` | Soroban contract ID to poll |
| `NOTIFICATIONS_NETWORK_PASSPHRASE` | Stellar network passphrase |
| `RESEND_API_KEY` | Resend API key for email delivery |

Optional:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4001` | HTTP server port |
| `NOTIFICATIONS_START_LEDGER` | `0` (auto) | Starting ledger for event polling |
| `NOTIFICATIONS_POLL_INTERVAL_MS` | `30000` | Polling interval in milliseconds |
| `RESEND_FROM_EMAIL` | `no-reply@invoice-liquidity.network` | Sender email address |
| `DUE_WARNING_HOURS` | `48` | Hours before due date to send warning |
| `RATE_LIMIT_PER_USER` | `60` | Subscription/test requests per user per window |
| `RATE_LIMIT_PER_RECIPIENT` | `200` | Requests per channel and destination per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Sliding rate-limit window in milliseconds |
| `TWILIO_ACCOUNT_SID` | — | Twilio account SID for SMS |
| `TWILIO_AUTH_TOKEN` | — | Twilio auth token |
| `TWILIO_FROM_NUMBER` | — | Twilio phone number |

2. Install dependencies:

```bash
pnpm install
```

3. Start the service:

```bash
pnpm dev
```

The HTTP server starts on `http://localhost:4001` and the WebSocket server on `ws://localhost:4002/ws`.

### Triggering a Test Notification

Use the test webhook endpoint:

```bash
curl -X POST http://localhost:4001/test-webhook \
  -H "Content-Type: application/json" \
  -d '{"address": "YOUR_STELLAR_ADDRESS"}'
```

Or subscribe via the API and poll for real events:

```bash
curl -X POST http://localhost:4001/subscribe \
  -H "Content-Type: application/json" \
  -d '{
    "address": "YOUR_STELLAR_ADDRESS",
    "channel": "email",
    "destination": "you@example.com",
    "triggers": ["invoice_funded", "invoice_paid"]
  }'
```

## Testing

```bash
pnpm test            # Run all tests
pnpm test:coverage   # Run with coverage report
pnpm test:watch      # Run in watch mode
```

## Database

The service uses SQLite via `better-sqlite3` (default path: `notifications.sqlite`). Tables:

- `invoices` — Invoice records synced from the contract
- `events` — Processed contract events (deduplication key)
- `cursor` — Last processed ledger position
- `subscriptions` — User notification subscriptions
- `sent_notifications` — Delivered notification log (idempotency)
- `webhook_delivery_logs` — Per-attempt webhook delivery tracking

## Erasure requests

Erasure is an operator-mediated workflow because the notification API cannot
prove that a requester controls a Stellar address. Verify identity through a
signed wallet challenge or equivalent approved account proof, then call
`POST /preferences/erasure/:address` with JSON `{ "requestId": "...",
"operatorId": "..." }` and `Authorization: Bearer <ERASURE_OPERATOR_TOKEN>`.
Configure `ERASURE_OPERATOR_TOKEN` to a high-entropy value of at least 32
characters. Do not expose the endpoint without network controls, and never use
an address supplied by itself as identity proof. See
[`docs/privacy.md`](../docs/privacy.md) for scope, retained/anonymized audit
data, confirmation, and backup handling.
