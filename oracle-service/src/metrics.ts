import client, { type Registry } from 'prom-client';

import {
  PAYER_AUTHORIZATION_FAILURES,
  PAYER_AUTHORIZATION_TAXONOMY_VERSION,
  type PayerAuthorizationFailureCode,
} from './authorization';

/**
 * Latency SLOs per oracle pipeline stage, in milliseconds (issue #1054).
 *
 * - fetch: source fetch (indexer history + on-chain reputation, in parallel).
 * - aggregate: trust-score computation and fraud-signal detection.
 * - publish: cache write plus response serialization.
 */
export const FETCH_SLO_MS = 500;
export const AGGREGATE_SLO_MS = 300;
export const PUBLISH_SLO_MS = 100;

/**
 * Burn-rate alert threshold (issue #1054): the ratio of SLO-violating stage
 * executions to total executions over the alert window that pages the
 * on-call. A burn rate above this means the stage is consuming its error
 * budget fast enough to breach the SLO within the window.
 */
export const SLO_BURN_RATE_ALERT_THRESHOLD = 0.01;

/**
 * sloBurnRate returns violations / total (0 when nothing has executed yet).
 * Callers compare the result against SLO_BURN_RATE_ALERT_THRESHOLD.
 */
export function sloBurnRate(violations: number, total: number): number {
  if (!Number.isFinite(violations) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.max(0, violations) / total;
}

export interface OracleMetrics {
  registry: Registry;
  verificationTotal: client.Counter<string>;
  cacheHitsTotal: client.Counter<string>;
  cacheMissesTotal: client.Counter<string>;
  staleResponsesTotal: client.Counter<string>;
  verificationDuration: client.Histogram<string>;
  /** Per-stage pipeline latency (#1054): fetch, aggregate, publish. */
  fetchDuration: client.Histogram<string>;
  aggregateDuration: client.Histogram<string>;
  publishDuration: client.Histogram<string>;
  /** Executions breaching `FETCH/AGGREGATE/PUBLISH_SLO_MS`. */
  fetchSloViolationsTotal: client.Counter<string>;
  aggregateSloViolationsTotal: client.Counter<string>;
  publishSloViolationsTotal: client.Counter<string>;
  /** Last-known-good verdicts served while every source was down (#1057). */
  degradedResponsesTotal: client.Counter<string>;
  lastKnownGoodAgeSeconds: client.Gauge<string>;
  /** Verdicts partitioned by composition outcome — the alerting signal. */
  verificationOutcomeTotal: client.Counter<string>;
  /** Individual fraud heuristics as they fire, by signal name. */
  fraudSignalTotal: client.Counter<string>;
  /** Rolling share of verdicts carrying at least one fraud signal, 0..1. */
  fraudFlagRatio: client.Gauge<string>;
  /** External provider lookups by resulting status. */
  externalVerificationTotal: client.Counter<string>;
  /**
   * Audit-trail integrity walks that came back inconsistent (#1055). Any
   * non-zero value means history was edited or truncated and is an incident.
   */
  auditIntegrityFailureTotal: client.Counter<string>;
  /** Attributed cost in USD */
  costUsdTotal: client.Counter<string>;
  /** SLO error-budget burn rate */
  sloErrorBudgetBurn: client.Gauge<string>;
  /** Latency SLO violations */
  latencySloViolationsTotal: client.Counter<string>;
  /** Composite-score updates rejected for exceeding the single-bound delta. */
  deltaBoundViolationsTotal: client.Counter<string>;
  /** Held delta-bound updates currently awaiting human review. */
  deltaHoldsActive: client.Gauge<string>;
  /** Over-bound updates published on the strength of a source quorum. */
  deltaQuorumConfirmationsTotal: client.Counter<string>;
  /** Health state per verification source (0 healthy, 1 degraded, 2 unavailable). */
  sourceHealthState: client.Gauge<string>;
  /** Source health transitions away from healthy — the failover trigger. */
  failoverEventsTotal: client.Counter<string>;
  /** Payer checks by authorization decision (allow / deny), #1232. */
  payerAuthorizationDecisionsTotal: client.Counter<string>;
  /** Payer authorization failures by taxonomy code and category, #1232. */
  payerAuthorizationFailuresTotal: client.Counter<string>;
  /** Constant 1 labelled with the active taxonomy version — proof the control is loaded. */
  payerAuthorizationTaxonomyInfo: client.Gauge<string>;
  /** KYB observations recorded on published verdicts (#1236). */
  kybProvenanceTotal: client.Counter<string>;
  /** Cached KYB decisions discarded and re-fetched because they outlived the TTL (#1237). */
  kybRevalidationsTotal: client.Counter<string>;
  /** Constant 1 labelled with the loaded KYB wiring — proof the control is active (#1235). */
  kybConfigInfo: client.Gauge<string>;
  /** Record one verdict against the outcome, fraud and ratio metrics. */
  recordVerificationOutcome(result: VerificationOutcomeSample): void;
  /** Record one payer check's authorization result against the taxonomy metrics. */
  recordPayerAuthorization(sample: PayerAuthorizationSample): void;
}

export interface PayerAuthorizationSample {
  /** Every failure code that applied; empty for an allowed payer. */
  codes: PayerAuthorizationFailureCode[];
  /** `request` for checks rejected before a verdict existed. */
  stage: 'request' | 'verdict';
  cacheHit: boolean;
}

export interface VerificationOutcomeSample {
  outcome: string;
  fraudSignals: string[];
  externalStatus: string;
  cacheHit: boolean;
}

/**
 * Window over which the fraud-flag ratio is computed.
 *
 * A counter alone cannot answer "is the *share* of flagged submissions
 * abnormal?" without a rate() over two series, and the alert we actually want
 * — a sudden spike in fraud-flagged submissions, which signals either an attack
 * or a broken heuristic — is naturally expressed against a ratio. Keeping a
 * bounded in-process window makes that ratio available directly.
 */
export const FRAUD_RATIO_WINDOW = 200;

export function createOracleMetrics(): OracleMetrics {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const verificationTotal = new client.Counter({
    name: 'oracle_verification_requests_total',
    help: 'Total number of oracle verification requests received',
    registers: [registry],
  });

  const cacheHitsTotal = new client.Counter({
    name: 'oracle_cache_hits_total',
    help: 'Total number of oracle cache hits',
    registers: [registry],
  });

  const cacheMissesTotal = new client.Counter({
    name: 'oracle_cache_misses_total',
    help: 'Total number of oracle cache misses',
    registers: [registry],
  });

  const staleResponsesTotal = new client.Counter({
    name: 'oracle_stale_responses_total',
    help: 'Total number of stale oracle responses returned',
    registers: [registry],
  });

  const verificationDuration = new client.Histogram({
    name: 'oracle_verification_duration_seconds',
    help: 'Oracle verification latency in seconds',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  });

  const fetchDuration = new client.Histogram({
    name: 'oracle_fetch_duration_seconds',
    help: 'Oracle source-fetch stage latency in seconds (indexer history + on-chain reputation)',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  });

  const aggregateDuration = new client.Histogram({
    name: 'oracle_aggregate_duration_seconds',
    help: 'Oracle aggregate stage latency in seconds (trust-score computation)',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  });

  const publishDuration = new client.Histogram({
    name: 'oracle_publish_duration_seconds',
    help: 'Oracle publish stage latency in seconds (cache write + response serialization)',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  });

  const fetchSloViolationsTotal = new client.Counter({
    name: 'oracle_fetch_slo_violations_total',
    help: 'Total number of fetch-stage executions breaching FETCH_SLO_MS',
    registers: [registry],
  });

  const aggregateSloViolationsTotal = new client.Counter({
    name: 'oracle_aggregate_slo_violations_total',
    help: 'Total number of aggregate-stage executions breaching AGGREGATE_SLO_MS',
    registers: [registry],
  });

  const publishSloViolationsTotal = new client.Counter({
    name: 'oracle_publish_slo_violations_total',
    help: 'Total number of publish-stage executions breaching PUBLISH_SLO_MS',
    registers: [registry],
  });

  const degradedResponsesTotal = new client.Counter({
    name: 'oracle_degraded_responses_total',
    help: 'Total number of degraded-mode (last-known-good) responses served',
    registers: [registry],
  });

  const lastKnownGoodAgeSeconds = new client.Gauge({
    name: 'oracle_last_known_good_age_seconds',
    help: 'Age in seconds of the last-known-good cached response served in degraded mode',
    registers: [registry],
  });

  const verificationOutcomeTotal = new client.Counter({
    name: 'oracle_verification_outcome_total',
    help: 'Oracle verification verdicts by composition outcome',
    labelNames: ['outcome', 'external_status', 'cache_hit'] as const,
    registers: [registry],
  });

  const fraudSignalTotal = new client.Counter({
    name: 'oracle_fraud_signal_total',
    help: 'Individual fraud heuristics fired, by signal',
    labelNames: ['signal'] as const,
    registers: [registry],
  });

  const fraudFlagRatio = new client.Gauge({
    name: 'oracle_fraud_flag_ratio',
    help: `Share of the last ${FRAUD_RATIO_WINDOW} verdicts carrying a fraud signal (0..1)`,
    registers: [registry],
  });

  const externalVerificationTotal = new client.Counter({
    name: 'oracle_external_verification_total',
    help: 'External provider lookups by resulting status',
    labelNames: ['status'] as const,
    registers: [registry],
  });

  const costUsdTotal = new client.Counter({
    name: 'oracle_cost_usd_total',
    help: 'Attributed cost in USD by operation',
    labelNames: ['operation'] as const,
    registers: [registry],
  });

  const auditIntegrityFailureTotal = new client.Counter({
    name: 'oracle_audit_integrity_failures_total',
    help: 'Audit-trail integrity checks that found the chain inconsistent',
    registers: [registry],
  });

  const sloErrorBudgetBurn = new client.Gauge({
    name: 'oracle_slo_error_budget_burn',
    help: 'Current SLO error-budget burn rate by SLO name',
    labelNames: ['slo'] as const,
    registers: [registry],
  });

  const latencySloViolationsTotal = new client.Counter({
    name: 'oracle_latency_slo_violations_total',
    help: 'Count of verification latency SLO violations (p95 > threshold)',
    registers: [registry],
  });

  const deltaBoundViolationsTotal = new client.Counter({
    name: 'oracle_delta_bound_violations_total',
    help: 'Updates held for review after exceeding the max single-update delta bound',
    labelNames: ['feed'] as const,
    registers: [registry],
  });

  const deltaHoldsActive = new client.Gauge({
    name: 'oracle_delta_holds_active',
    help: 'Delta-bound updates currently held pending human review',
    registers: [registry],
  });

  const deltaQuorumConfirmationsTotal = new client.Counter({
    name: 'oracle_delta_quorum_confirmations_total',
    help: 'Over-bound updates published because an independent source quorum confirmed them',
    labelNames: ['feed'] as const,
    registers: [registry],
  });

  const sourceHealthState = new client.Gauge({
    name: 'oracle_source_health_state',
    help: 'Verification source health: 0 healthy, 1 degraded, 2 unavailable',
    labelNames: ['source'] as const,
    registers: [registry],
  });

  const failoverEventsTotal = new client.Counter({
    name: 'oracle_failover_events_total',
    help: 'Source health transitions out of the healthy state',
    labelNames: ['source'] as const,
    registers: [registry],
  });

  const payerAuthorizationDecisionsTotal = new client.Counter({
    name: 'oracle_payer_authorization_decisions_total',
    help: 'Payer checks by authorization decision (allow/deny)',
    labelNames: ['decision', 'stage'] as const,
    registers: [registry],
  });

  const payerAuthorizationFailuresTotal = new client.Counter({
    name: 'oracle_payer_authorization_failures_total',
    help: 'Payer authorization failures by taxonomy code',
    labelNames: ['code', 'category', 'primary', 'cache_hit'] as const,
    registers: [registry],
  });

  const payerAuthorizationTaxonomyInfo = new client.Gauge({
    name: 'oracle_payer_authorization_taxonomy_info',
    help: 'Active payer authorization failure taxonomy version (always 1)',
    labelNames: ['version'] as const,
    registers: [registry],
  });
  payerAuthorizationTaxonomyInfo.set({ version: PAYER_AUTHORIZATION_TAXONOMY_VERSION }, 1);

  const kybProvenanceTotal = new client.Counter({
    name: 'oracle_kyb_provenance_total',
    help: 'KYB observations recorded on published verdicts, by provider, status and source',
    labelNames: ['provider', 'status', 'source'] as const,
    registers: [registry],
  });

  const kybRevalidationsTotal = new client.Counter({
    name: 'oracle_kyb_revalidations_total',
    help: 'Cached KYB decisions discarded and re-fetched because they outlived the decision TTL',
    labelNames: ['reason'] as const,
    registers: [registry],
  });

  const kybConfigInfo = new client.Gauge({
    name: 'oracle_kyb_config_info',
    help: 'Loaded KYB configuration (always 1): provider identity, requirement flag and decision TTL',
    labelNames: ['provider', 'required', 'decision_ttl_ms'] as const,
    registers: [registry],
  });

  function recordPayerAuthorization(sample: PayerAuthorizationSample): void {
    payerAuthorizationDecisionsTotal.inc({
      decision: sample.codes.length === 0 ? 'allow' : 'deny',
      stage: sample.stage,
    });
    sample.codes.forEach((code, index) => {
      payerAuthorizationFailuresTotal.inc({
        code,
        category: PAYER_AUTHORIZATION_FAILURES[code].category,
        primary: String(index === 0),
        cache_hit: String(sample.cacheHit),
      });
    });
  }

  // Bounded ring of recent verdicts backing the ratio gauge.
  const recentFlags: boolean[] = [];

  function recordVerificationOutcome(result: VerificationOutcomeSample): void {
    verificationOutcomeTotal.inc({
      outcome: result.outcome,
      external_status: result.externalStatus,
      cache_hit: String(result.cacheHit),
    });

    externalVerificationTotal.inc({ status: result.externalStatus });

    for (const signal of result.fraudSignals) {
      fraudSignalTotal.inc({ signal });
    }

    // Cache hits are replays of an earlier verdict, not new observations.
    // Counting them would let one flagged payer retrying in a loop drag the
    // ratio up and page someone for a single actor.
    if (result.cacheHit) {
      return;
    }

    recentFlags.push(result.fraudSignals.length > 0);
    if (recentFlags.length > FRAUD_RATIO_WINDOW) {
      recentFlags.shift();
    }

    const flagged = recentFlags.filter(Boolean).length;
    fraudFlagRatio.set(recentFlags.length === 0 ? 0 : flagged / recentFlags.length);
  }

  // Cost attribution: $0.001 per verification (RPC + attestation)
  function observeVerificationCost(): void {
    try {
      costUsdTotal.inc({ operation: 'verification' }, 0.001);
    } catch {}
  }

  const wrappedRecordVerificationOutcome = (result: VerificationOutcomeSample): void => {
    recordVerificationOutcome(result);
    observeVerificationCost();
  };

  return {
    registry,
    verificationTotal,
    cacheHitsTotal,
    cacheMissesTotal,
    staleResponsesTotal,
    verificationDuration,
    fetchDuration,
    aggregateDuration,
    publishDuration,
    fetchSloViolationsTotal,
    aggregateSloViolationsTotal,
    publishSloViolationsTotal,
    degradedResponsesTotal,
    lastKnownGoodAgeSeconds,
    verificationOutcomeTotal,
    fraudSignalTotal,
    fraudFlagRatio,
    externalVerificationTotal,
    auditIntegrityFailureTotal,
    costUsdTotal,
    sloErrorBudgetBurn,
    latencySloViolationsTotal,
    deltaBoundViolationsTotal,
    deltaHoldsActive,
    deltaQuorumConfirmationsTotal,
    sourceHealthState,
    failoverEventsTotal,
    payerAuthorizationDecisionsTotal,
    payerAuthorizationFailuresTotal,
    payerAuthorizationTaxonomyInfo,
    kybProvenanceTotal,
    kybRevalidationsTotal,
    kybConfigInfo,
    recordVerificationOutcome: wrappedRecordVerificationOutcome,
    recordPayerAuthorization,
  };
}
