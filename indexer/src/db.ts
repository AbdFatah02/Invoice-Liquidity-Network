import Database from 'better-sqlite3';
import {
  dbQueryDuration,
  dbErrorsTotal,
  lastProcessedLedger,
  cursorUpdatedAt,
  analyticsQueryDuration,
  analyticsQueryExceededBudget,
} from './metrics';
import { CONFIG } from './config';
import type { ILNEvent, Invoice } from './types';

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
  `);
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

/** Persist the last processed ledger sequence. */
export function setCursorLedger(ledger: number): void {
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

/** Rollback events and cursor to a specific ledger. */
export function rollbackToLedger(ledger: number): void {
  const db = getDb();
  db.prepare('DELETE FROM events WHERE ledger > ?').run(ledger);
  db.prepare('UPDATE cursor SET last_ledger = ? WHERE id = 1').run(ledger);
  try {
    lastProcessedLedger.set(ledger);
  } catch {}
}
