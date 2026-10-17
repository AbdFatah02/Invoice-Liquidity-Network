import type { AuditRowStore } from './audit-store';
import type { PayerAuthorizationDecision } from './authorization';
import type { DeltaBoundsConfig, OracleDeltaGuardInfo } from './deltaBounds';
import type { OracleSigningKeyStore, SignedPriceUpdate } from './signer';
import type { SourceFailoverConfig, SourceHealthState } from './sourceFailover';

export type InvoiceStatus = 'Pending' | 'Funded' | 'Paid' | 'Defaulted';

export interface IndexerInvoiceHistoryEntry {
  id: number;
  freelancer: string;
  payer: string;
  amount: string;
  due_date: number;
  discount_rate: number;
  status: InvoiceStatus;
  funder?: string | null;
  funded_at?: number | null;
  created_at: number;
  updated_at: number;
}

export interface ReputationSnapshot {
  address: string;
  score: number;
  totalPaid: bigint;
  invoiceCount: number;
  lastActivity: number;
  rank: number;
}

export interface OracleVerificationRequest {
  payer: string;
  amount: string | number | bigint;
  invoiceId: string | number | bigint;
  payerSignature?: string;
  canonicalPayload?: string;
  forceRefresh?: boolean;
  requestId?: string;
  maxOracleAgeMs?: number;
}

export interface KYBVerificationResult {
  provider: string;
  isVerified: boolean;
  businessName?: string;
  registrationNumber?: string;
  jurisdiction?: string;
  riskScore?: number;
  verifiedAt?: string;
  signals?: string[];
  rawDetails?: Record<string, unknown>;
}

export interface VerificationProvider {
  name: string;
  /**
   * Set by reference/mock adapters so production wiring can refuse them by
   * identity rather than by name string (issue #1234). Optional so existing
   * production adapters keep compiling.
   */
  isMock?: boolean;
  verifyPayer(
    payerAddress: string,
    metadata?: Record<string, unknown>
  ): Promise<KYBVerificationResult>;
}

/**
 * Provenance of the KYB observation a published verdict rests on (issue #1236).
 *
 * Recorded on every publication — including `not-configured` — so an auditor
 * can always answer *who* checked the payer, *when*, and whether the observation
 * was fetched live or replayed from cache. `checkedAt` is the instant of the
 * provider decision, never the replay time, which is what lets the decision
 * expiry control (#1237) be evaluated from the response alone.
 */
export interface KYBProvenance {
  /** Adapter identity, or `not-configured` when no provider is wired. */
  provider: string;
  /** Outcome of the observation; `unavailable` means the provider did not answer. */
  status: 'verified' | 'unverified' | 'unavailable' | 'not-configured';
  /** `live` for a fresh provider call, `cache` for a replayed observation. */
  source: 'live' | 'cache';
  /** ISO-8601 instant of the provider check this verdict rests on. */
  checkedAt: string;
  /** Age of that check at publication time, in milliseconds. */
  ageMs: number;
}

export type OracleConfidenceLevel = 'low' | 'medium' | 'high';

// ── External verification provider (KYB / identity attestation) ──────────────

/**
 * Outcome of an external provider lookup for a payer.
 *
 * `unknown` is deliberately distinct from `unverified`. A provider that is not
 * configured, times out, or has no record for the payer tells us nothing — and
 * "we could not check" must never be treated as "we checked and they failed",
 * which would let an outage silently reject every payer.
 */
export type ExternalVerificationStatus = 'verified' | 'unverified' | 'unknown';

export interface ExternalVerificationResult {
  status: ExternalVerificationStatus;
  /** Provider identifier, surfaced so the frontend can attribute the signal. */
  provider: string;
  /** Provider's own confidence in its attestation, 0..1, when it reports one. */
  providerConfidence?: number;
  /** ISO timestamp of the attestation, used for staleness reporting. */
  checkedAt?: string;
  /** Human-readable notes to fold into the response evidence. */
  reasons?: string[];
}

/** Pluggable port for an external KYB/identity provider. */
export interface ExternalVerificationProvider {
  (payer: string): Promise<ExternalVerificationResult>;
}

// ── Signal composition ───────────────────────────────────────────────────────

/**
 * Which signal determined the final verdict. Exposed so the frontend's
 * OracleBadge can distinguish "clean and attested" from "clean but unattested"
 * from "attested but behaving fraudulently" without re-deriving the policy.
 */
export type OracleCompositionOutcome =
  | 'verified-both'
  | 'verified-heuristic-only'
  | 'rejected-fraud-signals'
  | 'rejected-low-trust'
  | 'rejected-stale-data'
  | 'rejected-kyb-unavailable'
  | 'rejected-kyb-unverified';

/** The heuristic sub-signal, reported alongside the composed verdict. */
export interface OracleHeuristicSignal {
  trustScore: number;
  confidence: number;
  confidenceLevel: OracleConfidenceLevel;
  fraudSignals: string[];
  passed: boolean;
}

/** The external sub-signal, reported alongside the composed verdict. */
export interface OracleExternalSignal {
  status: ExternalVerificationStatus;
  provider: string | null;
  providerConfidence: number | null;
  checkedAt: string | null;
  reasons: string[];
}

/** Full composition detail attached to every verification response. */
export interface OracleSignalComposition {
  /** Version of the composition policy that produced this verdict. */
  policy: string;
  outcome: OracleCompositionOutcome;
  /** Short explanation of which rule decided the verdict. */
  rationale: string;
  heuristic: OracleHeuristicSignal;
  external: OracleExternalSignal;
  /** Confidence before the external signal was applied. */
  baseConfidence: number;
  /** Confidence after composition — the value in `confidence`. */
  composedConfidence: number;
}

export interface OracleVerificationResponse {
  requestId: string;
  payer: string;
  invoiceId: string;
  amount: string;
  trustScore: number;
  confidence: number;
  confidenceLevel: OracleConfidenceLevel;
  isVerified: boolean;
  generatedAt: string;
  dataAgeMs: number;
  cacheHit: boolean;
  reputationScore: number;
  historicalSuccessRate: number;
  historicalDefaultRate: number;
  averageHistoricalAmount: string;
  amountDeviation: number;
  settlementVarianceDays: number;
  fraudSignals: string[];
  evidence: string[];
  /**
   * Both sub-scores and the rule that decided the verdict, not just the final
   * boolean, so consumers can render the four verified/fraud combinations
   * distinctly.
   */
  composition: OracleSignalComposition;
  /**
   * Outcome of the per-feed delta-bound guard applied to the composite trust
   * score. Absent on responses produced before the guard existed (e.g. cached
   * entries written by older instances). A `hold` means the proposal was
   * frozen for human review and this verdict is the last known-good value.
   */
  deltaGuard?: OracleDeltaGuardInfo;
  kybResult?: KYBVerificationResult;
  /**
   * Where the KYB observation behind this publication came from (#1236).
   * Present on every verdict; `status: 'not-configured'` records the explicit
   * absence of a provider rather than leaving the field blank.
   */
  kybProvenance?: KYBProvenance;
  /**
   * HMAC attestation of *this publication*, attached by the HTTP layer when a
   * signing key is configured (#1053).
   *
   * A fresh nonce and `issuedAt` are minted per response rather than reused
   * from the cached verdict, so a consumer's replay cache sees one event per
   * publication while the underlying verdict may legitimately repeat.
   */
  attestation?: OracleVerdictAttestation | null;
  /**
   * Degraded-mode contract (issue #1057): when oracle-service cannot reach
   * any source, it serves the last-known-good cached response with
   * `stale: true, degraded: true, isVerified: false` instead of failing
   * silently or returning fresh-looking data.
   */
  stale?: boolean;
  degraded?: boolean;
  /**
   * Payer authorization failure taxonomy (issue #1232): stable code(s) for
   * why the payer was denied. Attached by the verifier on every return path;
   * absent only on raw cache entries, which are re-classified on read.
   */
  authorization?: PayerAuthorizationDecision;
}

/**
 * The signature envelope carried by a published verdict.
 *
 * `payload` is the canonical JSON of the verdict with this field removed; a
 * consumer verifies `keyId:nonce:issuedAt:payload` against `signature` using
 * the advertised key id.
 */
export type OracleVerdictAttestation = SignedPriceUpdate;

export interface OracleAssessmentInput {
  request: OracleVerificationRequest;
  reputation: ReputationSnapshot;
  history: IndexerInvoiceHistoryEntry[];
  nowMs: number;
  maxOracleAgeMs: number;
  /** Omitted when no external provider is configured — treated as `unknown`. */
  external?: ExternalVerificationResult;
  kybResult?: KYBVerificationResult;
  /** Require valid cryptographic payer signature before publishing a positive verdict (Issue #1228). */
  requirePayerSignature?: boolean;
}

export interface OracleAssessment {
  response: OracleVerificationResponse;
  sourceTimestampMs: number;
}

export interface OracleCacheEntry {
  key: string;
  response: OracleVerificationResponse;
  generatedAtMs: number;
}

export interface OracleVerificationStats {
  verifications: number;
  cacheHits: number;
  cacheMisses: number;
  staleResponses: number;
}

export interface OracleServiceHealth {
  status: 'ok' | 'degraded';
  uptimeMs: number;
  cache: 'memory' | 'redis' | 'disabled';
  indexerBaseUrl: string;
  reputationConfigured: boolean;
  lastVerificationAt?: string | null;
  /**
   * Whether published verdicts are being signed (#1053) and whether the audit
   * trail is durable (#1055). Both are surfaced rather than assumed, because a
   * deployment that quietly loses either still returns 200s.
   */
  signing: 'enabled' | 'disabled';
  audit: 'sqlite' | 'memory';
  /**
   * KYB wiring as loaded at boot (#1234/#1235) and the decision TTL that cache
   * replays are bounded by (#1237). Surfaced so operators can confirm the
   * control is active without reading the deployment manifest.
   */
  kyb: {
    configured: boolean;
    provider: string | null;
    required: boolean;
    decisionTtlMs: number;
  };
  /** Issue #1057: true once the service has served a degraded response. */
  degradedMode: boolean;
  degradedResponses?: number;
  lastSuccessfulVerificationAt?: string | null;
  /** Issue #1054: per-stage SLO violation totals served by this instance. */
  sloViolations?: {
    fetch: number;
    aggregate: number;
    publish: number;
  };
}

export interface OracleServiceMetricsSnapshot {
  verifications: number;
  cacheHits: number;
  cacheMisses: number;
  staleResponses: number;
  inFlightRequests: number;
}

export interface OracleVerifierDependencies {
  historyProvider: (payer: string) => Promise<IndexerInvoiceHistoryEntry[]>;
  reputationProvider: (payer: string) => Promise<ReputationSnapshot>;
  kybProvider?: VerificationProvider;
  /** Require a successful live KYB check before publishing a positive verdict. */
  requireKyb?: boolean;
  /**
   * How long a recorded KYB decision may be replayed from cache before it is
   * revalidated (issue #1237). Defaults to 24 hours.
   */
  kybDecisionTtlMs?: number;
  /** Require a valid cryptographic payer signature before publishing a positive verdict (Issue #1228). */
  requirePayerSignature?: boolean;
  cache?: OracleCacheReaderWriter;
  now?: () => number;
  cacheTtlSeconds?: number;
  maxOracleAgeMs?: number;
  externalProvider?: ExternalVerificationProvider;
  /** Per-feed movement bounds for the composite trust score (issue #1052). */
  deltaBounds?: DeltaBoundsConfig;
}

export interface OracleCacheReaderWriter {
  get(key: string): Promise<OracleCacheEntry | null>;
  set(key: string, response: OracleVerificationResponse, ttlSeconds: number): Promise<void>;
  /**
   * Last-known-good read for degraded mode (issue #1057): returns the most
   * recent response for key even when its TTL has expired, or null when the
   * key was never written. Backends that cannot retain expired entries
   * return null and the caller fails loudly instead of degrading.
   */
  getStale(key: string): Promise<OracleCacheEntry | null>;
  /**
   * Drop every entry under a key prefix. Used to invalidate a payer's cached
   * verdicts the moment new activity for that payer is observed, so a clean
   * result cannot outlive the behaviour it was based on.
   *
   * Optional so existing custom cache implementations keep compiling; callers
   * must treat its absence as "invalidation unsupported", not as success.
   */
  invalidateByPrefix?(prefix: string): Promise<number>;
}

export interface OracleServiceOptions {
  port: number;
  indexerBaseUrl: string;
  reputationRpcUrl?: string;
  reputationContractId?: string;
  cacheTtlSeconds: number;
  requestTimeoutMs: number;
  maxOracleAgeMs: number;
  redisUrl?: string;
  cache?: OracleCacheReaderWriter;
  historyProvider?: (payer: string) => Promise<IndexerInvoiceHistoryEntry[]>;
  reputationProvider?: (payer: string) => Promise<ReputationSnapshot>;
  externalProvider?: ExternalVerificationProvider;
  kybProvider?: VerificationProvider;
  /** Require a successful live KYB check before publishing a positive verdict. */
  requireKyb?: boolean;
  /**
   * How long a recorded KYB decision may be replayed from cache before it is
   * revalidated (issue #1237). Defaults to `ORACLE_KYB_DECISION_TTL_MS` or 24h.
   */
  kybDecisionTtlMs?: number;
  /** Require a valid cryptographic payer signature before publishing a positive verdict (Issue #1228). */
  requirePayerSignature?: boolean;
  rateLimitWindowMs?: number;
  rateLimitMaxRequests?: number;
  enableRateLimit?: boolean;
  /**
   * Store backing the append-only audit trail. When omitted the driver is
   * resolved from `ORACLE_AUDIT_DB_PATH` / `ORACLE_AUDIT_DRIVER`.
   */
  auditStore?: AuditRowStore;
  /** How long audit entries are retained. Defaults to one year. */
  auditRetentionMs?: number;
  /**
   * Key store used to sign published verdicts. `null` explicitly disables
   * signing (non-production only); omitting it resolves from the environment.
   */
  signingKeyStore?: OracleSigningKeyStore | null;
  /** Fallback indexer for automated history-source failover (issue #1051). */
  indexerFallbackUrl?: string;
  /** Fallback Soroban RPC for automated reputation-source failover. */
  reputationFallbackRpcUrl?: string;
  deltaBounds?: DeltaBoundsConfig;
  sourceFailover?: SourceFailoverConfig;
}
