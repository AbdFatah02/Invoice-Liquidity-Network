// ─── Invoice ──────────────────────────────────────────────────────────────────

/**
 * All nine on-chain invoice states.
 *
 * Intentionally differs from @iln/shared's InvoiceStatus only in that this is
 * a local copy kept in sync with the contract. If a new status is added to the
 * contract, it must be added here as well.
 */
export type InvoiceStatus =
  | 'Pending'
  | 'PartiallyFunded'
  | 'Funded'
  | 'Paid'
  | 'Defaulted'
  | 'Appealed'
  | 'Disputed'
  | 'Expired'
  | 'Cancelled';

/**
 * Invoice row as stored in SQLite.
 *
 * This is a DB-specific projection of @iln/shared's Invoice, not a duplicate.
 * Field names use snake_case to match the SQL schema, `amount` is a string
 * (i128 exceeds JS Number.MAX_SAFE_INTEGER), and it omits contract-only fields
 * like `token`, `amountFunded`, `submitterReputation`, etc.
 */
export interface Invoice {
  id: number;
  freelancer: string;
  payer: string;
  /** Full invoice value in stroops (1 USDC = 10_000_000). Stored as string. */
  amount: string;
  /** Unix timestamp — when the payer must settle by. */
  due_date: number;
  /** Basis points, e.g. 300 = 3.00%. */
  discount_rate: number;
  status: InvoiceStatus;
  funder: string | null;
  funded_at: number | null;
  created_at: number;
  updated_at: number;
}

// ─── Events ───────────────────────────────────────────────────────────────────

export type ILNEventType = 'submitted' | 'funded' | 'paid' | 'defaulted';

/** Processed ILN contract event as stored in SQLite. */
export interface ILNEvent {
  /** Unique Soroban event ID  (e.g. "0000001234-0-0"). Used for deduplication. */
  event_id: string;
  event_type: ILNEventType;
  invoice_id: number;
  ledger: number;
  /** ISO 8601 timestamp of ledger close. */
  ledger_closed_at: string;
  created_at: number;
}

// ─── Fork Replacement Decisions ──────────────────────────────────────────────

export type ForkDecisionStatus = 'in_progress' | 'completed' | 'aborted' | 'quarantined';

export interface ForkDecision {
  id: number;
  detected_at: number;
  from_ledger: number;
  to_ledger: number;
  tip_ledger: number;
  status: ForkDecisionStatus;
  recovery_attempts?: number;
  events_removed: number;
  invoices_affected: number;
  resolved_at: number | null;
}

export interface QuarantinedReorg {
  id: number;
  decision_id: number;
  from_ledger: number;
  to_ledger: number;
  reason: string;
  error_details: string | null;
  quarantined_at: number;
}

