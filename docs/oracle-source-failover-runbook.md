# Oracle Source Failover & Delta-Bound Review Runbook (Issues #1051, #1052)

Operational guide for the two oracle-integrity mechanisms in `oracle-service`:

- **Automated source failover** (#1051, `src/sourceFailover.ts`) — the service
  moves history/reputation traffic off a degrading upstream on its own, and
  back only once it has genuinely stabilised.
- **Manipulation-resistant delta bounds** (#1052, `src/deltaBounds.ts`) — the
  service refuses to publish a single trust-score movement that is larger than
  the feed has ever realistically moved in one step, unless an independent
  source quorum corroborates it.

Both are already live in the request path with **no configuration change**:
with no fallback URLs set, the oracle behaves exactly as it did before these
issues. This runbook covers turning the fallbacks on, reading the signals the
mechanisms emit, and triaging an incident.

Related: alerting rules in
[`monitoring/prometheus/oracle-service-alerts.yml`](../monitoring/prometheus/oracle-service-alerts.yml)
(groups `oracle-service-source-failover` and `oracle-service-delta-bounds`).

---

## Part 1 — Automated source failover (#1051)

### 1.1 What each source is

The verifier fetches four upstreams per verdict. Two of them are pairable with
a fallback (the other two, external KYB and the on-chain KYB result, are not
failover-managed):

| Feed            | Primary env var                       | Fallback env var                       | Tracker source ids                    |
| --------------- | ------------------------------------- | -------------------------------------- | ------------------------------------- |
| History indexer | `INDEXER_BASE_URL`                     | `ORACLE_INDEXER_FALLBACK_URL`           | `indexer-primary`, `indexer-fallback` |
| Reputation RPC  | `ORACLE_REPUTATION_RPC_URL` (+ `ORACLE_REPUTATION_CONTRACT_ID`) | `ORACLE_REPUTATION_FALLBACK_RPC_URL` | `reputation-primary`, `reputation-fallback` |

**A fallback is only wired when its env var is set.** If
`ORACLE_INDEXER_FALLBACK_URL` (or the reputation equivalent) is unset, the
provider is a single source: no health bookkeeping is done, and a total outage
fails safe exactly as before the change — history yields `[]` ("No payer
history" evidence) and reputation yields a zeroed snapshot (`reputationScore:
0`). Setting the fallback env var and restarting is the act that turns
failover on.

### 1.2 Decision criteria (defaults in `defaultSourceFailoverConfig`)

The tracker keeps a sliding window of the most recent attempts per source and
runs a `healthy → degraded → unavailable` state machine. Every number below is
overridable by env without a code change.

| Signal                              | Default            | Env override                             | Demotes to        |
| ----------------------------------- | ------------------ | ---------------------------------------- | ----------------- |
| Window size (attempts kept)         | `50`               | `ORACLE_FAILOVER_WINDOW_SIZE`             | —                 |
| Error rate strictly above threshold | `0.5` (50%)        | `ORACLE_FAILOVER_ERROR_RATE`              | `degraded`        |
| Error rate at or above threshold    | `1.0` (100%)       | `ORACLE_FAILOVER_ERROR_RATE_UNAVAILABLE`  | `unavailable`     |
| Window p95 latency above threshold  | `1500` ms          | `ORACLE_FAILOVER_P95_LATENCY_MS`          | `degraded`        |
| No success within stale window      | `300000` ms (5 min)| `ORACLE_FAILOVER_STALE_AFTER_MS`          | `unavailable`     |
| Consecutive successes to recover    | `5`                | `ORACLE_FAILOVER_RECOVERY_SUCCESSES`      | (promotes)        |
| Minimum time since demotion         | `60000` ms (1 min) | `ORACLE_FAILOVER_COOLDOWN_MS`             | (promotes)        |

A source only staleness-demotes if it has succeeded at least once — a source
that has never returned anything is judged on error rate, not staleness.

### 1.3 Automated behaviour

- **Fail fast.** A single window that crosses the unavailable threshold, or a
  5-minute gap since the last success, drops the source to `unavailable`
  immediately. A softer breach (error rate over 50%, or p95 latency over
  1500 ms) drops it to `degraded`.
- **Promote slow (anti-flap).** Coming back requires **both** `recoverySuccesses`
  consecutive successes **and** `cooldownMs` elapsed since the demotion. Either
  alone is not enough.
- **Probe, don't hammer.** While a demoted source is inside its cooldown it
  receives **no** traffic — every call goes to the fallback. When the cooldown
  elapses, the *next* real request is routed primary-first as a recovery probe.
  A failed probe **restarts the cooldown**, so a source that is genuinely down
  is retried at most once per cooldown window rather than on every request.
- **Metrics hook.** Every transition out of `healthy` increments
  `oracle_failover_events_total{source}`; `oracle_source_health_state{source}`
  is set to `0` healthy / `1` degraded / `2` unavailable on every transition.
- **Health payload.** `GET /health` and `GET /v1/health` include a `sources`
  map (`source id → state`) and flip `status` to `degraded` when any source is
  `unavailable`.

### 1.4 Manual failover / failback

The automated path handles transient and sustained outages on its own. You only
act manually to *change topology*, not to react to a blip.

**Fail over deliberately (known primary incident):**
1. Point the fallback at a healthy mirror, or, to force all traffic off a bad
   primary without a fallback, correct the primary URL.
2. Restart the service so `createDefaultOptions` re-reads the env.
3. Confirm on `/v1/health` that the new primary reports `healthy` and traffic
   is landing there (`oracle_source_health_state{source="…"} 0`).

**Fail back after the primary is fixed:**
1. Remove or correct `ORACLE_INDEXER_FALLBACK_URL` / `ORACLE_REPUTATION_FALLBACK_RPC_URL`.
2. Restart. Routing then reverts to the single/primary source.
3. Verify `sources` is empty (no fallback configured) or that the primary is
   back to `0` healthy and `oracle_failover_events_total` has stopped climbing.

Do **not** restart to chase a `degraded` source — degradation is self-correcting
via the probe/streak machinery; a restart only clears its window history and
delays failback.

### 1.5 Anti-flapping guarantees

Two knobs prevent role thrash: the recovery **streak** (`ORACLE_FAILOVER_RECOVERY_SUCCESSES`)
and the **cooldown** (`ORACLE_FAILOVER_COOLDOWN_MS`). To tune for a source that
flaps in your environment, raise the cooldown (fewer probes) and/or the streak
(harder to promote). Lower them only if you need faster failback and the source
is stable enough not to oscillate. The drill in §3 asserts a worst-case
alternating primary produces at most one probe per cooldown and bounded churn.

### 1.6 KYB Provider Fail-Closed Hardening (#1233)

Whenever KYB verification is required (`requireKyb: true` or `NODE_ENV === 'production'`) or any KYB provider is configured:

- **Strict fail-closed contract**: If the KYB provider fails due to network outage, upstream 5xx, timeout, unhandled exception, or missing provider configuration, the oracle strictly fails closed (`isVerified: false`, `composition.outcome: 'rejected-kyb-unavailable'`). The authorization decision surfaces primary code `PAYER_KYB_UNAVAILABLE`, classified under category `dependency` with `retryable: true`.
- **Zero-lockout cache policy**: Outage/dependency rejections (`rejected-kyb-unavailable`) are never cached in Redis or memory. This ensures transient vendor outages do not lock legitimate payers out of verification once the upstream provider recovers.
- **Observability and alerting**:
  - The provider invocation is instrumented with `sourceTracker.noteAttempt('kyb', ok, latencyMs)`.
  - Sustained outages demote the `kyb` source to `unavailable`, flipping `GET /health` and `GET /v1/health` status to `degraded`.
  - Rejections emit `oracle_payer_authorizations_total{code="PAYER_KYB_UNAVAILABLE",decision="deny"}`.
- **Incident triage and recovery**:
  1. Inspect `/health` or `/v1/health` to confirm `sources.kyb` is `unavailable` or `degraded`.
  2. Verify upstream KYB vendor status, API credentials, and network connectivity from oracle pods.
  3. Once upstream recovery is confirmed, subsequent verification requests succeed immediately without service restart or cache purging.

---

## Part 2 — Delta-bound review (#1052)

### 2.1 Decision criteria (defaults in `defaultDeltaBoundsConfig`)

The composite trust score (and the raw feeds) are bounded so no single update
can move a subject further than the feed realistically moves in one step. The
effective bound for a subject is
`max(maxAbsoluteDelta, maxRelativeDelta × |last published value|)` on the
0..100 signal scale. The composite-trust feed is the tightest because it is
what `fund_invoice()` gates on.

| Feed              | `maxRelativeDelta` | `maxAbsoluteDelta` | `quorumSize` |
| ----------------- | ------------------ | ------------------ | ------------ |
| history           | `0.5`              | `40`               | `2`          |
| reputation        | `0.5`              | `40`               | `2`          |
| external          | `0.5`              | `40`               | `2`          |
| kyb               | `0.5`              | `100`              | `2`          |
| composite-trust   | `0.25`             | `25`               | `2`          |

Global knobs:

| Knob                                         | Default | Env override                        |
| -------------------------------------------- | ------- | ----------------------------------- |
| Review-queue cap (oldest evicted past it)    | `100`   | `ORACLE_DELTA_MAX_HELD_UPDATES`      |
| Quorum agreement tolerance (fraction of prop)| `0.25`  | `ORACLE_DELTA_QUORUM_TOLERANCE`      |

Per-feed overrides use `ORACLE_DELTA_BOUND_<FEED>_RELATIVE` / `_ABSOLUTE` /
`_QUORUM`, where `<FEED>` is the feed name upper-cased with `-` replaced by
`_` (so the composite feed is `ORACLE_DELTA_BOUND_COMPOSITE_TRUST_RELATIVE`,
etc.).

### 2.2 Automated behaviour

For each verdict the guard assesses the `composite-trust:<payer>` movement:

1. **Within bound → `publish`.** Normal. The first-ever observation of a payer
   has nothing to compare to, publishes, and becomes the reference.
2. **Over bound, quorum confirmed → `publish-quorum`.** Published *because* at
   least `quorumSize` independent sources agree. A source confirms when it
   succeeded **and** its own normalised value is within
   `quorumAgreementTolerance × max(1, |proposed|)` of the proposal. Failed
   sources never confirm.
3. **Over bound, no quorum → `hold`.** The update is **recorded, never dropped**,
   in the review queue, and the protocol is served a fail-safe verdict:
   - A **worsening** move (proposed score lower than published) is *adopted*
     into the published value — freezing a "clean" score over a sudden
     deterioration would be the worst possible failure mode, so the protocol
     immediately sees the more conservative number. The hold is still queued
     for review.
   - An **improving** move is *frozen* at the last known-good value until a
     human resolves it; the response carries a "Serving last known-good
     verdict" evidence line naming the hold id.

Metrics: `oracle_delta_bound_violations_total{feed}` (each hold),
`oracle_delta_holds_active` (current queue depth),
`oracle_delta_quorum_confirmations_total{feed}` (over-bound-but-published).
The verifier response also carries a `deltaGuard` block
(`{feed, decision, delta, bound, confirmingSources, heldId?}`).

### 2.3 Reviewing held updates

`GET /v1/oracle/delta-holds` returns:

```json
{
  "heldUpdates": [
    {
      "id": "hold-3",
      "feed": "composite-trust",
      "subject": "G…PAYER",
      "lastPublishedValue": 82,
      "proposedValue": 41,
      "delta": 41,
      "bound": 25,
      "confirmingSources": [],
      "heldAtMs": 1758…
    }
  ],
  "stats": {
    "activeHolds": 1, "totalHeld": 1, "totalEvicted": 0,
    "totalQuorumPublished": 0, "accepted": 0, "rejected": 0
  }
}
```

**Triage rule.** Because holds never block funding (the fail-safe rule serves
the conservative verdict meanwhile), a `warning` from
`OracleDeltaHoldsNotDraining` means "someone needs to adjudicate the queue",
not "payers are stuck". A lone hold on a legitimately volatile payer usually
means the bound is too tight; a burst of holds across many payers means either
a corrupted upstream feed or a manipulation attempt — cross-check
`oracle_delta_quorum_confirmations_total` (corroborated = real shift).

**Resolving.** Resolution is applied through the guard's explicit API
`verifier.deltaGuard.resolveHeldUpdate(id, 'accepted' | 'rejected')`:

- `accepted` publishes the held proposed value.
- `rejected` restores the value published before the hold.

Both remove the entry from the queue and are counted in `stats.accepted` /
`stats.rejected`. An unknown id returns `undefined`. (Only the read endpoint is
exposed over HTTP; the resolve call is an in-process operator action.)

---

## Part 3 — Drills

Run the drills before relying on either mechanism, and re-run after changing
any threshold in §1.2 / §2.1.

- **Failover game day (automated):** `oracle-service/src/sourceFailoverDrill.test.ts`.
  Simulates a primary indexer outage (traffic moves to the fallback, health +
  metrics fire without human action), recovery (failback waits for the streak
  **and** the cooldown — a single success does not bounce traffic back),
  flapping (a worst-case alternating primary yields at most one probe per
  cooldown and bounded role churn), and the no-fallback and total-outage paths.
- **Delta-bound coverage:** `oracle-service/src/deltaBounds.test.ts`. Includes
  the extreme single-source spike rejected without quorum, the worsening/improving
  fail-safe directions, the queue cap/eviction, and quorum publishing.

Manual smoke test:

```
# 1. start with a fallback pointed at a deliberately bad mirror
ORACLE_INDEXER_FALLBACK_URL=http://fallback-indexer:3005 pnpm start

# 2. kill the primary; watch the state demote and traffic reroute
curl -s localhost:3010/v1/health | jq '.status, .sources'
curl -s localhost:3010/metrics | grep -E 'oracle_source_health_state|oracle_failover_events_total'

# 3. inspect any held delta updates
curl -s localhost:3010/v1/oracle/delta-holds | jq

# 4. restore the primary; confirm failback only after the streak + cooldown
```

Expected: `sources` shows `indexer-primary` at `unavailable` and
`indexer-fallback` at `healthy` during the outage; `oracle_source_health_state`
carries the `2`/`0` ranks; `oracle_failover_events_total{source="indexer-primary"}`
counts the demotion. Nothing pages for a *single* blip — degradation is
self-correcting.
