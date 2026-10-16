import type { OracleVerificationResponse } from './types';

/**
 * Payer authorization failure taxonomy (issue #1232).
 *
 * Before this module a denied payer check surfaced as free-form strings: a
 * 400 `error`, a composition `rationale`, a fraud-signal sentence, or a 503
 * message. Callers could not tell "fix your request" from "retry later" from
 * "this payer is refused" without string matching, and operators had no
 * metric that partitioned denials by cause.
 *
 * Every way a payer check can fail now maps to exactly one stable code with a
 * category, an HTTP status and a retry hint. Codes are append-only: renaming
 * or re-categorising one is a breaking change for downstream consumers and
 * requires bumping `PAYER_AUTHORIZATION_TAXONOMY_VERSION`.
 *
 * The taxonomy is also the fail-closed control: `enforcePayerAuthorization`
 * refuses to publish `isVerified: true` alongside any failure code, so a
 * verdict whose fields disagree is always resolved as a denial.
 */

/** Bumped whenever a code is added, removed or re-categorised. */
export const PAYER_AUTHORIZATION_TAXONOMY_VERSION = 'payer-authz-v1';

export type PayerAuthorizationFailureCode =
  // request — the caller sent something the oracle cannot evaluate.
  | 'PAYER_REQUEST_MALFORMED'
  | 'PAYER_ADDRESS_INVALID'
  | 'PAYER_RATE_LIMITED'
  | 'PAYER_ABUSE_BLOCKED'
  // policy — the oracle evaluated the payer and refused them.
  | 'PAYER_FRAUD_SIGNALS'
  | 'PAYER_LOW_TRUST'
  | 'PAYER_KYB_UNVERIFIED'
  | 'PAYER_SIGNATURE_INVALID'
  | 'PAYER_SUBSTITUTION_REJECTED'
  // freshness — the oracle cannot stand behind the data it has.
  | 'PAYER_DATA_STALE'
  | 'PAYER_DEGRADED_LAST_KNOWN_GOOD'
  // dependency — a required upstream did not answer.
  | 'PAYER_KYB_UNAVAILABLE'
  | 'ORACLE_SOURCES_UNAVAILABLE'
  // internal — the oracle itself failed.
  | 'ORACLE_INTERNAL_ERROR';

export type PayerAuthorizationFailureCategory =
  | 'request'
  | 'policy'
  | 'freshness'
  | 'dependency'
  | 'internal';

export interface PayerAuthorizationFailureDefinition {
  category: PayerAuthorizationFailureCategory;
  /** Status used when the failure is reported as an HTTP error. */
  httpStatus: number;
  /** Whether repeating the same request can succeed without caller changes. */
  retryable: boolean;
  description: string;
}

export const PAYER_AUTHORIZATION_FAILURES: Readonly<
  Record<PayerAuthorizationFailureCode, PayerAuthorizationFailureDefinition>
> = Object.freeze({
  PAYER_REQUEST_MALFORMED: {
    category: 'request',
    httpStatus: 400,
    retryable: false,
    description: 'payer, amount, and invoiceId are required',
  },
  PAYER_ADDRESS_INVALID: {
    category: 'request',
    httpStatus: 400,
    retryable: false,
    description: 'payer must be a valid Stellar address',
  },
  PAYER_RATE_LIMITED: {
    category: 'request',
    httpStatus: 429,
    retryable: true,
    description: 'Client exceeded the verification rate limit',
  },
  PAYER_ABUSE_BLOCKED: {
    category: 'request',
    httpStatus: 429,
    retryable: true,
    description: 'Client temporarily blocked for an abusive request pattern',
  },
  PAYER_FRAUD_SIGNALS: {
    category: 'policy',
    httpStatus: 200,
    retryable: false,
    description: 'Fraud heuristics fired for the payer',
  },
  PAYER_LOW_TRUST: {
    category: 'policy',
    httpStatus: 200,
    retryable: false,
    description: 'Trust score or composed confidence is below threshold',
  },
  PAYER_KYB_UNVERIFIED: {
    category: 'policy',
    httpStatus: 200,
    retryable: false,
    description: 'Configured KYB provider explicitly failed the payer',
  },
  PAYER_SIGNATURE_INVALID: {
    category: 'policy',
    httpStatus: 200,
    retryable: false,
    description: 'Payer signature verification failed against canonical invoice payload',
  },
  PAYER_SUBSTITUTION_REJECTED: {
    category: 'policy',
    httpStatus: 200,
    retryable: false,
    description: 'Payer substitution rejected across invoice lifecycle states',
  },
  PAYER_DATA_STALE: {
    category: 'freshness',
    httpStatus: 200,
    retryable: true,
    description: 'Source data is older than the maximum oracle age',
  },
  PAYER_DEGRADED_LAST_KNOWN_GOOD: {
    category: 'freshness',
    httpStatus: 200,
    retryable: true,
    description: 'Every source is down; serving the last-known-good verdict',
  },
  PAYER_KYB_UNAVAILABLE: {
    category: 'dependency',
    httpStatus: 200,
    retryable: true,
    description: 'Required KYB provider did not answer',
  },
  ORACLE_SOURCES_UNAVAILABLE: {
    category: 'dependency',
    httpStatus: 503,
    retryable: true,
    description: 'No verification source and no cached verdict available',
  },
  ORACLE_INTERNAL_ERROR: {
    category: 'internal',
    httpStatus: 500,
    retryable: true,
    description: 'Oracle verification failed unexpectedly',
  },
});

export const PAYER_AUTHORIZATION_FAILURE_CODES = Object.freeze(
  Object.keys(PAYER_AUTHORIZATION_FAILURES) as PayerAuthorizationFailureCode[]
);

export interface PayerAuthorizationFailure {
  code: PayerAuthorizationFailureCode;
  category: PayerAuthorizationFailureCategory;
  retryable: boolean;
}

/** Machine-readable authorization result attached to every verdict. */
export interface PayerAuthorizationDecision {
  taxonomy: string;
  decision: 'allow' | 'deny';
  /** The failure that decided the verdict; `null` when allowed. */
  primary: PayerAuthorizationFailureCode | null;
  /** Every failure that applies, primary first. */
  failures: PayerAuthorizationFailure[];
}

function failure(code: PayerAuthorizationFailureCode): PayerAuthorizationFailure {
  const def = PAYER_AUTHORIZATION_FAILURES[code];
  return { code, category: def.category, retryable: def.retryable };
}

/**
 * Derive the authorization decision from a verdict.
 *
 * Pure and deterministic over the response fields, so a verdict replayed from
 * cache — including one written by an older instance that never carried an
 * `authorization` block — classifies identically after a restart.
 *
 * Precedence mirrors composition: a degraded verdict is not a fresh verdict
 * at all; a missing required dependency means no verdict was possible;
 * staleness outranks policy because a stale assessment is not evidence.
 */
export function classifyPayerVerdict(
  response: OracleVerificationResponse
): PayerAuthorizationDecision {
  const codes: PayerAuthorizationFailureCode[] = [];
  const add = (code: PayerAuthorizationFailureCode): void => {
    if (!codes.includes(code)) {
      codes.push(code);
    }
  };

  if (response.degraded) {
    add('PAYER_DEGRADED_LAST_KNOWN_GOOD');
  }

  // Cryptographic signatures and lifecycle invariants outrank heuristic evaluations
  for (const signal of response.fraudSignals) {
    const s = signal.toLowerCase();
    if (s.includes('substitution rejected')) {
      add('PAYER_SUBSTITUTION_REJECTED');
    }
    if (s.includes('payer signature invalid') || s.includes('signature invalid')) {
      add('PAYER_SIGNATURE_INVALID');
    }
  }

  switch (response.composition?.outcome) {
    case 'rejected-kyb-unavailable':
      add('PAYER_KYB_UNAVAILABLE');
      break;
    case 'rejected-stale-data':
      add('PAYER_DATA_STALE');
      break;
    case 'rejected-kyb-unverified':
      add('PAYER_KYB_UNVERIFIED');
      break;
    case 'rejected-fraud-signals':
      add('PAYER_FRAUD_SIGNALS');
      break;
    case 'rejected-low-trust':
      add('PAYER_LOW_TRUST');
      break;
    default:
      break;
  }

  // Field-level checks catch verdicts whose outcome disagrees with their own
  // evidence — e.g. a KYB rejection recorded after composition ran.
  if (response.kybResult && response.kybResult.isVerified === false) {
    add('PAYER_KYB_UNVERIFIED');
  }
  if (response.fraudSignals.length > 0) {
    add('PAYER_FRAUD_SIGNALS');
  }
  if (response.stale) {
    add('PAYER_DATA_STALE');
  }
  // A denial with no recognised cause is still a denial; never report it as
  // an allow, and attribute it to the trust bar that every verdict must clear.
  if (codes.length === 0 && !response.isVerified) {
    add('PAYER_LOW_TRUST');
  }

  const failures = codes.map(failure);
  return {
    taxonomy: PAYER_AUTHORIZATION_TAXONOMY_VERSION,
    decision: failures.length === 0 ? 'allow' : 'deny',
    primary: failures[0]?.code ?? null,
    failures,
  };
}

/**
 * Attach the authorization decision and fail closed on disagreement.
 *
 * A response may only claim `isVerified: true` when the taxonomy finds no
 * failure. Idempotent, so it is safe on cache replays and in-flight joins.
 */
export function enforcePayerAuthorization(
  response: OracleVerificationResponse
): OracleVerificationResponse {
  const authorization = classifyPayerVerdict(response);
  return {
    ...response,
    isVerified: response.isVerified && authorization.decision === 'allow',
    authorization,
  };
}

/** Body for an HTTP error that terminates a payer check before a verdict. */
export function payerAuthorizationErrorBody(
  code: PayerAuthorizationFailureCode,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const def = PAYER_AUTHORIZATION_FAILURES[code];
  return {
    error: def.description,
    code,
    category: def.category,
    retryable: def.retryable,
    taxonomy: PAYER_AUTHORIZATION_TAXONOMY_VERSION,
    ...extra,
  };
}
