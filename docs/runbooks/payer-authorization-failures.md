# Payer Authorization Failures Runbook

Operator reference for the oracle-service payer authorization failure taxonomy
(issue #1232, taxonomy version `payer-authz-v1`). Source of truth:
`oracle-service/src/authorization.ts`.

## What the control does

Every payer check gets one or more stable failure **codes**. Each code has a
**category**, an HTTP status and a **retryable** hint. Before this change, a
denial only showed up as free-form text (a 400 `error`, a composition
`rationale` or a fraud-signal sentence). Callers and alerts had to match on
strings.

The taxonomy is also a **fail-closed** control. `OracleVerifier.verify()` runs
every verdict through `enforcePayerAuthorization`: fresh verdicts, cache
replays, in-flight joins and degraded responses. A response cannot claim
`isVerified: true` while any failure code applies. Cache entries written by
older instances have no `authorization` block, so they are re-classified when
read.

## Codes

| Code | Category | HTTP | Retryable | Meaning | First action |
| --- | --- | --- | --- | --- | --- |
| `PAYER_REQUEST_MALFORMED` | request | 400 | no | `payer`, `amount` or `invoiceId` missing | Caller bug; check the client build |
| `PAYER_ADDRESS_INVALID` | request | 400 | no | `payer` is not a Stellar address | Caller bug or probing |
| `PAYER_RATE_LIMITED` | request | 429 | yes | Per-IP window exhausted | Honour `retryAfter` |
| `PAYER_ABUSE_BLOCKED` | request | 429 | yes | IP blocked for an abusive pattern | Check `reason`; look for scraping |
| `PAYER_FRAUD_SIGNALS` | policy | 200 | no | Fraud heuristics fired | See `oracle_fraud_signal_total` |
| `PAYER_LOW_TRUST` | policy | 200 | no | Trust < 70 or confidence < 0.55 | Expected for thin-history payers |
| `PAYER_KYB_UNVERIFIED` | policy | 200 | no | KYB provider explicitly failed the payer | Business must resolve with provider |
| `PAYER_DATA_STALE` | freshness | 200 | yes | Source data older than `maxOracleAgeMs` | Check indexer lag |
| `PAYER_DEGRADED_LAST_KNOWN_GOOD` | freshness | 200 | yes | All sources down; last-known-good served | See [source failover runbook](../oracle-source-failover-runbook.md) |
| `PAYER_KYB_UNAVAILABLE` | dependency | 200 | yes | Required KYB provider did not answer | Check provider status |
| `ORACLE_SOURCES_UNAVAILABLE` | dependency | 503 | yes | No source and no cache | Indexer and reputation RPC both down |
| `ORACLE_INTERNAL_ERROR` | internal | 500 | yes | Unexpected failure | Check service logs |

The **policy** codes are decisions about the payer, and retrying will not
change them. The **dependency**, **freshness** and **internal** codes are
outages. A payer denied with one of those has not been judged.

### Precedence

When several codes apply, `authorization.primary` is the first one, in this
order:

degraded → KYB unavailable → stale → KYB unverified → fraud → low trust

This follows the composition precedence in [Oracle Service](../oracle-service.md#precedence).
`authorization.failures` lists every code that applies.

## Where to see it

**Verdict responses** (`POST /verify`, `POST /v1/verify`):

```jsonc
{
  "isVerified": false,
  "authorization": {
    "taxonomy": "payer-authz-v1",
    "decision": "deny",
    "primary": "PAYER_KYB_UNVERIFIED",
    "failures": [
      { "code": "PAYER_KYB_UNVERIFIED", "category": "policy", "retryable": false }
    ]
  }
}
```

**Error responses** (400 / 429 / 503 / 500) keep the existing `error` string
and add `code`, `category`, `retryable` and `taxonomy`.

**Metrics** (`/metrics`):

| Metric | Labels | Use |
| --- | --- | --- |
| `oracle_payer_authorization_decisions_total` | `decision`, `stage` | Allow/deny volume; the denominator for ratios |
| `oracle_payer_authorization_failures_total` | `code`, `category`, `primary`, `cache_hit` | Denials by cause |
| `oracle_payer_authorization_taxonomy_info` | `version` | Always `1`; shows the control is loaded |

To count each denial once, filter on `primary="true"`. Without that filter,
the metric counts every code that applied, so a single denial with several
codes is counted more than once.

**Logs**: every denial writes one JSON line to stderr:

```json
{"event":"oracle.payer_authorization.denied","stage":"verdict","code":"PAYER_FRAUD_SIGNALS","codes":["PAYER_FRAUD_SIGNALS"],"payer":"GDVEU3DD","invoiceId":"42","cacheHit":false}
```

Payer addresses are truncated to 8 characters, the same as in tracing spans.

## Alerts

### OraclePayerAuthorizationTaxonomyMissing

An instance is up but does not export `oracle_payer_authorization_taxonomy_info`.
It is running a build without this control, so its verdicts are neither
classified nor forced fail-closed. Roll forward to an image that includes #1232,
or drain the instance.

### OraclePayerAuthorizationDependencyDenials

Over 10 minutes, more than 10% of payer checks were denied with a primary code
in the `dependency` or `internal` category. Honest payers are being refused for
reasons that have nothing to do with them. Break the denials down by code:

```promql
sum by (code) (rate(oracle_payer_authorization_failures_total{primary="true"}[10m]))
```

- `PAYER_KYB_UNAVAILABLE`: the KYB provider is down or timing out.
- `ORACLE_SOURCES_UNAVAILABLE`: the indexer and the reputation RPC are both
  down. Follow the source failover runbook.
- `ORACLE_INTERNAL_ERROR`: check the logs for the stack. This usually means
  an audit-trail append failure or a cache backend error.

## Verifying the control in an environment

```bash
# 1. Control loaded
curl -s $ORACLE_URL/metrics | grep oracle_payer_authorization_taxonomy_info

# 2. Request-stage code
curl -s -X POST $ORACLE_URL/v1/verify -H 'content-type: application/json' -d '{}' | jq .code
# → "PAYER_REQUEST_MALFORMED"

# 3. CI evidence
pnpm --filter @iln/oracle-service exec vitest run src/authorization.test.ts
```

## Compatibility

All changes are additive:

- the `authorization` field on verdicts
- the `code`, `category`, `retryable` and `taxonomy` fields on error bodies
- the new `rejected-kyb-unverified` composition outcome

Existing `error` strings and HTTP statuses are unchanged. The frontend and SDK
do not read `composition.outcome` today. A consumer that does must treat
unknown outcomes as "not verified".
