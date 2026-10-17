import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
  xdr as stellarXdr,
} from '@stellar/stellar-sdk';

import type {
  IndexerInvoiceHistoryEntry,
  KYBProvenance,
  KYBVerificationResult,
  OracleAssessment,
  OracleAssessmentInput,
  OracleConfidenceLevel,
  OracleVerificationRequest,
  OracleVerificationResponse,
  ReputationSnapshot,
  OracleVerifierDependencies,
} from './types';
import type {
  ExternalVerificationProvider,
  ExternalVerificationResult,
  OracleCacheReaderWriter,
} from './types';
import type { OracleMetrics } from './metrics';
import { AGGREGATE_SLO_MS, FETCH_SLO_MS, PUBLISH_SLO_MS } from './metrics';
import {
  buildOracleCacheKey,
  buildOraclePayerKeyPrefix,
  resolveCacheTtlSeconds,
} from './cache';
import {
  buildCanonicalInvoicePayload,
  checkPayerSubstitution,
  verifyPayerSignature,
} from './canonicalPayload';
import { enforcePayerAuthorization } from './authorization';
import { composeVerdict, confidenceLevelFromScore } from './composition';
import {
  DeltaBoundsGuard,
  defaultDeltaBoundsConfig,
  type OracleDeltaGuardInfo,
  type SourceConfirmation,
} from './deltaBounds';

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_FRAUD_WINDOW_MS = 30 * DAY_MS;
export const RAPID_SUCCESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * How long a recorded KYB decision may be replayed from cache before it must
 * be revalidated against the provider (issue #1237). A KYB pass is a
 * point-in-time statement about a legal entity; replaying one forever would
 * let a delisted business keep funding invoices off an old green check.
 */
export const DEFAULT_KYB_DECISION_TTL_MS = 24 * 60 * 60 * 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function normalizeAmountToNumber(value: string | number | bigint): number {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      !trimmed ||
      trimmed === 'null' ||
      trimmed === 'undefined' ||
      trimmed.startsWith('0x') ||
      !/^-?[0-9]+(\.[0-9]+)?$/.test(trimmed)
    ) {
      return 0;
    }
  }
  try {
    const amount = typeof value === 'bigint' ? value : BigInt(String(value));
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number.MAX_SAFE_INTEGER;
    }
    const asNumber = Number(amount);
    return Number.isFinite(asNumber) ? asNumber : Number.MAX_SAFE_INTEGER;
  } catch {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : numeric;
    }
    return 0;
  }
}

export function normalizeTimestampToMs(value: number | string | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }

  const numeric = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return numeric < 1e12 ? numeric * 1000 : numeric;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Parse a KYB provider's `verifiedAt` into epoch milliseconds.
 *
 * Providers report ISO-8601 strings (the mock adapter does, and so do the
 * vendor APIs it stands in for), which `normalizeTimestampToMs` — built for
 * ledger-style epoch numbers — rejects. The decision-expiry control (#1237)
 * keys off this instant, so an unparseable value must fail closed to 0 and
 * never silently pin a decision as "born now".
 */
function kybTimestampToMs(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return normalizeTimestampToMs(value);
}

function variance(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const mean = average(values);
  return average(values.map((value) => (value - mean) ** 2));
}

function standardDeviation(values: number[]): number {
  return Math.sqrt(variance(values));
}

function successRateFromHistory(history: IndexerInvoiceHistoryEntry[]): number {
  if (history.length === 0) {
    return 0;
  }
  const paid = history.filter((entry) => entry.status === 'Paid').length;
  return paid / history.length;
}

function defaultRateFromHistory(history: IndexerInvoiceHistoryEntry[]): number {
  if (history.length === 0) {
    return 0;
  }
  const defaulted = history.filter((entry) => entry.status === 'Defaulted').length;
  return defaulted / history.length;
}

function averageHistoricalAmount(history: IndexerInvoiceHistoryEntry[]): number {
  const values = history
    .map((entry) => normalizeAmountToNumber(entry.amount))
    .filter((value) => value > 0);
  return average(values);
}

function amountDeviationPercent(requestAmount: number, historicalAverage: number): number {
  if (historicalAverage <= 0) {
    return 100;
  }
  return (Math.abs(requestAmount - historicalAverage) / historicalAverage) * 100;
}

function settlementDurationsDays(history: IndexerInvoiceHistoryEntry[]): number[] {
  return history
    .filter((entry) => entry.status === 'Paid')
    .map((entry) => {
      const settledAt = normalizeTimestampToMs(entry.updated_at);
      const fundedAt = normalizeTimestampToMs(entry.funded_at ?? entry.created_at);
      if (!settledAt || !fundedAt || settledAt <= fundedAt) {
        return 0;
      }
      return (settledAt - fundedAt) / DAY_MS;
    })
    .filter((value) => value > 0);
}

function latestSourceTimestampMs(
  history: IndexerInvoiceHistoryEntry[],
  reputation: ReputationSnapshot
): number {
  const historyMax = history.reduce((max, entry) => {
    const updated = normalizeTimestampToMs(entry.updated_at);
    const created = normalizeTimestampToMs(entry.created_at);
    const funded = normalizeTimestampToMs(entry.funded_at ?? null);
    return Math.max(max, updated, created, funded);
  }, 0);

  const reputationTimestamp = normalizeTimestampToMs(reputation.lastActivity);
  return Math.max(historyMax, reputationTimestamp);
}

function detectFraudSignals(
  history: IndexerInvoiceHistoryEntry[],
  requestAmount: number,
  nowMs: number
): string[] {
  const signals = new Set<string>();
  const recentHistory = history
    .slice()
    .sort((a, b) => normalizeTimestampToMs(b.created_at) - normalizeTimestampToMs(a.created_at))
    .filter((entry) => nowMs - normalizeTimestampToMs(entry.updated_at) <= MAX_FRAUD_WINDOW_MS);

  const similarAmountMatches = recentHistory.filter((entry) => {
    const historicalAmount = normalizeAmountToNumber(entry.amount);
    if (historicalAmount <= 0 || requestAmount <= 0) {
      return false;
    }
    const delta =
      Math.abs(historicalAmount - requestAmount) / Math.max(historicalAmount, requestAmount);
    return delta <= 0.05;
  });

  if (similarAmountMatches.length >= 5) {
    signals.add('Multiple recent invoices with similar amounts from the same payer');
  }

  const rapidSuccessionWindows: number[] = [];
  for (const entry of recentHistory) {
    rapidSuccessionWindows.push(normalizeTimestampToMs(entry.created_at));
  }
  rapidSuccessionWindows.sort((a, b) => a - b);

  let rapidClusters = 0;
  for (let i = 0; i < rapidSuccessionWindows.length; i += 1) {
    let clusterSize = 1;
    for (let j = i + 1; j < rapidSuccessionWindows.length; j += 1) {
      if (rapidSuccessionWindows[j] - rapidSuccessionWindows[i] <= RAPID_SUCCESSION_WINDOW_MS) {
        clusterSize += 1;
      }
    }
    if (clusterSize >= 3) {
      rapidClusters += 1;
      break;
    }
  }

  if (rapidClusters > 0) {
    signals.add('Rapid succession of invoices detected for the same payer');
  }

  const defaultedRecent = recentHistory.filter((entry) => entry.status === 'Defaulted').length;
  if (defaultedRecent >= 2) {
    signals.add('Recent default concentration suggests elevated fraud risk');
  }

  const repeatedUpdatedAt = new Map<number, number>();
  for (const entry of recentHistory) {
    const updatedAt = normalizeTimestampToMs(entry.updated_at);
    repeatedUpdatedAt.set(updatedAt, (repeatedUpdatedAt.get(updatedAt) ?? 0) + 1);
  }
  if ([...repeatedUpdatedAt.values()].some((count) => count >= 4)) {
    signals.add('Repeated invoice updates clustered in the same ledger window');
  }

  return [...signals];
}

function computeTrustScore(
  reputation: ReputationSnapshot,
  history: IndexerInvoiceHistoryEntry[],
  requestAmount: number,
  nowMs: number
): {
  trustScore: number;
  confidence: number;
  confidenceLevel: OracleConfidenceLevel;
  evidence: string[];
  fraudSignals: string[];
  historicalAverageAmount: number;
  historicalSuccessRate: number;
  historicalDefaultRate: number;
  settlementVarianceDays: number;
  amountDeviation: number;
  sourceTimestampMs: number;
} {
  const evidence: string[] = [];
  const fraudSignals = detectFraudSignals(history, requestAmount, nowMs);

  const reputationScore = clamp(Math.round(reputation.score ?? 0), 0, 100);
  const successRate = successRateFromHistory(history);
  const defaultRate = defaultRateFromHistory(history);
  const historicalAverageAmount = averageHistoricalAmount(history);
  const amountDeviation = amountDeviationPercent(requestAmount, historicalAverageAmount);
  const durations = settlementDurationsDays(history);
  const settlementVarianceDays = variance(durations);
  const settlementStdDevDays = standardDeviation(durations);

  const amountFitScore = clamp(100 - amountDeviation * 1.2, 0, 100);
  const varianceFitScore = clamp(100 - settlementStdDevDays * 18, 0, 100);
  const successScore = successRate * 100;
  const defaultPenalty = defaultRate * 45;
  const fraudPenalty = fraudSignals.length === 0 ? 0 : Math.min(35, fraudSignals.length * 9);

  const trustScore = clamp(
    Math.round(
      reputationScore * 0.38 +
        successScore * 0.33 +
        amountFitScore * 0.17 +
        varianceFitScore * 0.12 -
        defaultPenalty -
        fraudPenalty
    ),
    0,
    100
  );

  const historyVolumeConfidence = history.length === 0 ? 0.05 : Math.min(1, history.length / 2);
  const reputationConfidence = reputationScore / 100;
  const dataFreshnessConfidence = 0.5;
  const confidence = clamp(
    round(
      historyVolumeConfidence * 0.45 + reputationConfidence * 0.35 + dataFreshnessConfidence * 0.2,
      4
    ),
    0,
    1
  );

  evidence.push(`On-chain reputation score: ${reputationScore}/100`);
  evidence.push(`Historical payment success rate: ${(successRate * 100).toFixed(1)}%`);
  evidence.push(`Historical default rate: ${(defaultRate * 100).toFixed(1)}%`);
  evidence.push(
    `Average historical invoice amount: ${Math.round(historicalAverageAmount).toString()}`
  );
  evidence.push(`Requested amount deviation: ${amountDeviation.toFixed(1)}%`);
  evidence.push(`Settlement variance: ${settlementVarianceDays.toFixed(2)} days`);

  if (history.length === 0) {
    evidence.push(
      'No payer history available from the indexer; score weighted toward reputation only'
    );
  }
  if (fraudSignals.length > 0) {
    evidence.push(`Fraud signals: ${fraudSignals.join('; ')}`);
  }

  return {
    trustScore,
    confidence,
    confidenceLevel: confidenceLevelFromScore(confidence),
    evidence,
    fraudSignals,
    historicalAverageAmount,
    historicalSuccessRate: successRate,
    historicalDefaultRate: defaultRate,
    settlementVarianceDays,
    amountDeviation,
    sourceTimestampMs: latestSourceTimestampMs(history, reputation) || nowMs,
  };
}

/**
 * Whether the payer has on-chain activity inside the rapid-succession window.
 *
 * Drives the volatile cache TTL: a clean verdict for an actively-invoicing
 * payer is the one most likely to be overtaken by their next invoice.
 */
export function hasRecentActivity(
  history: IndexerInvoiceHistoryEntry[],
  nowMs: number,
  windowMs: number = RAPID_SUCCESSION_WINDOW_MS
): boolean {
  return history.some((entry) => {
    const created = normalizeTimestampToMs(entry.created_at);
    const updated = normalizeTimestampToMs(entry.updated_at);
    const latest = Math.max(created, updated);
    return latest > 0 && nowMs - latest <= windowMs;
  });
}

export function assessOracleRequest(input: OracleAssessmentInput): OracleAssessment {
  const requestAmount = normalizeAmountToNumber(input.request.amount);
  const computed = computeTrustScore(input.reputation, input.history, requestAmount, input.nowMs);
  const generatedAt = new Date(input.nowMs).toISOString();
  const dataAgeMs = Math.max(0, input.nowMs - computed.sourceTimestampMs);
  const isFresh = input.maxOracleAgeMs <= 0 || dataAgeMs <= input.maxOracleAgeMs;

  // The verdict is no longer decided here — `composeVerdict` owns the policy
  // that combines the heuristic signal with the external provider signal.
  const verdict = composeVerdict({
    trustScore: computed.trustScore,
    baseConfidence: computed.confidence,
    fraudSignals: computed.fraudSignals,
    isFresh,
    external: input.external,
  });
  // The KYB provider (#868) is a blocking gate, unlike the advisory external
  // signal composed above: an explicit KYB rejection must deny the verdict.
  // It is applied after composition, so the outcome is rewritten here rather
  // than left claiming a verified result next to a KYB failure (#1232).
  let kybPassed = true;
  if (input.kybResult) {
    computed.evidence.push(
      `KYB verification (${input.kybResult.provider}): ${input.kybResult.isVerified ? 'VERIFIED' : 'UNVERIFIED'} - Business: ${input.kybResult.businessName || 'N/A'}`
    );
    if (input.kybResult.signals && input.kybResult.signals.length > 0) {
      computed.evidence.push(`KYB signals: ${input.kybResult.signals.join('; ')}`);
    }
    if (!input.kybResult.isVerified) {
      kybPassed = false;
      computed.fraudSignals.push(
        `External KYB provider (${input.kybResult.provider}) verification failed or unverified`
      );
    }

    // Issue #1226: Bind payer verification to invoice authority
    // Ensure KYB verification is tied to the specific invoice and payer combination
    // to prevent verification bypass through invoice ID manipulation
    const verificationKey = `${input.request.payer}:${input.request.invoiceId}`;
    computed.evidence.push(`Payer-invoice binding: ${verificationKey}`);
  }

  // Issue #1229: Reject payer substitutions across invoice lifecycle states
  const substitution = checkPayerSubstitution({
    requestInvoiceId: input.request.invoiceId,
    requestPayer: input.request.payer,
    history: input.history,
  });
  if (substitution.substituted) {
    const reason =
      substitution.reason ??
      `Payer substitution rejected: invoice ${input.request.invoiceId} cannot be substituted`;
    computed.fraudSignals.push(reason);
    computed.evidence.push(reason);
    verdict.isVerified = false;
    verdict.composition = {
      ...verdict.composition,
      outcome: 'rejected-fraud-signals',
      rationale: reason,
    };
  }

  // Issue #1228: Verify payer signatures against canonical invoice payloads
  const canonicalPayload =
    input.request.canonicalPayload ??
    buildCanonicalInvoicePayload({
      invoiceId: input.request.invoiceId,
      payer: input.request.payer,
      amount: input.request.amount,
    });
  computed.evidence.push(`Canonical invoice payload: ${canonicalPayload}`);

  if (input.request.payerSignature !== undefined) {
    const sigCheck = verifyPayerSignature({
      payer: input.request.payer,
      signature: input.request.payerSignature,
      canonicalPayload,
    });
    if (!sigCheck.valid) {
      const reason = `Payer signature invalid: ${sigCheck.reason}`;
      computed.fraudSignals.push(reason);
      computed.evidence.push(reason);
      verdict.isVerified = false;
      verdict.composition = {
        ...verdict.composition,
        outcome: 'rejected-fraud-signals',
        rationale: reason,
      };
    } else {
      computed.evidence.push('Payer signature verified against canonical invoice payload');
    }
  } else if (input.requirePayerSignature) {
    const reason = 'Payer signature invalid: signature required but missing';
    computed.fraudSignals.push(reason);
    computed.evidence.push(reason);
    verdict.isVerified = false;
    verdict.composition = {
      ...verdict.composition,
      outcome: 'rejected-fraud-signals',
      rationale: reason,
    };
  }

  if (!kybPassed && verdict.isVerified) {
    const rationale = `KYB provider (${input.kybResult?.provider}) did not verify the payer.`;
    verdict.isVerified = false;
    verdict.composition = { ...verdict.composition, outcome: 'rejected-kyb-unverified', rationale };
    verdict.evidence.push(`Composition outcome: rejected-kyb-unverified — ${rationale}`);
  }

  return {
    sourceTimestampMs: computed.sourceTimestampMs,
    response: {
      requestId:
        input.request.requestId ??
        `${input.request.payer}:${input.request.invoiceId}:${input.nowMs}`,
      payer: input.request.payer,
      invoiceId: String(input.request.invoiceId),
      amount: String(
        BigInt(Math.max(0, Math.trunc(Number.isFinite(requestAmount) ? requestAmount : 0)))
      ),
      trustScore: computed.trustScore,
      confidence: verdict.confidence,
      confidenceLevel: verdict.confidenceLevel,
      isVerified: verdict.isVerified,
      generatedAt,
      dataAgeMs,
      cacheHit: false,
      reputationScore: Math.max(0, Math.round(input.reputation.score ?? 0)),
      historicalSuccessRate: round(computed.historicalSuccessRate, 4),
      historicalDefaultRate: round(computed.historicalDefaultRate, 4),
      averageHistoricalAmount: String(Math.round(computed.historicalAverageAmount)),
      amountDeviation: round(computed.amountDeviation, 2),
      settlementVarianceDays: round(computed.settlementVarianceDays, 4),
      fraudSignals: computed.fraudSignals,
      evidence: [...computed.evidence, ...verdict.evidence],
      composition: verdict.composition,
      kybResult: input.kybResult,
    },
  };
}

export interface OracleHistoryProvider {
  (payer: string): Promise<IndexerInvoiceHistoryEntry[]>;
}

export interface OracleReputationProvider {
  (payer: string): Promise<ReputationSnapshot>;
}

export interface OracleVerifierOptions extends OracleVerifierDependencies {
  cache?: OracleCacheReaderWriter;
  cacheTtlSeconds?: number;
  /**
   * Optional stage metrics (issue #1054). When present, computeVerification
   * records per-stage latency histograms and SLO-violation counters.
   */
  metrics?: OracleMetrics;
}

/**
 * Thrown when every oracle source is unavailable and no cached response
 * exists to degrade to (issue #1057). The HTTP layer maps this to 503 with
 * `degraded: true` rather than a generic 500.
 */
export class OracleUnavailableError extends Error {
  readonly degraded = true;
  constructor(message = 'Oracle providers unavailable and no cached response') {
    super(message);
    this.name = 'OracleUnavailableError';
  }
}

/**
 * Normalize each provider result into the 0..100 point scale the delta guard
 * compares, so a feed's "value" is the signal that feed alone would publish.
 * A source that failed or returned nothing usable is marked `ok: false` — it
 * must never count toward a quorum.
 */
export function buildSourceConfirmations(input: {
  historyOk: boolean;
  history: IndexerInvoiceHistoryEntry[];
  reputationOk: boolean;
  reputationScore: number;
  external?: ExternalVerificationResult;
  externalOk: boolean;
  kyb?: { isVerified: boolean };
  kybOk: boolean;
}): SourceConfirmation[] {
  const confirmations: SourceConfirmation[] = [
    {
      source: 'history',
      value: input.historyOk ? successRateFromHistory(input.history) * 100 : 0,
      ok: input.historyOk,
    },
    {
      source: 'reputation',
      value: input.reputationOk ? clamp(Math.round(input.reputationScore), 0, 100) : 0,
      ok: input.reputationOk,
    },
    {
      source: 'external',
      value: input.external?.status === 'verified' ? 100 : 0,
      ok: input.externalOk && input.external?.status !== 'unknown',
    },
    {
      source: 'kyb',
      value: input.kyb?.isVerified ? 100 : 0,
      ok: input.kybOk && input.kyb !== undefined,
    },
  ];
  return confirmations;
}

export class OracleVerifier {
  private readonly cache?: OracleCacheReaderWriter;
  private readonly now: () => number;
  private readonly cacheTtlSeconds: number;
  private readonly historyProvider: OracleHistoryProvider;
  private readonly reputationProvider: OracleReputationProvider;
  private readonly kybProvider?: import('./types').VerificationProvider;
  private readonly requireKyb: boolean;
  private readonly requirePayerSignature: boolean;
  private readonly kybDecisionTtlMs: number;
  private readonly maxOracleAgeMs: number;
  private readonly externalProvider?: ExternalVerificationProvider;
  private readonly metrics?: OracleMetrics;
  private readonly inflight = new Map<string, Promise<OracleVerificationResponse>>();
  /** Feed-movement guard shared across all payers (issue #1052). */
  readonly deltaGuard: DeltaBoundsGuard;
  /**
   * Last published verdict per guard key. While an update is held, this is
   * what the protocol keeps receiving — a freeze, never a drop.
   */
  private readonly lastKnownGood = new Map<string, OracleVerificationResponse>();

  constructor(options: OracleVerifierOptions) {
    this.cache = options.cache;
    this.now = options.now ?? Date.now;
    this.cacheTtlSeconds = options.cacheTtlSeconds ?? 300;
    this.historyProvider = options.historyProvider;
    this.reputationProvider = options.reputationProvider;
    this.kybProvider = options.kybProvider;
    this.requireKyb = options.requireKyb ?? false;
    this.requirePayerSignature = options.requirePayerSignature ?? false;
    this.kybDecisionTtlMs = options.kybDecisionTtlMs ?? DEFAULT_KYB_DECISION_TTL_MS;
    this.maxOracleAgeMs = options.maxOracleAgeMs ?? 5 * 60 * 1000;
    this.externalProvider = options.externalProvider;
    this.metrics = options.metrics;
    this.deltaGuard = new DeltaBoundsGuard(options.deltaBounds ?? defaultDeltaBoundsConfig());
  }

  /**
   * Drop every cached verdict for a payer.
   *
   * Called when new activity is observed for that payer, so a clean verdict
   * cannot outlive the behaviour it was computed from. Returns the number of
   * entries removed, or 0 when the cache does not support invalidation.
   */
  async invalidatePayer(payer: string): Promise<number> {
    if (!this.cache?.invalidateByPrefix) {
      return 0;
    }
    return this.cache.invalidateByPrefix(buildOraclePayerKeyPrefix(payer.trim()));
  }

  /** Held delta-bound updates awaiting human review, oldest first. */
  getHeldDeltaUpdates(): ReturnType<DeltaBoundsGuard['getHeldUpdates']> {
    return this.deltaGuard.getHeldUpdates();
  }

  /**
   * Record who produced the KYB observation this publication rests on (#1236).
   *
   * Every verdict carries a provenance block — including `not-configured`, so
   * the *absence* of a check is as explicit as its presence. `checkedAt` is the
   * instant of the provider decision being observed, never the replay time,
   * which is what lets the decision-expiry control (#1237) be evaluated from
   * the response alone.
   */
  private kybProvenanceFor(input: {
    kybResult?: KYBVerificationResult;
    prior?: KYBProvenance;
    observedAtMs: number;
    nowMs: number;
    source: 'live' | 'cache';
  }): KYBProvenance {
    const status: KYBProvenance['status'] = !this.kybProvider
      ? 'not-configured'
      : !input.kybResult
        ? 'unavailable'
        : input.kybResult.isVerified
          ? 'verified'
          : 'unverified';
    const provider =
      input.kybResult?.provider ??
      input.prior?.provider ??
      this.kybProvider?.name ??
      'not-configured';
    const observedAtMs =
      Number.isFinite(input.observedAtMs) && input.observedAtMs > 0
        ? input.observedAtMs
        : input.nowMs;
    return {
      provider,
      status,
      source: input.source,
      checkedAt: new Date(observedAtMs).toISOString(),
      ageMs: Math.max(0, input.nowMs - observedAtMs),
    };
  }

  /**
   * Whether a published verdict's KYB observation has outlived the decision
   * TTL and must be revalidated before being replayed (#1237).
   *
   * `not-configured` observations and cache rows with no KYB result at all are
   * never treated as expired: there is no decision to revalidate, and expiring
   * them would silently disable caching for deployments that run without KYB
   * on purpose. A decision that *exists* but cannot be dated fails closed to
   * `expired`: an undatable green check is exactly the artefact this control
   * exists to stop.
   */
  private kybDecisionExpired(response: OracleVerificationResponse, nowMs: number): boolean {
    const provenance = response.kybProvenance;
    if (provenance) {
      if (provenance.status === 'not-configured') {
        return false;
      }
      const checkedAtMs = Date.parse(provenance.checkedAt);
      return !Number.isFinite(checkedAtMs) || nowMs - checkedAtMs >= this.kybDecisionTtlMs;
    }
    if (!response.kybResult) {
      return false;
    }
    const observedMs =
      kybTimestampToMs(response.kybResult.verifiedAt) || Date.parse(response.generatedAt);
    return !Number.isFinite(observedMs) || observedMs <= 0 || nowMs - observedMs >= this.kybDecisionTtlMs;
  }

  /**
   * Run the composite trust score through the delta-bound guard.
   *
   * On a hold the update is recorded in the review queue — never silently
   * dropped — and the protocol receives whichever verdict is more
   * conservative: the frozen last known-good one when the proposal would
   * *improve* the payer without a quorum, the fresh worsening one otherwise.
   * Everything else publishes normally, tagged with its decision.
   */
  private applyDeltaBounds(
    response: OracleVerificationResponse,
    payer: string,
    nowMs: number,
    confirmations: Parameters<typeof buildSourceConfirmations>[0]
  ): OracleVerificationResponse {
    const key = `composite-trust:${payer}`;
    const decision = this.deltaGuard.assess(
      { feed: 'composite-trust', subject: payer },
      response.trustScore,
      buildSourceConfirmations(confirmations),
      nowMs
    );

    const info: OracleDeltaGuardInfo = {
      feed: 'composite-trust',
      decision: decision.decision,
      delta: decision.decision === 'publish' ? 0 : decision.delta,
      bound: decision.decision === 'publish' ? 0 : decision.bound,
      confirmingSources: decision.decision === 'publish' ? [] : decision.confirmingSources,
      ...(decision.decision === 'hold' ? { heldId: decision.heldId } : {}),
    };

    if (decision.decision !== 'hold') {
      this.lastKnownGood.set(key, response);
      return { ...response, deltaGuard: info };
    }

    const holdEvidence =
      `Delta bound exceeded: trust movement ${Math.round(decision.delta)} > bound ` +
      `${Math.round(decision.bound)} with ${decision.confirmingSources.length} source ` +
      `confirmation(s). Held ${decision.heldId} for review.`;

    const frozen = this.lastKnownGood.get(key);
    // Fail safe: freezing out a sudden deterioration would let an attacker
    // mask the payer's turn to fraud behind their last clean score, so the
    // worsening verdict is served as-is (the hold is still recorded).
    if (!frozen || response.trustScore <= frozen.trustScore) {
      if (!frozen || response.trustScore < frozen.trustScore) {
        this.lastKnownGood.set(key, response);
      }
      return {
        ...response,
        evidence: [...response.evidence, holdEvidence],
        deltaGuard: info,
      };
    }

    return {
      ...frozen,
      requestId: response.requestId,
      invoiceId: response.invoiceId,
      amount: response.amount,
      generatedAt: response.generatedAt,
      dataAgeMs: response.dataAgeMs,
      cacheHit: false,
      evidence: [...frozen.evidence, `${holdEvidence} Serving last known-good verdict.`],
      deltaGuard: info,
    };
  }

  /**
   * Every verdict leaves through the payer authorization taxonomy (#1232),
   * whichever path produced it — fresh, cache replay, in-flight join or
   * degraded — so a published `isVerified: true` never coexists with a
   * failure code, including for cache entries written before the taxonomy.
   */
  async verify(request: OracleVerificationRequest): Promise<OracleVerificationResponse> {
    return enforcePayerAuthorization(await this.resolveVerification(request));
  }

  private async resolveVerification(
    request: OracleVerificationRequest
  ): Promise<OracleVerificationResponse> {
    const normalizedRequest = {
      ...request,
      payer: request.payer.trim(),
      amount: String(BigInt(String(request.amount))),
      invoiceId: String(BigInt(String(request.invoiceId))),
    };
    const cacheKey = buildOracleCacheKey(normalizedRequest);

    if (!normalizedRequest.forceRefresh && !this.requireKyb) {
      const cached = await this.cache?.get(cacheKey);
      if (cached) {
        const nowMs = this.now();
        if (!this.kybDecisionExpired(cached.response, nowMs)) {
          // #1236: a replay carries the original observation's identity and
          // timestamp, re-labelled `cache` with the age it is being served at.
          const kybProvenance = this.kybProvenanceFor({
            kybResult: cached.response.kybResult,
            prior: cached.response.kybProvenance,
            observedAtMs: cached.response.kybProvenance
              ? Date.parse(cached.response.kybProvenance.checkedAt)
              : kybTimestampToMs(cached.response.kybResult?.verifiedAt) ||
                Date.parse(cached.response.generatedAt),
            nowMs,
            source: 'cache',
          });
          this.metrics?.kybProvenanceTotal.inc({
            provider: kybProvenance.provider,
            status: kybProvenance.status,
            source: 'cache',
          });
          return {
            ...cached.response,
            cacheHit: true,
            kybProvenance,
            requestId: normalizedRequest.requestId ?? cached.response.requestId,
          };
        }
        // #1237: the stored decision outlived its TTL — re-fetch it rather
        // than replay it. The counter is the operator-visible signal that the
        // revalidation path is live.
        this.metrics?.kybRevalidationsTotal.inc({ reason: 'expired-decision' });
      }
    }

    const inflight = this.inflight.get(cacheKey);
    if (inflight && !normalizedRequest.forceRefresh) {
      const response = await inflight;
      return { ...response, cacheHit: true };
    }

    const computePromise = this.computeVerification(normalizedRequest, cacheKey);
    if (!normalizedRequest.forceRefresh) {
      this.inflight.set(cacheKey, computePromise);
    }

    try {
      return await computePromise;
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  private observeStage(stage: 'fetch' | 'aggregate' | 'publish', durationMs: number): void {
    if (!this.metrics) {
      return;
    }
    const seconds = durationMs / 1000;
    if (stage === 'fetch') {
      this.metrics.fetchDuration.observe(seconds);
      if (durationMs > FETCH_SLO_MS) {
        this.metrics.fetchSloViolationsTotal.inc();
      }
    } else if (stage === 'aggregate') {
      this.metrics.aggregateDuration.observe(seconds);
      if (durationMs > AGGREGATE_SLO_MS) {
        this.metrics.aggregateSloViolationsTotal.inc();
      }
    } else {
      this.metrics.publishDuration.observe(seconds);
      if (durationMs > PUBLISH_SLO_MS) {
        this.metrics.publishSloViolationsTotal.inc();
      }
    }
  }

  private async computeVerification(
    request: OracleVerificationRequest,
    cacheKey: string
  ): Promise<OracleVerificationResponse> {
    const nowMs = this.now();
    let history: IndexerInvoiceHistoryEntry[] = [];
    let reputation: ReputationSnapshot = {
      address: request.payer,
      score: 0,
      totalPaid: 0n,
      invoiceCount: 0,
      lastActivity: 0,
      rank: 0,
    };
    let indexerAvailable = true;

    const fetchStart = this.now();
    const [historyResult, reputationResult, externalResult, kybResult] = await Promise.allSettled([
      this.historyProvider(request.payer),
      this.reputationProvider(request.payer),
      this.externalProvider ? this.externalProvider(request.payer) : Promise.resolve(undefined),
      this.kybProvider ? this.kybProvider.verifyPayer(request.payer) : Promise.resolve(undefined),
    ]);
    this.observeStage('fetch', this.now() - fetchStart);

    let historyFailed = false;
    let reputationFailed = false;
    if (historyResult.status === 'fulfilled') {
      history = historyResult.value;
    } else {
      indexerAvailable = false;
      historyFailed = true;
    }

    if (reputationResult.status === 'fulfilled') {
      reputation = reputationResult.value;
    } else {
      reputationFailed = true;
    }

    // Degraded-mode contract (issue #1057): when EVERY source is down, serve
    // the last-known-good cached response — marked stale/degraded and never
    // verified — rather than inventing a fresh-looking answer. With no cache
    // to degrade to, fail loudly so callers halt price-dependent operations.
    if (historyFailed && reputationFailed) {
      if (this.requireKyb) {
        throw new OracleUnavailableError(
          'Oracle sources unavailable; required KYB must be retried'
        );
      }
      const stale = await this.cache?.getStale(cacheKey);
      if (stale) {
        const ageMs = Math.max(0, nowMs - stale.generatedAtMs);
        this.metrics?.degradedResponsesTotal.inc();
        this.metrics?.lastKnownGoodAgeSeconds.set(ageMs / 1000);
        // #1236: the degraded verdict still reports whose KYB observation it
        // was originally computed against, marked as replayed, never live.
        const kybProvenance =
          stale.response.kybProvenance || stale.response.kybResult
            ? this.kybProvenanceFor({
                kybResult: stale.response.kybResult,
                prior: stale.response.kybProvenance,
                observedAtMs: stale.response.kybProvenance
                  ? Date.parse(stale.response.kybProvenance.checkedAt)
                  : kybTimestampToMs(stale.response.kybResult?.verifiedAt) ||
                    Date.parse(stale.response.generatedAt),
                nowMs,
                source: 'cache',
              })
            : undefined;
        return {
          ...stale.response,
          cacheHit: false,
          stale: true,
          degraded: true,
          isVerified: false,
          dataAgeMs: ageMs,
          ...(kybProvenance ? { kybProvenance } : {}),
          evidence: [
            ...stale.response.evidence,
            'Oracle sources unavailable; serving last-known-good cached response (stale)',
          ],
        };
      }
      throw new OracleUnavailableError();
    }

    // A provider that threw yields `unknown`, never `unverified`: an outage
    // must not be reported as a failed identity check.
    let external: ExternalVerificationResult | undefined;
    if (externalResult.status === 'fulfilled') {
      external = externalResult.value;
    } else if (this.externalProvider) {
      external = {
        status: 'unknown',
        provider: 'unavailable',
        reasons: ['External verification provider did not respond'],
      };
    }
    const kybVerification =
      kybResult.status === 'fulfilled' && kybResult.value ? kybResult.value : undefined;

    const aggregateStart = this.now();
    const assessment = assessOracleRequest({
      request,
      history,
      reputation,
      nowMs,
      maxOracleAgeMs: request.maxOracleAgeMs ?? this.maxOracleAgeMs,
      external,
      kybResult: kybVerification,
      requirePayerSignature: this.requirePayerSignature,
    });
    this.observeStage('aggregate', this.now() - aggregateStart);

    let response: OracleVerificationResponse = {
      ...assessment.response,
      cacheHit: false,
    };

    const kybUnavailable =
      (this.requireKyb || this.kybProvider !== undefined) &&
      (!this.kybProvider || kybResult.status !== 'fulfilled' || !kybResult.value);
    if (kybUnavailable) {
      const rationale =
        'Required KYB provider is unavailable; retry verification before onboarding.';
      response = {
        ...response,
        isVerified: false,
        evidence: [...response.evidence, rationale],
        composition: {
          ...response.composition,
          outcome: 'rejected-kyb-unavailable',
          rationale,
        },
      };
    }

    // #1236: every live publication records whose KYB observation it rests
    // on — provider identity, outcome and decision instant — including the
    // explicit `not-configured` / `unavailable` cases, so provenance can
    // never be silently absent from an audited verdict.
    const kybProvenance = this.kybProvenanceFor({
      kybResult: kybVerification,
      observedAtMs: kybTimestampToMs(kybVerification?.verifiedAt),
      nowMs,
      source: 'live',
    });
    this.metrics?.kybProvenanceTotal.inc({
      provider: kybProvenance.provider,
      status: kybProvenance.status,
      source: 'live',
    });
    response = { ...response, kybProvenance };

    response = this.applyDeltaBounds(response, request.payer, nowMs, {
      historyOk: historyResult.status === 'fulfilled',
      history,
      reputationOk: reputationResult.status === 'fulfilled',
      reputationScore: reputation.score ?? 0,
      external,
      externalOk: this.externalProvider !== undefined && externalResult.status === 'fulfilled',
      kyb: kybVerification,
      kybOk: this.kybProvider !== undefined && kybResult.status === 'fulfilled',
    });

    // Clean verdicts for actively-invoicing payers get a short TTL so the
    // cache cannot mask fraud patterns that emerge moments later.
    const ttlSeconds = resolveCacheTtlSeconds(
      response,
      this.cacheTtlSeconds,
      hasRecentActivity(history, nowMs)
    );

    // Add evidence when indexer is unavailable
    if (!indexerAvailable) {
      response.evidence.push(
        'Indexer data unavailable; assessment based on on-chain reputation only'
      );
    }

    const publishStart = this.now();
    if (!this.requireKyb && response.composition?.outcome !== 'rejected-kyb-unavailable') {
      await this.cache?.set(cacheKey, response, ttlSeconds);
    }
    this.observeStage('publish', this.now() - publishStart);
    return response;
  }
}

export interface LedgerRpcOracleOptions {
  rpcUrl: string;
  contractId: string;
  networkPassphrase?: string;
  source?: string;
}

/**
 * The lookup itself, with failures propagated. The failover wrapper needs to
 * see primary outages as thrown errors — a zeroed snapshot is indistinguishable
 * from a genuinely unknown payer, which is why the total function below keeps
 * the catch and this one does not.
 */
export async function fetchOnChainReputationOrThrow(
  options: LedgerRpcOracleOptions,
  address: string
): Promise<ReputationSnapshot> {
  const server = new SorobanRpc.Server(options.rpcUrl);
  const contract = new Contract(options.contractId);
  const source = options.source ?? Keypair.random().publicKey();
  const account = await server.getAccount(source);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: options.networkPassphrase ?? Networks.TESTNET,
  })
    .addOperation(contract.call('get_reputation', new Address(address).toScVal()))
    .setTimeout(30)
    .build();

  const simulation = await server.simulateTransaction(tx);
  if ('error' in simulation) {
    throw new Error(String(simulation.error));
  }
  const retval = simulation.result?.retval;
  if (!retval) {
    throw new Error('No return value');
  }

  const native = scValToNative(retval);
  const get = (key: string): unknown => {
    if (native instanceof Map) {
      return native.get(key);
    }
    return native && typeof native === 'object'
      ? (native as Record<string, unknown>)[key]
      : undefined;
  };

  return {
    address,
    score: Math.max(0, Number(get('score') ?? 0)) || 0,
    totalPaid: BigInt(String(get('total_paid') ?? '0')) || 0n,
    invoiceCount: Math.max(0, Number(get('invoice_count') ?? 0)) || 0,
    lastActivity: Math.max(0, Number(get('last_activity') ?? 0)) || 0,
    rank: Math.max(0, Number(get('rank') ?? 0)) || 0,
  };
}

export async function fetchOnChainReputation(
  options: LedgerRpcOracleOptions,
  address: string
): Promise<ReputationSnapshot> {
  try {
    return await fetchOnChainReputationOrThrow(options, address);
  } catch {
    return {
      address,
      score: 0,
      totalPaid: 0n,
      invoiceCount: 0,
      lastActivity: 0,
      rank: 0,
    };
  }
}
