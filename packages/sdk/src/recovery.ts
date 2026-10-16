/**
 * Recovery utilities for the Invoice Liquidity Network SDK.
 *
 * Provides retry logic with exponential backoff and circuit-breaker
 * patterns for handling transient failures.
 *
 * @example
 * ```ts
 * import { withRetry, isRetryableError } from '@iln/sdk/recovery';
 *
 * const result = await withRetry(
 *   () => client.getInvoice(id),
 *   { maxAttempts: 3, initialDelayMs: 1000 },
 * );
 * ```
 */

import {
  ILNError,
  NetworkError,
  ValidationError,
  WalletNotConnectedError,
  InsufficientBalanceError,
  InvalidDiscountRateError,
  TokenMismatchError,
  PayerReputationTooLowError,
  GenericContractError,
  InvoiceNotFoundError,
  InvoiceAlreadyFundedError,
  InvoiceAlreadyPaidError,
  InvoiceNotFundedError,
  InvoiceDefaultedError,
  InvoiceExpiredError,
  FundingAmountExceededError,
  UnauthorizedError,
  TransactionFailedError,
  XDRParseError,
  InvalidAddressError,
  RateLimitError,
  TimeoutError,
  SimulationError,
} from './errors';

// ── Types ───────────────────────────────────────────────────────────────────

export interface RetryOptions {
  /** Maximum number of attempts (including the initial call). */
  maxAttempts: number;
  /** Initial delay in milliseconds before the first retry. */
  initialDelayMs: number;
  /** Maximum delay in milliseconds between retries. */
  maxDelayMs: number;
  /** Backoff multiplier applied to each subsequent delay. */
  backoffFactor: number;
  /** Whether to add random jitter to the delay. */
  jitter: boolean;
  /** Custom predicate to determine if an error is retryable. */
  retryIf?: (err: unknown) => boolean;
}

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit. */
  failureThreshold: number;
  /** Number of consecutive successes in HALF_OPEN to close the circuit. */
  successThreshold: number;
  /** Time in ms to wait before transitioning from OPEN to HALF_OPEN. */
  cooldownMs: number;
}

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  backoffFactor: 2,
  jitter: true,
};

const DEFAULT_CIRCUIT_BREAKER: Required<CircuitBreakerOptions> = {
  failureThreshold: 5,
  successThreshold: 2,
  cooldownMs: 60_000,
};

// ── Retryability ────────────────────────────────────────────────────────────

/**
 * Determines whether an error is likely transient and worth retrying.
 *
 * Returns `true` for network/timeout/simulation/rate-limit errors and
 * unknown non-ILN errors. Returns `false` for all deterministic contract
 * and validation errors.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  if (err instanceof TimeoutError) return true;
  if (err instanceof RateLimitError) return true;
  if (err instanceof SimulationError) return true;
  // Check by code for forward-compatibility
  if (err instanceof ILNError && err.code === 'SIMULATION_FAILED') return true;

  // All known business/contract errors are non-retryable by default.
  if (err instanceof ValidationError) return false;
  if (err instanceof WalletNotConnectedError) return false;
  if (err instanceof InsufficientBalanceError) return false;
  if (err instanceof InvalidDiscountRateError) return false;
  if (err instanceof TokenMismatchError) return false;
  if (err instanceof PayerReputationTooLowError) return false;
  if (err instanceof GenericContractError) return false;
  if (err instanceof InvoiceNotFoundError) return false;
  if (err instanceof InvoiceAlreadyFundedError) return false;
  if (err instanceof InvoiceAlreadyPaidError) return false;
  if (err instanceof InvoiceNotFundedError) return false;
  if (err instanceof InvoiceDefaultedError) return false;
  if (err instanceof InvoiceExpiredError) return false;
  if (err instanceof FundingAmountExceededError) return false;
  if (err instanceof UnauthorizedError) return false;
  if (err instanceof TransactionFailedError) return false;
  if (err instanceof XDRParseError) return false;
  if (err instanceof InvalidAddressError) return false;
  if (err instanceof ILNError) return false;

  // Non-ILN errors (raw fetch failures, runtime errors) are assumed transient.
  return true;
}

// ── withRetry ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an async function with automatic retry and exponential backoff.
 *
 * Retries only when `isRetryableError` returns true (or when `retryIf`
 * overrides it). Throws immediately on non-retryable errors.
 *
 * @param fn - The async function to execute.
 * @param options - Retry configuration overrides.
 * @returns The result of `fn` on success.
 * @throws The last error after exhausting all retry attempts.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULT_RETRY, ...options };
  const shouldRetry = opts.retryIf ?? isRetryableError;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === opts.maxAttempts) throw err;
      if (!shouldRetry(err)) throw err;

      let delay = Math.min(
        opts.initialDelayMs * Math.pow(opts.backoffFactor, attempt - 1),
        opts.maxDelayMs
      );
      if (opts.jitter) {
        delay = delay * (0.5 + Math.random() * 0.5);
      }

      await sleep(delay);
    }
  }

  throw new Error('withRetry: unexpected exit');
}

// ── CircuitBreaker ──────────────────────────────────────────────────────────

/**
 * Thrown when the circuit breaker is open and requests are blocked.
 */
export class CircuitOpenError extends ILNError {
  constructor() {
    super(
      'Circuit breaker is open; requests are temporarily blocked.',
      'CIRCUIT_OPEN',
      'Wait for the cooldown period to elapse, then retry your request.',
      {
        retryable: false,
      }
    );
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Circuit breaker for preventing cascading failures.
 *
 * State machine: CLOSED → OPEN → HALF_OPEN → CLOSED (or back to OPEN).
 *
 * - **CLOSED**: Normal operation. Failures are counted; after `failureThreshold`
 *   consecutive failures, transitions to OPEN.
 * - **OPEN**: All calls are rejected with `CircuitOpenError`. After `cooldownMs`,
 *   transitions to HALF_OPEN.
 * - **HALF_OPEN**: A probe call is allowed. If it succeeds and `successThreshold`
 *   consecutive successes are reached, transitions to CLOSED. Any failure
 *   transitions back to OPEN.
 */
export class CircuitBreaker {
  private state: CircuitBreakerState = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private openedAt: number | null = null;
  private readonly options: Required<CircuitBreakerOptions>;

  constructor(options?: Partial<CircuitBreakerOptions>) {
    this.options = { ...DEFAULT_CIRCUIT_BREAKER, ...options };
  }

  getState(): CircuitBreakerState {
    return this.state;
  }

  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.openedAt = null;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - (this.openedAt ?? 0);
      if (elapsed < this.options.cooldownMs) {
        throw new CircuitOpenError();
      }
      this.state = 'HALF_OPEN';
      this.successCount = 0;
    }

    try {
      const result = await fn();

      if (this.state === 'HALF_OPEN') {
        this.successCount++;
        if (this.successCount >= this.options.successThreshold) {
          this.state = 'CLOSED';
          this.failureCount = 0;
          this.successCount = 0;
          this.openedAt = null;
        }
      } else {
        this.failureCount = 0;
      }

      return result;
    } catch (err) {
      if (this.state === 'HALF_OPEN') {
        this.state = 'OPEN';
        this.openedAt = Date.now();
        this.successCount = 0;
      } else {
        this.failureCount++;
        if (this.failureCount >= this.options.failureThreshold) {
          this.state = 'OPEN';
          this.openedAt = Date.now();
          this.failureCount = 0;
        }
      }
      throw err;
    }
  }
}
