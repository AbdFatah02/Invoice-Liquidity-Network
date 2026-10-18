import Database from 'better-sqlite3';
import {
  dbQueryDuration,
  dbErrorsTotal,
  lastProcessedLedger,
  cursorUpdatedAt,
  analyticsQueryDuration,
  analyticsQueryExceededBudget,
  reorgRemovedEventsTotal,
  reorgForkDecisionsTotal,
  reorgPendingDecisions,
  reorgQuarantinedTotal,
  reorgQuarantinedActive,
  cursorMonotonicityViolationsTotal,
} from './metrics';
import { CONFIG } from './config';
import type { ILNEvent, Invoice, InvoiceStatus, ForkDecision, QuarantinedReorg } from './types';

// ─── Query logging ────────────────────────────────────────────────────────────

const SLOW_QUERY_THRESHOLD_MS = 100;
let _queryCount = 0;
let _totalQueryTime = 0;

/** Wrap a synchronous DB operation with timing and slow-query logging. */
function measure<T>(label: string, fn: () => T): T {
  const start = Date.now();
  try {
    return fn();
  } finally {
    const elapsed = Date.now() - start;
    _queryCount++;
    _totalQueryTime += elapsed;
    if (elapsed > SLOW_QUERY_THRESHOLD_MS) {
      throw new Error(`[DB] Query exceeded performance budget (${elapsed}ms): ${label}`);
    }
  }
}

/**
 * Wrap an analytics query with timing, budget enforcement, and isolation
 * metrics. Analytics queries are routed to the replica connection when
 * configured, so they never contend with production read/write traffic.
 */
function measureAnalytics<T>(label: string, fn: () => T): T {
  const start = Date.now();
  try {
    return fn();
  } finally {
    const elapsed = Date.now() - start;
    try {
      analyticsQueryDuration.observe(elapsed / 1000);
      if (elapsed > CONFIG.analyticsQueryBudgetMs) {
        analyticsQueryExceededBudget.inc();
        console.warn(
          `[DB] Analytics query exceeded budget (${elapsed}ms > ${CONFIG.analyticsQueryBudgetMs}ms): ${label}`
        );
      }
    } catch {
      /* metrics failure is non-fatal */
    }
  }
}

// ─── Singleton connection ─────────────────────────────────────────────────────

let _db: Database.Database | null = null;
let _analyticsDb: Database.Database | null = null;

/** Return the singleton database connection, creating and migrating it on first call. */
export function getDb(): Database.Database {
  if (!_db) {
    _db = createDb(CONFIG.dbPath);
  }
  return _db;
}

/**
 * Return the analytics-dedicated database connection.
 *
 * When ANALYTICS_DB_PATH is configured, analytics queries run against a
 * separate read-only SQLite connection (typically pointing at the same WAL
 * file or a filesystem-level replica). This isolates analytics I/O from the
 * production read/write path so an expensive aggregation cannot starve
 * latency-sensitive reads.
 *
 * When unconfigured, falls back to the primary connection for backwards
 * compatibility.
 */
export function getAnalyticsDb(): Database.Database {
  if (CONFIG.analyticsDbPath) {
    if (!_analyticsDb) {
      _analyticsDb = new Database(CONFIG.analyticsDbPath, { readonly: true });
      _analyticsDb.pragma('journal_mode = WAL');
    }
    return _analyticsDb;
  }
  return getDb();
}

/** Create a new database at the given path (use ":memory:" for tests). */
export function createDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** Override the singleton. Used in tests to inject an in-memory database. */
export function setDb(db: Database.Database): void {
  _db = db;
}

// ─── Schema migrations ────────────────────────────────────────────────────────

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id            INTEGER PRIMARY KEY,
      freelancer    TEXT    NOT NULL,
      payer         TEXT    NOT NULL,
      amount        TEXT    NOT NULL,
      due_date      INTEGER NOT NULL,
      discount_rate INTEGER NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'Pending',
      funder        TEXT,
      funded_at     INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      event_id         TEXT    PRIMARY KEY,
      event_type       TEXT    NOT NULL,
      invoice_id       INTEGER NOT NULL,
      ledger           INTEGER NOT NULL,
      ledger_closed_at TEXT    NOT NULL,
      created_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cursor (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      last_ledger  INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fork_decisions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      detected_at       INTEGER NOT NULL,
      from_ledger       INTEGER NOT NULL,
      to_ledger         INTEGER NOT NULL,
      tip_ledger        INTEGER NOT NULL,
      status            TEXT    NOT NULL,
      recovery_attempts INTEGER NOT NULL DEFAULT 0,
      events_removed    INTEGER NOT NULL DEFAULT 0,
      invoices_affected INTEGER NOT NULL DEFAULT 0,
      resolved_at       INTEGER
    );

    CREATE TABLE IF NOT EXISTS reorg_quarantine (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id    INTEGER NOT NULL,
      from_ledger    INTEGER NOT NULL,
      to_ledger      INTEGER NOT NULL,
      reason         TEXT    NOT NULL,
      error_details  TEXT,
      quarantined_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_invoices_status     ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoices_freelancer ON invoices(freelancer);
    CREATE INDEX IF NOT EXISTS idx_invoices_payer      ON invoices(payer);
    CREATE INDEX IF NOT EXISTS idx_invoices_funder     ON invoices(funder);
    CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON invoices(created_at);
    CREATE INDEX IF NOT EXISTS idx_invoices_due_date   ON invoices(due_date);
    CREATE INDEX IF NOT EXISTS idx_invoices_status_funder ON invoices(status, funder);
    CREATE INDEX IF NOT EXISTS idx_events_invoice_id   ON events(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_events_ledger       ON events(ledger);
    CREATE INDEX IF NOT EXISTS idx_events_created_at   ON events(created_at);
    CREATE INDEX IF NOT EXISTS idx_fork_decisions_status ON fork_decisions(status);
    CREATE INDEX IF NOT EXISTS idx_reorg_quarantine_decision ON reorg_quarantine(decision_id);
  `);

  try {
    const tableInfo = db.prepare('PRAGMA table_info(fork_decisions)').all() as { name: string }[];
    const hasAttempts = tableInfo.some((col) => col.name === 'recovery_attempts');
    if (!hasAttempts && tableInfo.length > 0) {
      db.exec('ALTER TABLE fork_decisions ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0;');
    }
  } catch {
    /* migration check failure is non-fatal */
  }
}

// ─── Invoice CRUD ─────────────────────────────────────────────────────────────

/**
 * Insert a new invoice or update an existing one.
 * On conflict (same id), only mutable fields are updated.
 * `created_at` is never overwritten.
 */
export function upsertInvoice(invoice: Omit<Invoice, 'created_at' | 'updated_at'>): void {
  const now = Date.now();
  try {
    const end = dbQueryDuration.startTimer();
    getDb()
      .prepare(
        `INSERT INTO invoices
         (id, freelancer, payer, amount, due_date, discount_rate,
          status, funder, funded_at, created_at, updated_at)
       VALUES
         (@id, @freelancer, @payer, @amount, @due_date, @discount_rate,
          @status, @funder, @funded_at, @created_at, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         status    = excluded.status,
         funder    = excluded.funder,
         funded_at = excluded.funded_at,
         updated_at = excluded.updated_at`
      )
      .run({
        ...invoice,
        funder: invoice.funder ?? null,
        funded_at: invoice.funded_at ?? null,
        created_at: now,
        updated_at: now,
      });
    end();
  } catch (err) {
    try {
      dbErrorsTotal.inc();
    } catch {
      /* metrics failure is non-fatal */
    }
    throw err;
  }
}

/** Return a single invoice by ID, or undefined if not found. */
export function getInvoiceById(id: number): Invoice | undefined {
  try {
    const end = dbQueryDuration.startTimer();
    const row = getDb().prepare('SELECT * FROM invoices WHERE id = ?').get(id) as
      | Invoice
      | undefined;
    end();
    return row;
  } catch (err) {
    try {
      dbErrorsTotal.inc();
    } catch {
      /* metrics failure is non-fatal */
    }
    throw err;
  }
}

export interface InvoiceFilter {
  status?: string;
  freelancer?: string;
  payer?: string;
  funder?: string;
}

/** Return all invoices matching the given filter (all fields are ANDed). */
export function queryInvoices(filter: InvoiceFilter): Invoice[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.freelancer) {
    clauses.push('freelancer = ?');
    params.push(filter.freelancer);
  }
  if (filter.payer) {
    clauses.push('payer = ?');
    params.push(filter.payer);
  }
  if (filter.funder) {
    clauses.push('funder = ?');
    params.push(filter.funder);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM invoices ${where} ORDER BY id ASC`).all(...params) as Invoice[];
}

/**
 * Paginated version of queryInvoices.
 * Returns up to `limit` invoices after the given cursor (exclusive).
 * Provides `hasMore` flag and opaque `nextCursor` for client use.
 */
export function queryInvoicesPaginated(
  filter: InvoiceFilter,
  limit: number,
  cursor?: string
): { invoices: Invoice[]; hasMore: boolean; nextCursor?: string } {
  const db = getDb();
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.freelancer) {
    clauses.push('freelancer = ?');
    params.push(filter.freelancer);
  }
  if (filter.payer) {
    clauses.push('payer = ?');
    params.push(filter.payer);
  }
  if (filter.funder) {
    clauses.push('funder = ?');
    params.push(filter.funder);
  }

  // Decode the opaque cursor (base64 encoded id)
  let cursorId: number | undefined;
  if (cursor) {
    try {
      const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
      cursorId = Number(decoded);
      if (Number.isNaN(cursorId)) {
        cursorId = undefined;
      }
    } catch {
      cursorId = undefined;
    }
  }

  if (cursorId !== undefined) {
    clauses.push('id > ?');
    params.push(cursorId);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  // Fetch one extra row to determine hasMore
  const rows = db
    .prepare(`SELECT * FROM invoices ${where} ORDER BY id ASC LIMIT ?`)
    .all(...params, limit + 1) as Invoice[];

  // Note: measuring the above `.all()` is tricky without wrapping the call
  // in a try/catch; we chose to rely on surrounding try/catch in callers.

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore
    ? Buffer.from(String(sliced[sliced.length - 1].id)).toString('base64')
    : undefined;

  return { invoices: sliced, hasMore, nextCursor };
}

export interface ProtocolStats {
  totalInvoices: number;
  totalVolume: string;
  totalYield: string;
  defaultRate: number;
}

/**
 * LP stats as stored in SQLite.
 *
 * This is a DB-specific projection of @iln/shared's LPStats. Field names
 * differ (`deployed` vs `totalFunded`, `yield` vs `totalEarned`), types are
 * strings (i128 stored as TEXT), and it adds `defaultRate` / `invoiceCount`
 * which are derived metrics not present in the contract struct.
 */
export interface LPStats {
  deployed: string;
  yield: string;
  invoiceCount: number;
  defaultRate: number;
}

export interface FreelancerStats {
  submitted: number;
  funded: number;
  totalReceived: string;
  avgDiscount: number;
}

export interface LPStat {
  address: string;
  yield: string;
  invoiceCount: number;
}

export function getProtocolStats(): ProtocolStats {
  const db = getAnalyticsDb();
  const row = measureAnalytics('getProtocolStats', () =>
    db
      .prepare(
        `SELECT
           COUNT(*)                                                       AS totalInvoices,
           COALESCE(SUM(CAST(amount AS INTEGER)), 0)                      AS totalVolume,
           COALESCE(SUM(CASE WHEN status = 'Paid' THEN CAST(amount AS INTEGER) * discount_rate / 10000 ELSE 0 END), 0) AS totalYield,
           CASE
             WHEN SUM(CASE WHEN status IN ('Paid','Defaulted') THEN 1 ELSE 0 END) > 0
             THEN CAST(SUM(CASE WHEN status = 'Defaulted' THEN 1 ELSE 0 END) AS REAL)
                  / SUM(CASE WHEN status IN ('Paid','Defaulted') THEN 1 ELSE 0 END)
             ELSE 0
           END                                                            AS defaultRate
         FROM invoices`
      )
      .get()
  ) as ProtocolStats;

  return {
    totalInvoices: row.totalInvoices,
    totalVolume: row.totalVolume.toString(),
    totalYield: row.totalYield.toString(),
    defaultRate: row.defaultRate,
  };
}

export function getLPStats(address: string): LPStats {
  const db = getAnalyticsDb();
  const row = measureAnalytics(`getLPStats(${address})`, () =>
    db
      .prepare(
        `SELECT
           COUNT(*)                                                       AS invoiceCount,
           COALESCE(SUM(CAST(amount AS INTEGER)), 0)                      AS deployed,
           COALESCE(SUM(CASE WHEN status = 'Paid' THEN CAST(amount AS INTEGER) * discount_rate / 10000 ELSE 0 END), 0) AS yield,
           CASE
             WHEN SUM(CASE WHEN status IN ('Paid','Defaulted') THEN 1 ELSE 0 END) > 0
             THEN CAST(SUM(CASE WHEN status = 'Defaulted' THEN 1 ELSE 0 END) AS REAL)
                  / SUM(CASE WHEN status IN ('Paid','Defaulted') THEN 1 ELSE 0 END)
             ELSE 0
           END                                                            AS defaultRate
         FROM invoices
         WHERE funder = ?`
      )
      .get(address)
  ) as LPStats;

  return {
    deployed: row.deployed.toString(),
    yield: row.yield.toString(),
    invoiceCount: row.invoiceCount,
    defaultRate: row.defaultRate,
  };
}

export function getFreelancerStats(address: string): FreelancerStats {
  const db = getAnalyticsDb();
  const row = measureAnalytics(`getFreelancerStats(${address})`, () =>
    db
      .prepare(
        `SELECT
           COUNT(*)                                                                           AS submitted,
           COALESCE(SUM(CASE WHEN status IN ('Funded','Paid','Defaulted') THEN 1 ELSE 0 END), 0) AS funded,
           COALESCE(SUM(CASE WHEN status IN ('Funded','Paid','Defaulted') THEN CAST(amount AS INTEGER) - (CAST(amount AS INTEGER) * discount_rate / 10000) ELSE 0 END), 0) AS totalReceived,
           CASE WHEN COUNT(*) > 0 THEN CAST(SUM(discount_rate) AS REAL) / COUNT(*) ELSE 0 END   AS avgDiscount
         FROM invoices
         WHERE freelancer = ?`
      )
      .get(address)
  ) as FreelancerStats;

  return {
    submitted: row.submitted,
    funded: row.funded,
    totalReceived: row.totalReceived.toString(),
    avgDiscount: Math.round(row.avgDiscount * 100) / 100,
  };
}

/**
 * Allowed field names for projection filtering on the history endpoint.
 * Restricting to a known set prevents SQL injection via column names.
 */
const ALLOWED_PROJECTION_FIELDS = new Set([
  'id',
  'freelancer',
  'payer',
  'amount',
  'due_date',
  'discount_rate',
  'status',
  'funder',
  'funded_at',
  'created_at',
  'updated_at',
]);

export function getInvoiceHistory(
  address: string,
  role: 'freelancer' | 'payer' | 'funder',
  fields?: string[]
): Invoice[] | Record<string, unknown>[] {
  if (fields && fields.length > 0) {
    const validFields = fields.filter((f) => ALLOWED_PROJECTION_FIELDS.has(f));
    if (validFields.length > 0) {
      return queryInvoicesProjected({ [role]: address }, validFields);
    }
  }
  return queryInvoices({ [role]: address });
}

/**
 * Return invoices matching the filter with only the requested columns.
 * Reduces payload size when callers only need a subset of fields.
 */
function queryInvoicesProjected(
  filter: InvoiceFilter,
  fields: string[]
): Record<string, unknown>[] {
  const db = getDb();
  const columns = fields.join(', ');
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.freelancer) {
    clauses.push('freelancer = ?');
    params.push(filter.freelancer);
  }
  if (filter.payer) {
    clauses.push('payer = ?');
    params.push(filter.payer);
  }
  if (filter.funder) {
    clauses.push('funder = ?');
    params.push(filter.funder);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(`SELECT ${columns} FROM invoices ${where} ORDER BY id ASC`)
    .all(...params) as Record<string, unknown>[];
}

export function getTopLPs(limit: number, period: string): LPStat[] {
  const db = getAnalyticsDb();
  const now = Date.now();
  const since =
    period === 'week'
      ? now - 7 * 24 * 60 * 60 * 1000
      : period === 'month'
      ? now - 30 * 24 * 60 * 60 * 1000
      : 0;

  const whereSince =
    since > 0
      ? 'WHERE funder IS NOT NULL AND (CASE WHEN funded_at IS NOT NULL THEN funded_at * 1000 ELSE created_at END) >= ?'
      : 'WHERE funder IS NOT NULL';

  const params: (number | string)[] = since > 0 ? [since, limit] : [limit];

  const rows = measureAnalytics(`getTopLPs(${limit}, ${period})`, () =>
    db
      .prepare(
        `SELECT
           funder                                                        AS address,
           COALESCE(SUM(CASE WHEN status = 'Paid' THEN CAST(amount AS INTEGER) * discount_rate / 10000 ELSE 0 END), 0) AS yield,
           COUNT(*)                                                      AS invoiceCount
         FROM invoices
         ${whereSince}
         GROUP BY funder
         ORDER BY yield DESC, invoiceCount DESC
         LIMIT ?`
      )
      .all(...params)
  ) as LPStat[];

  return rows.map((r) => ({
    address: r.address,
    yield: r.yield.toString(),
    invoiceCount: r.invoiceCount,
  }));
}

// ─── Event queries ────────────────────────────────────────────────────────────

/** Return events, optionally filtered by invoice_id. */
export function getEvents(invoiceId?: number): ILNEvent[] {
  const db = getDb();
  if (invoiceId !== undefined) {
    return db
      .prepare('SELECT * FROM events WHERE invoice_id = ? ORDER BY ledger ASC')
      .all(invoiceId) as ILNEvent[];
  }
  return db.prepare('SELECT * FROM events ORDER BY ledger ASC LIMIT 1000').all() as ILNEvent[];
}

// ─── Event deduplication ──────────────────────────────────────────────────────

/** Return true if this event has already been processed. */
export function hasEvent(eventId: string): boolean {
  return getDb().prepare('SELECT 1 FROM events WHERE event_id = ?').get(eventId) !== undefined;
}

/**
 * Insert an event record.
 * Uses INSERT OR IGNORE so duplicate events are silently dropped.
 */
export function insertEvent(event: ILNEvent): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO events
         (event_id, event_type, invoice_id, ledger, ledger_closed_at, created_at)
       VALUES
         (@event_id, @event_type, @invoice_id, @ledger, @ledger_closed_at, @created_at)`
    )
    .run(event);
}

/**
 * Atomically apply an event and invoice state in a single transaction.
 * Ensures that partial writes never leave orphaned event or invoice rows,
 * guaranteeing idempotency across restarts and replays (#1260).
 */
export function applyEventWithInvoice(
  event: ILNEvent,
  invoice: Omit<Invoice, 'created_at' | 'updated_at'> | null
): { isChanged: boolean } {
  const db = getDb();
  let isChanged = false;

  db.transaction(() => {
    // 1. Insert event (INSERT OR IGNORE prevents duplicates)
    db.prepare(
      `INSERT OR IGNORE INTO events
         (event_id, event_type, invoice_id, ledger, ledger_closed_at, created_at)
       VALUES
         (@event_id, @event_type, @invoice_id, @ledger, @ledger_closed_at, @created_at)`
    ).run(event);

    // 2. If invoice provided, check if changed and upsert
    if (invoice) {
      const existing = db
        .prepare('SELECT status, funder FROM invoices WHERE id = ?')
        .get(invoice.id) as { status: string; funder: string | null } | undefined;

      isChanged =
        !existing ||
        existing.status !== invoice.status ||
        existing.funder !== (invoice.funder ?? null);

      if (isChanged) {
        const now = Date.now();
        db.prepare(
          `INSERT INTO invoices
           (id, freelancer, payer, amount, due_date, discount_rate,
            status, funder, funded_at, created_at, updated_at)
         VALUES
           (@id, @freelancer, @payer, @amount, @due_date, @discount_rate,
            @status, @funder, @funded_at, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           status    = excluded.status,
           funder    = excluded.funder,
           funded_at = excluded.funded_at,
           updated_at = excluded.updated_at`
        ).run({
          ...invoice,
          funder: invoice.funder ?? null,
          funded_at: invoice.funded_at ?? null,
          created_at: now,
          updated_at: now,
        });
      }
    }
  })();

  return { isChanged };
}

// ─── Cursor management ────────────────────────────────────────────────────────

/** Return the last processed ledger sequence, or 0 if never set. */
export function getCursorLedger(): number {
  const row = getDb().prepare('SELECT last_ledger FROM cursor WHERE id = 1').get() as
    | { last_ledger: number }
    | undefined;
  return row?.last_ledger ?? 0;
}

/** Return the Unix ms timestamp of the last processed ledger, or null if never synced. */
export function getCursorUpdatedAt(): number | null {
  const row = getDb().prepare('SELECT updated_at FROM cursor WHERE id = 1').get() as
    | { updated_at: number }
    | undefined;
  return row?.updated_at ?? null;
}

/**
 * Persist the last processed ledger sequence.
 * Enforces cursor monotonicity: normal forward indexing cannot rewind the cursor.
 * Rewinds are only permitted via explicit authorized rollback (`allowRewind = true`).
 */
export function setCursorLedger(ledger: number, allowRewind = false): void {
  const current = getCursorLedger();
  if (!allowRewind && ledger < current) {
    try {
      cursorMonotonicityViolationsTotal.inc();
    } catch {
      /* metrics failure is non-fatal */
    }
    throw new Error(
      `[DB] Cursor monotonicity violation: attempted to set cursor to ${ledger} from ${current} without allowRewind`
    );
  }

  const updatedAt = Date.now();
  getDb()
    .prepare(
      `INSERT INTO cursor (id, last_ledger, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_ledger = excluded.last_ledger,
         updated_at  = excluded.updated_at`
    )
    .run(ledger, updatedAt);

  try {
    lastProcessedLedger.set(ledger);
    cursorUpdatedAt.set(updatedAt);
  } catch {
    /* metrics failure is non-fatal */
  }
}

/** Rollback events and cursor to a specific ledger, reverting invoice state. */
export function rollbackToLedger(
  ledger: number,
  decisionId?: number
): { eventsRemoved: number; invoicesAffected: number; affectedInvoiceIds: number[] } {
  const db = getDb();
  let eventsRemoved = 0;
  let invoicesAffected = 0;
  let affectedInvoiceIds: number[] = [];

  db.transaction(() => {
    // 1. Identify all invoices affected by events after the rollback ledger
    const removedEventRows = db
      .prepare('SELECT DISTINCT invoice_id FROM events WHERE ledger > ?')
      .all(ledger) as { invoice_id: number }[];

    affectedInvoiceIds = removedEventRows.map((r) => r.invoice_id);
    invoicesAffected = affectedInvoiceIds.length;

    // 2. Revert invoice states or remove them if created on the abandoned fork
    for (const invoiceId of affectedInvoiceIds) {
      const remainingEvents = db
        .prepare(
          'SELECT event_type FROM events WHERE invoice_id = ? AND ledger <= ? ORDER BY ledger ASC, created_at ASC'
        )
        .all(invoiceId, ledger) as { event_type: string }[];

      if (remainingEvents.length === 0) {
        // Invoice originated on the abandoned fork; remove from SQLite
        db.prepare('DELETE FROM invoices WHERE id = ?').run(invoiceId);
      } else {
        // Derive state from the last valid event on the canonical branch
        const lastEventType = remainingEvents[remainingEvents.length - 1].event_type;
        let restoredStatus: InvoiceStatus = 'Pending';
        let funderReset = false;

        switch (lastEventType) {
          case 'submitted':
            restoredStatus = 'Pending';
            funderReset = true;
            break;
          case 'funded':
            restoredStatus = 'Funded';
            break;
          case 'paid':
            restoredStatus = 'Paid';
            break;
          case 'defaulted':
            restoredStatus = 'Defaulted';
            break;
          default:
            restoredStatus = 'Pending';
            funderReset = true;
        }

        if (funderReset) {
          db.prepare(
            'UPDATE invoices SET status = ?, funder = NULL, funded_at = NULL, updated_at = ? WHERE id = ?'
          ).run(restoredStatus, Date.now(), invoiceId);
        } else {
          db.prepare(
            'UPDATE invoices SET status = ?, updated_at = ? WHERE id = ?'
          ).run(restoredStatus, Date.now(), invoiceId);
        }
      }
    }

    // 3. Delete the rolled-back events from the events table
    const deleteResult = db.prepare('DELETE FROM events WHERE ledger > ?').run(ledger);
    eventsRemoved = deleteResult.changes;

    // 4. Update the cursor position in DB
    db.prepare(
      `INSERT INTO cursor (id, last_ledger, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_ledger = excluded.last_ledger,
         updated_at  = excluded.updated_at`
    ).run(ledger, Date.now());

    // 5. Complete fork decision if ID is passed
    if (decisionId !== undefined) {
      db.prepare(
        `UPDATE fork_decisions
         SET status = 'completed',
             events_removed = ?,
             invoices_affected = ?,
             resolved_at = ?
         WHERE id = ?`
      ).run(eventsRemoved, invoicesAffected, Date.now(), decisionId);
    }
  })();

  try {
    lastProcessedLedger.set(ledger);
    if (eventsRemoved > 0) {
      reorgRemovedEventsTotal.inc(eventsRemoved);
    }
    if (decisionId !== undefined) {
      reorgForkDecisionsTotal.inc({ status: 'completed' });
      reorgPendingDecisions.dec();
    }
  } catch {}

  return { eventsRemoved, invoicesAffected, affectedInvoiceIds };
}

// ─── Fork Replacement Decisions ──────────────────────────────────────────────

/** Record a new fork replacement decision when a chain tip rewind is detected. */
export function recordForkDecision(
  fromLedger: number,
  toLedger: number,
  tipLedger: number
): number {
  const db = getDb();
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO fork_decisions
       (detected_at, from_ledger, to_ledger, tip_ledger, status)
       VALUES (?, ?, ?, ?, 'in_progress')`
    )
    .run(now, fromLedger, toLedger, tipLedger);

  try {
    reorgForkDecisionsTotal.inc({ status: 'in_progress' });
    reorgPendingDecisions.inc();
  } catch {}

  return Number(info.lastInsertRowid);
}

/** Complete a fork replacement decision after rollback and state reconciliation. */
export function completeForkDecision(
  id: number,
  eventsRemoved: number,
  invoicesAffected: number
): void {
  const db = getDb();
  db.prepare(
    `UPDATE fork_decisions
     SET status = 'completed',
         events_removed = ?,
         invoices_affected = ?,
         resolved_at = ?
     WHERE id = ?`
  ).run(eventsRemoved, invoicesAffected, Date.now(), id);

  try {
    reorgForkDecisionsTotal.inc({ status: 'completed' });
    reorgPendingDecisions.dec();
  } catch {}
}

/** Abort a fork replacement decision if the cycle aborts due to unstable reorg. */
export function abortForkDecision(id: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE fork_decisions
     SET status = 'aborted',
         resolved_at = ?
     WHERE id = ?`
  ).run(Date.now(), id);

  try {
    reorgForkDecisionsTotal.inc({ status: 'aborted' });
    reorgPendingDecisions.dec();
  } catch {}
}

/** Return any pending in-progress fork decision from a prior crashed run. */
export function getPendingForkDecision(): ForkDecision | undefined {
  const db = getDb();
  return db
    .prepare('SELECT * FROM fork_decisions WHERE status = ? ORDER BY id ASC LIMIT 1')
    .get('in_progress') as ForkDecision | undefined;
}

/** Return recent fork replacement decisions for audit and monitoring. */
export function getForkDecisions(limit = 50): ForkDecision[] {
  const db = getDb();
  return db
    .prepare('SELECT * FROM fork_decisions ORDER BY id DESC LIMIT ?')
    .all(limit) as ForkDecision[];
}

/** Increment the recovery attempts counter for an in-progress fork decision. */
export function incrementForkDecisionAttempts(id: number): number {
  const db = getDb();
  db.prepare('UPDATE fork_decisions SET recovery_attempts = recovery_attempts + 1 WHERE id = ?').run(id);
  const row = db.prepare('SELECT recovery_attempts FROM fork_decisions WHERE id = ?').get(id) as
    | { recovery_attempts: number }
    | undefined;
  return row?.recovery_attempts ?? 1;
}

/**
 * Quarantine an incomplete, corrupted, or repeatedly failing fork decision.
 * Moves the fork decision to 'quarantined' status, logs a structured entry in
 * `reorg_quarantine`, and decrements pending decisions.
 */
export function quarantineForkDecision(
  id: number,
  reason: string,
  errorDetails?: string
): void {
  const db = getDb();
  const now = Date.now();

  db.transaction(() => {
    const decision = db
      .prepare('SELECT from_ledger, to_ledger, status FROM fork_decisions WHERE id = ?')
      .get(id) as { from_ledger: number; to_ledger: number; status: string } | undefined;

    const fromLedger = decision?.from_ledger ?? 0;
    const toLedger = decision?.to_ledger ?? 0;
    const wasPending = decision?.status === 'in_progress';

    db.prepare(
      `UPDATE fork_decisions
       SET status = 'quarantined',
           resolved_at = ?
       WHERE id = ?`
    ).run(now, id);

    db.prepare(
      `INSERT INTO reorg_quarantine
       (decision_id, from_ledger, to_ledger, reason, error_details, quarantined_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, fromLedger, toLedger, reason, errorDetails ?? null, now);

    try {
      reorgForkDecisionsTotal.inc({ status: 'quarantined' });
      reorgQuarantinedTotal.inc();
      reorgQuarantinedActive.inc();
      if (wasPending) {
        reorgPendingDecisions.dec();
      }
    } catch {
      /* metrics failure is non-fatal */
    }
  })();
}

/** Return all quarantined reorg decisions for audit and operator recovery. */
export function getQuarantinedReorgs(limit = 50): QuarantinedReorg[] {
  const db = getDb();
  return db
    .prepare('SELECT * FROM reorg_quarantine ORDER BY id DESC LIMIT ?')
    .all(limit) as QuarantinedReorg[];
}

/** Check if a given fork decision has been quarantined. */
export function isReorgQuarantined(decisionId: number): boolean {
  const db = getDb();
  const row = db
    .prepare('SELECT id FROM reorg_quarantine WHERE decision_id = ? LIMIT 1')
    .get(decisionId);
  return Boolean(row);
}

