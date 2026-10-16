import { randomUUID } from 'crypto';
import { getDb, type InvoiceFilter } from './db';
import type { Invoice, ILNEvent } from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum rows served synchronously. Requests exceeding this must use async jobs. */
export const SYNC_EXPORT_LIMIT = 5_000;

/** Maximum rows allowed in an async export job to prevent memory exhaustion. */
export const ASYNC_EXPORT_LIMIT = 50_000;

/** Response bytes buffered before the stream writer flushes to the socket. */
const EXPORT_FLUSH_THRESHOLD_BYTES = 64_000;

// ─── Filter types ─────────────────────────────────────────────────────────────

export interface ExportFilter extends InvoiceFilter {
  /** ISO 8601 date/datetime — include rows with created_at >= this value. */
  from?: string;
  /** ISO 8601 date/datetime — include rows with created_at <= this value. */
  to?: string;
  /** Opaque resumption cursor from `X-Export-Resumption-Cursor` (invoices: id-based). */
  cursor?: string;
}

export interface EventExportFilter {
  invoiceId?: number;
  from?: string;
  to?: string;
  /** Opaque resumption cursor from `X-Export-Resumption-Cursor` (events: ledger-based). */
  cursor?: string;
}

// ─── Session resource budgets ─────────────────────────────────────────────────

/**
 * Per-session export budgets. Enforced across resumed pages of one export
 * session (see encodeExportCursor) so a long paginated export cannot
 * accumulate unbounded rows/time/bytes beyond these caps.
 * Read lazily from process.env so deployments and tests can tune per request.
 */
export interface ExportSessionBudget {
  /** Cumulative row cap across all resumed pages of one session. */
  maxRows: number;
  /** Wall-clock cap for a single streaming response (ms). */
  maxMs: number;
  /** Output byte cap for a single streaming response. */
  maxBytes: number;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function exportSessionBudget(): ExportSessionBudget {
  return {
    maxRows: positiveNumber(process.env.EXPORT_SESSION_MAX_ROWS, 200_000),
    maxMs: positiveNumber(process.env.EXPORT_SESSION_MAX_SECONDS, 300) * 1000,
    maxBytes: positiveNumber(process.env.EXPORT_SESSION_MAX_BYTES, 100_000_000),
  };
}

/** Per-response row cap for a streaming page (defaults to the sync limit). */
export function exportPageMaxRows(): number {
  return positiveNumber(process.env.EXPORT_PAGE_MAX_ROWS, SYNC_EXPORT_LIMIT);
}

/** Finished jobs are evicted this long after completion. */
export function exportJobTtlMs(): number {
  return positiveNumber(process.env.EXPORT_JOB_TTL_SECONDS, 1_800) * 1000;
}

/** Hard cap on concurrently-tracked jobs; oldest finished jobs are evicted first. */
export function exportJobMaxCount(): number {
  return positiveNumber(process.env.EXPORT_JOB_MAX, 1_000);
}

// ─── Export session cursors ───────────────────────────────────────────────────

/**
 * Cursor payload: base64 of `"<rowId>[:<rowsDeliveredSoFar>]"` — the opaque
 * base64 row-id style of GET /v1/invoices, plus an optional cumulative count
 * so the session row budget survives resumption.
 */
export interface ExportCursor {
  id: number;
  rowsBefore: number;
}

export function encodeExportCursor(id: number, rowsBefore: number): string {
  const payload = rowsBefore > 0 ? `${id}:${rowsBefore}` : `${id}`;
  return Buffer.from(payload, 'utf-8').toString('base64');
}

export function decodeExportCursor(cursor?: string): ExportCursor | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
    const [idPart, rowsPart] = decoded.split(':');
    const id = Number(idPart);
    if (!Number.isFinite(id) || id < 0) return undefined;
    const rowsBefore = rowsPart !== undefined ? Number(rowsPart) : 0;
    return { id, rowsBefore: Number.isFinite(rowsBefore) && rowsBefore > 0 ? rowsBefore : 0 };
  } catch {
    return undefined;
  }
}

// ─── Job types ────────────────────────────────────────────────────────────────

export type ExportFormat = 'csv' | 'json';
export type ExportType = 'invoices' | 'events';
export type ExportStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface ExportJob {
  jobId: string;
  type: ExportType;
  format: ExportFormat;
  status: ExportStatus;
  filter: ExportFilter | EventExportFilter;
  createdAt: number;
  completedAt?: number;
  rowCount?: number;
  error?: string;
  /** True when a session budget cut the export off mid-stream. */
  truncated?: boolean;
  /** Resume by re-submitting POST /export/jobs with this cursor in the body. */
  resumptionCursor?: string;
}

// ─── In-memory job store ──────────────────────────────────────────────────────

interface JobEntry {
  job: ExportJob;
  content?: string;
}

const _jobs = new Map<string, JobEntry>();

function isFinished(job: ExportJob): boolean {
  return job.status === 'done' || job.status === 'failed';
}

/**
 * Bound `_jobs` growth: evict finished jobs past their TTL, then — if still
 * over the cap — drop the oldest entries (Map preserves insertion order, so
 * the newest jobs are kept).
 */
function pruneJobs(): void {
  const ttlMs = exportJobTtlMs();
  const now = Date.now();
  for (const [id, entry] of _jobs) {
    if (isFinished(entry.job) && entry.job.completedAt !== undefined) {
      if (now - entry.job.completedAt > ttlMs) _jobs.delete(id);
    }
  }
  const max = exportJobMaxCount();
  if (_jobs.size > max) {
    const finishedFirst = [..._jobs.entries()].filter(([, e]) => isFinished(e.job));
    for (const [id] of finishedFirst) {
      if (_jobs.size <= max) break;
      _jobs.delete(id);
    }
    for (const [id] of _jobs) {
      if (_jobs.size <= max) break;
      _jobs.delete(id);
    }
  }
}

export function createExportJob(
  type: ExportType,
  format: ExportFormat,
  filter: ExportFilter | EventExportFilter
): ExportJob {
  pruneJobs();
  const jobId = randomUUID();
  const job: ExportJob = {
    jobId,
    type,
    format,
    status: 'pending',
    filter,
    createdAt: Date.now(),
  };
  _jobs.set(jobId, { job });
  pruneJobs();
  return job;
}

export function getExportJob(jobId: string): ExportJob | undefined {
  const entry = _jobs.get(jobId);
  if (!entry) return undefined;
  if (
    isFinished(entry.job) &&
    entry.job.completedAt !== undefined &&
    Date.now() - entry.job.completedAt > exportJobTtlMs()
  ) {
    _jobs.delete(jobId);
    return undefined;
  }
  return entry.job;
}

export function getExportContent(jobId: string): string | undefined {
  return _jobs.get(jobId)?.content;
}

/** Clear all jobs — used in tests only. */
export function _clearJobs(): void {
  _jobs.clear();
}

// ─── Async job processing ─────────────────────────────────────────────────────

export async function processExportJob(jobId: string): Promise<void> {
  const entry = _jobs.get(jobId);
  if (!entry) return;

  entry.job.status = 'processing';

  try {
    const budget = exportSessionBudget();
    const chunks: string[] = [];
    const sink: ExportSink = {
      write: (chunk: string) => chunks.push(chunk),
      setHeader: () => undefined,
    };
    let result: StreamExportResult;

    if (entry.job.type === 'invoices') {
      const filter = entry.job.filter as ExportFilter;
      const cursor = decodeExportCursor(filter.cursor);
      const sessionLeft = budget.maxRows - (cursor?.rowsBefore ?? 0);
      if (sessionLeft <= 0) {
        throw new Error(
          `Export session row budget exhausted (${budget.maxRows} rows). Start a new session without a cursor.`
        );
      }
      const rowBudget = Math.min(ASYNC_EXPORT_LIMIT, exportPageMaxRows(), sessionLeft);
      const count = countInvoicesForExport(filter);
      if (count > ASYNC_EXPORT_LIMIT) {
        throw new Error(
          `Result set too large (${count} rows). Maximum allowed for async export is ${ASYNC_EXPORT_LIMIT}.`
        );
      }
      const stmtResult = streamInvoicesExport(sink, filter, entry.job.format, {
        maxRows: rowBudget,
        maxBytes: budget.maxBytes,
        maxMs: budget.maxMs,
        rowsBefore: cursor?.rowsBefore,
        withHeader: true,
      });
      result = stmtResult;
    } else {
      const filter = entry.job.filter as EventExportFilter;
      const cursor = decodeExportCursor(filter.cursor);
      const sessionLeft = budget.maxRows - (cursor?.rowsBefore ?? 0);
      if (sessionLeft <= 0) {
        throw new Error(
          `Export session row budget exhausted (${budget.maxRows} rows). Start a new session without a cursor.`
        );
      }
      const rowBudget = Math.min(ASYNC_EXPORT_LIMIT, exportPageMaxRows(), sessionLeft);
      const count = countEventsForExport(filter);
      if (count > ASYNC_EXPORT_LIMIT) {
        throw new Error(
          `Result set too large (${count} rows). Maximum allowed for async export is ${ASYNC_EXPORT_LIMIT}.`
        );
      }
      result = streamEventsExport(sink, filter, entry.job.format, {
        maxRows: rowBudget,
        maxBytes: budget.maxBytes,
        maxMs: budget.maxMs,
        rowsBefore: cursor?.rowsBefore,
        withHeader: true,
      });
    }

    entry.job.status = 'done';
    entry.job.completedAt = Date.now();
    entry.job.rowCount = result.rowsWritten;
    entry.job.truncated = result.truncated;
    entry.job.resumptionCursor = result.resumptionCursor;
    entry.content = chunks.join('');
  } catch (err) {
    entry.job.status = 'failed';
    entry.job.error = err instanceof Error ? err.message : 'Unknown error';
  }
}

// ─── Sync count helpers ───────────────────────────────────────────────────────

export function countInvoicesForExport(filter: ExportFilter): number {
  const { clauses, params } = buildInvoiceClauses(filter);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = getDb()
    .prepare(`SELECT COUNT(*) as count FROM invoices ${where}`)
    .get(...params) as { count: number };
  return result.count;
}

export function countEventsForExport(filter: EventExportFilter): number {
  const { clauses, params } = buildEventClauses(filter);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = getDb()
    .prepare(`SELECT COUNT(*) as count FROM events ${where}`)
    .get(...params) as { count: number };
  return result.count;
}

/**
 * Id of the row that a budget-truncated response will end on: the row at
 * `offset` (0-based) among remaining rows. Used to pre-compute the resumption
 * cursor so truncation headers can be sent before any body bytes are flushed.
 */
export function invoiceIdAtOffset(filter: ExportFilter, offset: number): number | undefined {
  const { clauses, params } = buildInvoiceClauses(filter);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const row = getDb()
    .prepare(`SELECT id FROM invoices ${where} ORDER BY id ASC LIMIT 1 OFFSET ?`)
    .get(...params, offset) as { id: number } | undefined;
  return row?.id;
}

export function eventLedgerAtOffset(filter: EventExportFilter, offset: number): number | undefined {
  const { clauses, params } = buildEventClauses(filter);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const row = getDb()
    .prepare(`SELECT ledger FROM events ${where} ORDER BY ledger ASC LIMIT 1 OFFSET ?`)
    .get(...params, offset) as { ledger: number } | undefined;
  return row?.ledger;
}

// ─── Data queries (non-streaming, kept for compatibility) ─────────────────────

export function queryInvoicesForExport(filter: ExportFilter): Invoice[] {
  const { clauses, params } = buildInvoiceClauses(filter);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return getDb()
    .prepare(`SELECT * FROM invoices ${where} ORDER BY id ASC`)
    .all(...params) as Invoice[];
}

// ─── Clause builders ──────────────────────────────────────────────────────────

function buildInvoiceClauses(filter: ExportFilter): {
  clauses: string[];
  params: (string | number)[];
} {
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
  if (filter.from) {
    clauses.push('created_at >= ?');
    params.push(new Date(filter.from).getTime());
  }
  if (filter.to) {
    clauses.push('created_at <= ?');
    params.push(new Date(filter.to).getTime());
  }
  if (filter.cursor) {
    const cursor = decodeExportCursor(filter.cursor);
    if (cursor) {
      clauses.push('id > ?');
      params.push(cursor.id);
    }
  }

  return { clauses, params };
}

function buildEventClauses(filter: EventExportFilter): {
  clauses: string[];
  params: (string | number)[];
} {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.invoiceId !== undefined) {
    clauses.push('invoice_id = ?');
    params.push(filter.invoiceId);
  }
  if (filter.from) {
    clauses.push('created_at >= ?');
    params.push(new Date(filter.from).getTime());
  }
  if (filter.to) {
    clauses.push('created_at <= ?');
    params.push(new Date(filter.to).getTime());
  }
  if (filter.cursor) {
    const cursor = decodeExportCursor(filter.cursor);
    if (cursor) {
      clauses.push('ledger > ?');
      params.push(cursor.id);
    }
  }

  return { clauses, params };
}

// ─── Streaming export core ────────────────────────────────────────────────────

/** Minimal view of an HTTP response (also satisfied by an array-collecting sink). */
export interface ExportSink {
  write(chunk: string): unknown;
  setHeader(name: string, value: string): unknown;
  headersSent?: boolean;
}

export interface StreamExportResult {
  rowsWritten: number;
  /** Bytes handed to the sink, including still-buffered content. */
  bytesWritten: number;
  /** True when a budget cut the stream off after a complete row. */
  truncated: boolean;
  /** Set only when `truncated` and the cursor could be emitted. */
  resumptionCursor?: string;
}

/**
 * Buffers serialized output and only touches the socket once the buffer
 * exceeds the flush threshold — this keeps header emission (truncation
 * cursor) possible for small/medium responses while bounding memory to
 * roughly one flush block for large ones.
 */
class StreamWriter {
  private pending: string[] = [];
  /** Bytes still sitting in the write buffer (not yet sent). */
  pendingBytes = 0;
  bytesWritten = 0;

  constructor(private readonly sink: ExportSink) {}

  get flushedToSocket(): boolean {
    return this.bytesWritten > 0;
  }

  write(chunk: string): void {
    const bytes = Buffer.byteLength(chunk, 'utf8');
    this.pending.push(chunk);
    this.pendingBytes += bytes;
    if (this.pendingBytes >= EXPORT_FLUSH_THRESHOLD_BYTES) this.flush();
  }

  flush(): void {
    if (this.pending.length === 0) return;
    this.bytesWritten += this.pendingBytes;
    this.sink.write(this.pending.join(''));
    this.pending = [];
    this.pendingBytes = 0;
  }
}

/** Byte-exact reproduction of `JSON.stringify(row, null, 2)` as one array element. */
function jsonArrayElement(value: unknown): string {
  return `  ${JSON.stringify(value, null, 2).split('\n').join('\n  ')}`;
}

function csvInvoiceRow(inv: Invoice): string {
  return [
    inv.id,
    csvEscape(inv.freelancer),
    csvEscape(inv.payer),
    csvEscape(inv.amount),
    inv.due_date,
    inv.discount_rate,
    csvEscape(inv.status),
    inv.funder !== null ? csvEscape(inv.funder) : '',
    inv.funded_at !== null ? inv.funded_at : '',
    inv.created_at,
    inv.updated_at,
  ].join(',');
}

function csvEventRow(evt: ILNEvent): string {
  return [
    csvEscape(evt.event_id),
    csvEscape(evt.event_type),
    evt.invoice_id,
    evt.ledger,
    csvEscape(evt.ledger_closed_at),
    evt.created_at,
  ].join(',');
}

interface StreamOptions {
  maxRows: number;
  maxBytes: number;
  maxMs: number;
  /** Rows already delivered in a previous page of this session. */
  rowsBefore?: number;
  /** Emit CSV header / JSON array wrapper. */
  withHeader?: boolean;
}

function streamQuery<T>(
  sink: ExportSink,
  sql: string,
  params: (string | number)[],
  format: ExportFormat,
  options: StreamOptions,
  toCsvRow: (row: T) => string,
  header: string,
  cursorOf: (row: T) => number
): StreamExportResult {
  const writer = new StreamWriter(sink);
  const startMs = Date.now();
  const rowsBefore = options.rowsBefore ?? 0;

  let rowsWritten = 0;
  let truncated = false;
  let lastCursorId = 0;

  const push = (chunk: string): void => writer.write(chunk);

  if (options.withHeader !== false && format === 'csv') push(header);

  const stmt = getDb().prepare(sql);
  const iterator = stmt.iterate(...params) as IterableIterator<T>;
  try {
    for (const row of iterator) {
      const chunk =
        format === 'csv'
          ? (rowsWritten === 0 && options.withHeader === false ? '' : '\n') + toCsvRow(row)
          : (rowsWritten === 0 ? '[' : ',') + '\n' + jsonArrayElement(row);

      const wouldExceedBytes =
        writer.bytesWritten + writer.pendingBytes + Buffer.byteLength(chunk, 'utf8') >
        options.maxBytes;
      const exceededTime = rowsWritten % 256 === 0 && Date.now() - startMs > options.maxMs;
      if (rowsWritten + 1 > options.maxRows || wouldExceedBytes || exceededTime) {
        truncated = true;
        break;
      }

      push(chunk);
      rowsWritten++;
      lastCursorId = cursorOf(row);
    }

    if (format === 'json') push(rowsWritten === 0 ? '[]' : '\n]');
  } finally {
    // `iterator.return()` releases the statement's read position so the
    // connection doesn't accumulate open statements on early cutoff.
    iterator.return?.();
  }

  const result: StreamExportResult = {
    rowsWritten,
    bytesWritten: writer.bytesWritten + writer.pendingBytes,
    truncated,
  };

  if (truncated && !writer.flushedToSocket && !sink.headersSent) {
    result.resumptionCursor = encodeExportCursor(lastCursorId, rowsBefore + rowsWritten);
    sink.setHeader('X-Export-Truncated', 'true');
    sink.setHeader('X-Export-Resumption-Cursor', result.resumptionCursor);
  }

  writer.flush();
  return result;
}

/**
 * Stream invoices matching `filter` into `sink` as CSV or JSON, enforcing the
 * row/byte/time budgets. Output is byte-identical to the previous
 * materialize-and-send implementation for non-truncated responses.
 */
export function streamInvoicesExport(
  sink: ExportSink,
  filter: ExportFilter,
  format: ExportFormat,
  options: {
    maxRows: number;
    maxBytes: number;
    maxMs: number;
    rowsBefore?: number;
    withHeader?: boolean;
  }
): StreamExportResult {
  const { clauses, params } = buildInvoiceClauses(filter);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return streamQuery<Invoice>(
    sink,
    `SELECT * FROM invoices ${where} ORDER BY id ASC`,
    params,
    format,
    options,
    csvInvoiceRow,
    INVOICE_CSV_HEADER,
    (row) => row.id
  );
}

/** Stream events matching `filter` into `sink` under the same budgets. */
export function streamEventsExport(
  sink: ExportSink,
  filter: EventExportFilter,
  format: ExportFormat,
  options: {
    maxRows: number;
    maxBytes: number;
    maxMs: number;
    rowsBefore?: number;
    withHeader?: boolean;
  }
): StreamExportResult {
  const { clauses, params } = buildEventClauses(filter);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return streamQuery<ILNEvent & { [k: string]: unknown }>(
    sink,
    `SELECT * FROM events ${where} ORDER BY ledger ASC`,
    params,
    format,
    { ...options, rowsBefore: options.rowsBefore ?? 0 },
    csvEventRow,
    EVENT_CSV_HEADER,
    (row) => row.ledger
  );
}

// ─── CSV serializers (materialized helpers, kept for compatibility/tests) ─────

const INVOICE_CSV_HEADER =
  'id,freelancer,payer,amount,due_date,discount_rate,status,funder,funded_at,created_at,updated_at';

export function invoicesToCsv(invoices: Invoice[]): string {
  const rows = invoices.map((inv) => csvInvoiceRow(inv));
  return [INVOICE_CSV_HEADER, ...rows].join('\n');
}

const EVENT_CSV_HEADER = 'event_id,event_type,invoice_id,ledger,ledger_closed_at,created_at';

export function eventsToCsv(events: ILNEvent[]): string {
  const rows = events.map((evt) => csvEventRow(evt));
  return [EVENT_CSV_HEADER, ...rows].join('\n');
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
