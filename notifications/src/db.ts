import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { CONFIG } from './config';
import type {
  ILNEventType,
  Invoice,
  NotificationPayload,
  NotificationTrigger,
  Subscription,
  SubscriptionChannel,
  WebhookDeliveryLog,
} from './types';

type SQLiteDatabase = InstanceType<typeof Database>;

let _db: SQLiteDatabase | null = null;

export function getDb(): SQLiteDatabase {
  if (!_db) {
    _db = createDb(CONFIG.dbPath);
  }
  return _db;
}

export function createDb(path: string): SQLiteDatabase {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function setDb(db: SQLiteDatabase): void {
  _db = db;
}

/**
 * Idempotently add a column to an existing table.
 *
 * SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so existence is
 * probed with `PRAGMA table_info` first. Called from {@link runMigrations}
 * before the canonical `CREATE TABLE IF NOT EXISTS` block, which means:
 * - a fresh database never reaches an ALTER (the table does not exist yet and
 *   is created with every column by the block below), and
 * - a database created by an older schema version is upgraded in place.
 */
function addColumnIfMissing(
  db: SQLiteDatabase,
  table: string,
  column: string,
  declaration: string
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.length === 0) {
    return; // table does not exist yet; created further down
  }
  if (columns.some((existing) => existing.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

/**
 * Issue #1059: `dispatch_attempts` started life (on the in-flight feature
 * branch) as a five-column queue with no dedup key and no failure counters.
 * Backfill those columns so the at-least-once guarantees — the `dedup_key`
 * UNIQUE index, the `attempts`/`last_error` observability and `delivered_at` —
 * apply to databases that already exist, without a destructive rebuild.
 *
 * The added columns are nullable-with-defaults rather than `NOT NULL` because
 * legacy rows cannot be given a meaningful dedup key after the fact; new rows
 * always write one, and the UNIQUE index treats the legacy NULLs as distinct.
 */
function upgradeDispatchAttemptsTable(db: SQLiteDatabase): void {
  addColumnIfMissing(db, 'dispatch_attempts', 'dedup_key', 'TEXT');
  addColumnIfMissing(db, 'dispatch_attempts', 'invoice_id', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'dispatch_attempts', 'trigger', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'dispatch_attempts', 'recipient_address', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'dispatch_attempts', 'channel', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'dispatch_attempts', 'destination', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'dispatch_attempts', 'event_id', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'dispatch_attempts', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'dispatch_attempts', 'last_error', 'TEXT');
  addColumnIfMissing(db, 'dispatch_attempts', 'updated_at', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'dispatch_attempts', 'delivered_at', 'INTEGER');
}

function runMigrations(db: SQLiteDatabase): void {
  upgradeDispatchAttemptsTable(db);

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

    CREATE TABLE IF NOT EXISTS subscriptions (
      id              INTEGER PRIMARY KEY,
      stellar_address TEXT    NOT NULL,
      channel         TEXT    NOT NULL CHECK (channel IN ('email', 'webhook', 'sms')),
      destination     TEXT    NOT NULL,
      triggers        TEXT    NOT NULL,
      webhook_secret  TEXT,
      created_at      INTEGER NOT NULL
    );

    -- Issue #1059 at-least-once dispatch journal. One row per delivery intent,
    -- written durably BEFORE the provider is contacted. dedup_key is the natural
    -- identity of a notification (invoice + trigger + recipient + channel +
    -- destination + event) and is enforced by the UNIQUE index below, so a
    -- retried or duplicated enqueue collapses onto the existing row instead of
    -- creating a second dispatch. Rows are never deleted on success: status
    -- moves pending -> delivered, attempts/last_error record what the row cost,
    -- and a row still pending is work the poller flush retries.
    -- event_id uses '' (not NULL) when the notification is not tied to a chain
    -- event, because NULL never collides in a SQLite UNIQUE index and would
    -- silently disable dedup for scheduled triggers.
    CREATE TABLE IF NOT EXISTS dispatch_attempts (
      id                TEXT    PRIMARY KEY,
      dedup_key         TEXT    NOT NULL,
      invoice_id        INTEGER NOT NULL,
      trigger           TEXT    NOT NULL,
      recipient_address TEXT    NOT NULL,
      channel           TEXT    NOT NULL,
      destination       TEXT    NOT NULL,
      event_id          TEXT    NOT NULL DEFAULT '',
      subscription      TEXT    NOT NULL,
      payload           TEXT    NOT NULL,
      status            TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'delivered', 'failed')),
      attempts          INTEGER NOT NULL DEFAULT 0,
      last_error        TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL DEFAULT 0,
      delivered_at      INTEGER
    );

    CREATE TABLE IF NOT EXISTS sent_notifications (
      id                INTEGER PRIMARY KEY,
      invoice_id        INTEGER NOT NULL,
      trigger           TEXT    NOT NULL,
      recipient_address TEXT    NOT NULL,
      channel           TEXT    NOT NULL,
      destination       TEXT    NOT NULL,
      event_id          TEXT,
      sent_at           INTEGER NOT NULL,
      UNIQUE (invoice_id, trigger, recipient_address, channel, destination)
    );

    CREATE TABLE IF NOT EXISTS webhook_delivery_logs (
      id               INTEGER PRIMARY KEY,
      subscription_id  INTEGER NOT NULL,
      event_id         TEXT,
      trigger          TEXT    NOT NULL,
      invoice_id       INTEGER NOT NULL,
      recipient_address TEXT   NOT NULL,
      status           TEXT    NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
      attempts         INTEGER NOT NULL,
      response_status  INTEGER,
      error            TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      FOREIGN KEY(subscription_id) REFERENCES subscriptions(id)
    );

    -- Durable, queryable delivery-confirmation audit log. Independent of
    -- transient dispatch-retry state (webhook_delivery_logs) and dedup table
    -- (sent_notifications). One row per confirmed delivery outcome, whether
    -- delivered or permanently failed, with attempt timestamps and final status.
    CREATE TABLE IF NOT EXISTS delivery_audit_log (
      id                 INTEGER PRIMARY KEY,
      invoice_id         INTEGER NOT NULL,
      trigger            TEXT    NOT NULL,
      recipient_address  TEXT    NOT NULL,
      channel            TEXT    NOT NULL CHECK (channel IN ('email', 'webhook', 'sms', 'websocket')),
      destination        TEXT    NOT NULL,
      event_id           TEXT,
      status             TEXT    NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
      attempts           INTEGER NOT NULL,
      last_error         TEXT,
      attempt_timestamps TEXT    NOT NULL,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_invoices_status     ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoices_freelancer ON invoices(freelancer);
    CREATE INDEX IF NOT EXISTS idx_invoices_payer      ON invoices(payer);
    CREATE INDEX IF NOT EXISTS idx_invoices_funder     ON invoices(funder);
    CREATE INDEX IF NOT EXISTS idx_events_invoice_id   ON events(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_address ON subscriptions(stellar_address);
    CREATE INDEX IF NOT EXISTS idx_sent_notifications_invoice ON sent_notifications(invoice_id);
    -- The dedup key is the whole at-least-once story: enqueue uses INSERT OR
    -- IGNORE, so a second enqueue of the same notification is a no-op rather
    -- than a second dispatch. Runs after upgradeDispatchAttemptsTable() has
    -- backfilled the column on pre-existing databases.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_attempts_dedup ON dispatch_attempts(dedup_key);
    -- The pending work queue is read on every poll; keep the scan cheap and
    -- deterministically ordered.
    CREATE INDEX IF NOT EXISTS idx_dispatch_attempts_pending ON dispatch_attempts(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_dispatch_attempts_invoice ON dispatch_attempts(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_audit_recipient     ON delivery_audit_log(recipient_address);
    CREATE INDEX IF NOT EXISTS idx_audit_event         ON delivery_audit_log(event_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created       ON delivery_audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_trigger       ON delivery_audit_log(trigger);
    CREATE INDEX IF NOT EXISTS idx_audit_channel       ON delivery_audit_log(channel);
    CREATE INDEX IF NOT EXISTS idx_audit_status        ON delivery_audit_log(status);

    -- Issue #741 compliance: ensure one-click unsubscribe tokens are
    -- single-use. The nonce is recorded here on successful verify; a
    -- replay attempts an INSERT OR IGNORE that returns changes = 0
    -- and is rejected with HTTP 409.
    CREATE TABLE IF NOT EXISTS redeemed_unsubscribe_tokens (
      nonce       TEXT    PRIMARY KEY,
      redeemed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS retention_deletion_audit (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      category      TEXT    NOT NULL,
      cutoff_at     INTEGER NOT NULL,
      eligible_rows INTEGER NOT NULL,
      deleted_rows  INTEGER NOT NULL,
      run_mode      TEXT    NOT NULL CHECK (run_mode IN ('dry-run', 'deleted', 'alerted')),
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_retention_deletion_audit_created
      ON retention_deletion_audit(created_at);

    CREATE TABLE IF NOT EXISTS erasure_request_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      operator_id TEXT NOT NULL,
      subscriptions INTEGER NOT NULL,
      dispatch_attempts INTEGER NOT NULL,
      sent_notifications INTEGER NOT NULL,
      webhook_logs INTEGER NOT NULL,
      anonymized_audit_rows INTEGER NOT NULL,
      completed_at INTEGER NOT NULL
    );
  `);
}

export function upsertInvoice(invoice: Omit<Invoice, 'created_at' | 'updated_at'>): void {
  const now = Date.now();
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
}

export function queryInvoicesByStatus(status: string): Invoice[] {
  return getDb()
    .prepare('SELECT * FROM invoices WHERE status = ? ORDER BY id ASC')
    .all(status) as Invoice[];
}

export function hasEvent(eventId: string): boolean {
  return getDb().prepare('SELECT 1 FROM events WHERE event_id = ?').get(eventId) !== undefined;
}

export function insertEvent(event: {
  event_id: string;
  event_type: ILNEventType;
  invoice_id: number;
  ledger: number;
  ledger_closed_at: string;
  created_at: number;
}): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO events
         (event_id, event_type, invoice_id, ledger, ledger_closed_at, created_at)
       VALUES
         (@event_id, @event_type, @invoice_id, @ledger, @ledger_closed_at, @created_at)`
    )
    .run(event);
}

export function getCursorLedger(): number {
  const row = getDb().prepare('SELECT last_ledger FROM cursor WHERE id = 1').get() as
    | { last_ledger: number }
    | undefined;
  return row?.last_ledger ?? 0;
}

export function setCursorLedger(ledger: number): void {
  getDb()
    .prepare(
      `INSERT INTO cursor (id, last_ledger, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_ledger = excluded.last_ledger,
         updated_at  = excluded.updated_at`
    )
    .run(ledger, Date.now());
}

export function createSubscription(
  subscription: Omit<Subscription, 'id' | 'created_at'>
): Subscription {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `INSERT INTO subscriptions
         (stellar_address, channel, destination, triggers, webhook_secret, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      subscription.stellar_address,
      subscription.channel,
      subscription.destination,
      JSON.stringify(subscription.triggers),
      subscription.webhook_secret ?? null,
      now
    );

  return {
    id: Number(result.lastInsertRowid),
    ...subscription,
    created_at: now,
  };
}

export function getSubscriptionsByAddress(address: string): Subscription[] {
  return getDb()
    .prepare('SELECT * FROM subscriptions WHERE stellar_address = ? ORDER BY id ASC')
    .all(address)
    .map((row: any) => ({
      id: row.id,
      stellar_address: row.stellar_address,
      channel: row.channel,
      destination: row.destination,
      triggers: JSON.parse(row.triggers),
      webhook_secret: row.webhook_secret ?? undefined,
      created_at: row.created_at,
    })) as Subscription[];
}

export function getSubscriptionById(id: number): Subscription | undefined {
  const row = getDb().prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as any;

  if (!row) {
    return undefined;
  }

  return {
    id: row.id,
    stellar_address: row.stellar_address,
    channel: row.channel,
    destination: row.destination,
    triggers: JSON.parse(row.triggers),
    webhook_secret: row.webhook_secret ?? undefined,
    created_at: row.created_at,
  } as Subscription;
}

export function deleteSubscriptionById(id: number): boolean {
  return deleteSubscriptions([id]);
}

export function deleteSubscriptionByAddressAndDestination(
  address: string,
  destination: string
): boolean {
  const ids = getDb()
    .prepare('SELECT id FROM subscriptions WHERE stellar_address = ? AND destination = ?')
    .all(address, destination) as { id: number }[];
  return deleteSubscriptions(ids.map(({ id }) => id));
}

export interface ErasureResult {
  subscriptions: number;
  dispatchAttempts: number;
  sentNotifications: number;
  webhookLogs: number;
  anonymizedAuditRows: number;
}

/**
 * Remove address-linked notification data. Delivery audit rows are retained
 * for the configured investigation window but stripped of direct identifiers.
 */
export function eraseNotificationDataForAddress(
  address: string,
  requestId: string,
  operatorId: string
): ErasureResult {
  const db = getDb();
  return db.transaction(() => {
    const destinations = db
      .prepare('SELECT destination FROM subscriptions WHERE stellar_address = ?')
      .all(address) as { destination: string }[];
    const destinationValues = destinations.map(({ destination }) => destination);
    const subs = db
      .prepare('SELECT id FROM subscriptions WHERE stellar_address = ?')
      .all(address) as { id: number }[];
    const subIds = subs.map(({ id }) => id);

    let webhookLogs = 0;
    if (subIds.length) {
      const marks = subIds.map(() => '?').join(', ');
      webhookLogs = db
        .prepare(`DELETE FROM webhook_delivery_logs WHERE subscription_id IN (${marks})`)
        .run(...subIds).changes;
      db.prepare(`DELETE FROM subscriptions WHERE id IN (${marks})`).run(...subIds);
    }

    let dispatchAttempts = db
      .prepare('DELETE FROM dispatch_attempts WHERE recipient_address = ?')
      .run(address).changes;
    let sentNotifications = db
      .prepare('DELETE FROM sent_notifications WHERE recipient_address = ?')
      .run(address).changes;
    if (destinationValues.length) {
      const marks = destinationValues.map(() => '?').join(', ');
      dispatchAttempts += db
        .prepare(`DELETE FROM dispatch_attempts WHERE destination IN (${marks})`)
        .run(...destinationValues).changes;
      sentNotifications += db
        .prepare(`DELETE FROM sent_notifications WHERE destination IN (${marks})`)
        .run(...destinationValues).changes;
    }

    const anonymizedAuditRows = db
      .prepare(`UPDATE delivery_audit_log
        SET recipient_address = '', destination = '', last_error = NULL
        WHERE recipient_address = ?`)
      .run(address).changes;

    const result = {
      subscriptions: subIds.length,
      dispatchAttempts,
      sentNotifications,
      webhookLogs,
      anonymizedAuditRows,
    };
    db.prepare(`INSERT INTO erasure_request_audit
      (request_id, operator_id, subscriptions, dispatch_attempts, sent_notifications,
       webhook_logs, anonymized_audit_rows, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(requestId, operatorId, result.subscriptions, result.dispatchAttempts,
        result.sentNotifications, result.webhookLogs, result.anonymizedAuditRows, Date.now());
    return result;
  })();
}

function deleteSubscriptions(ids: number[]): boolean {
  if (ids.length === 0) return false;
  const db = getDb();
  return db.transaction(() => {
    for (const id of ids) {
      db.prepare('DELETE FROM webhook_delivery_logs WHERE subscription_id = ?').run(id);
      db.prepare("DELETE FROM dispatch_attempts WHERE json_extract(subscription, '$.id') = ?").run(id);
    }
    const placeholders = ids.map(() => '?').join(', ');
    const result = db.prepare(`DELETE FROM subscriptions WHERE id IN (${placeholders})`).run(...ids);
    return result.changes > 0;
  })();
}

export function createWebhookDeliveryLog(log: {
  subscription_id: number;
  event_id: string | null;
  trigger: NotificationTrigger;
  invoice_id: number;
  recipient_address: string;
  status: 'pending' | 'success' | 'failed';
  attempts: number;
  response_status: number | null;
  error: string | null;
}): WebhookDeliveryLog {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `INSERT INTO webhook_delivery_logs
         (subscription_id, event_id, trigger, invoice_id, recipient_address,
          status, attempts, response_status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      log.subscription_id,
      log.event_id,
      log.trigger,
      log.invoice_id,
      log.recipient_address,
      log.status,
      log.attempts,
      log.response_status,
      log.error,
      now,
      now
    );

  return {
    id: Number(result.lastInsertRowid),
    ...log,
    created_at: now,
    updated_at: now,
  };
}

export function updateWebhookDeliveryLog(
  id: number,
  updates: Partial<Pick<WebhookDeliveryLog, 'status' | 'attempts' | 'response_status' | 'error'>>
): void {
  const fields: string[] = [];
  const params: any[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    params.push(updates.status);
  }
  if (updates.attempts !== undefined) {
    fields.push('attempts = ?');
    params.push(updates.attempts);
  }
  if (updates.response_status !== undefined) {
    fields.push('response_status = ?');
    params.push(updates.response_status);
  }
  if (updates.error !== undefined) {
    fields.push('error = ?');
    params.push(updates.error);
  }

  if (fields.length === 0) {
    return;
  }

  fields.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);

  getDb()
    .prepare(`UPDATE webhook_delivery_logs SET ${fields.join(', ')} WHERE id = ?`)
    .run(...params);
}

export function getWebhookDeliveryLogs(subscriptionId: number): WebhookDeliveryLog[] {
  return getDb()
    .prepare(
      'SELECT * FROM webhook_delivery_logs WHERE subscription_id = ? ORDER BY created_at DESC'
    )
    .all(subscriptionId)
    .map((row: any) => ({
      id: row.id,
      subscription_id: row.subscription_id,
      event_id: row.event_id,
      trigger: row.trigger,
      invoice_id: row.invoice_id,
      recipient_address: row.recipient_address,
      status: row.status,
      attempts: row.attempts,
      response_status: row.response_status,
      error: row.error,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })) as WebhookDeliveryLog[];
}

export function hasSentNotification(
  invoiceId: number,
  trigger: NotificationTrigger,
  recipientAddress: string,
  channel: SubscriptionChannel,
  destination: string
): boolean {
  return (
    getDb()
      .prepare(
        `SELECT 1 FROM sent_notifications
         WHERE invoice_id = ?
           AND trigger = ?
           AND recipient_address = ?
           AND channel = ?
           AND destination = ?`
      )
      .get(invoiceId, trigger, recipientAddress, channel, destination) !== undefined
  );
}

export function logSentNotification(
  invoiceId: number,
  trigger: NotificationTrigger,
  recipientAddress: string,
  channel: SubscriptionChannel,
  destination: string,
  eventId?: string
): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO sent_notifications
         (invoice_id, trigger, recipient_address, channel, destination, event_id, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(invoiceId, trigger, recipientAddress, channel, destination, eventId ?? null, Date.now());
}

export interface DeliveryAnalytics {
  total: number;
  byChannel: Record<string, number>;
  byTrigger: Record<string, number>;
}

export function getDeliveryAnalytics(): DeliveryAnalytics {
  const { count: total } = getDb()
    .prepare('SELECT COUNT(*) as count FROM sent_notifications')
    .get() as { count: number };

  const channelRows = getDb()
    .prepare('SELECT channel, COUNT(*) as count FROM sent_notifications GROUP BY channel')
    .all() as { channel: string; count: number }[];

  const triggerRows = getDb()
    .prepare('SELECT trigger, COUNT(*) as count FROM sent_notifications GROUP BY trigger')
    .all() as { trigger: string; count: number }[];

  const byChannel: Record<string, number> = {};
  for (const row of channelRows) byChannel[row.channel] = row.count;

  const byTrigger: Record<string, number> = {};
  for (const row of triggerRows) byTrigger[row.trigger] = row.count;

  return { total, byChannel, byTrigger };
}

export interface ChannelComparisonRow {
  channel: string;
  sent: number;
  failed: number;
  successRate: number;
}

export function getChannelComparison(): ChannelComparisonRow[] {
  const sentRows = getDb()
    .prepare('SELECT channel, COUNT(*) as sent FROM sent_notifications GROUP BY channel')
    .all() as { channel: string; sent: number }[];

  const { count: failedWebhook } = getDb()
    .prepare("SELECT COUNT(*) as count FROM webhook_delivery_logs WHERE status = 'failed'")
    .get() as { count: number };

  return sentRows.map((row) => {
    const failed = row.channel === 'webhook' ? failedWebhook : 0;
    const successRate = row.sent > 0 ? (row.sent - failed) / row.sent : 1;
    return { channel: row.channel, sent: row.sent, failed, successRate };
  });
}

export interface TrendRow {
  date: string;
  count: number;
}

export function getTrendAnalytics(days: number): TrendRow[] {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  return getDb()
    .prepare(
      `SELECT date(sent_at / 1000, 'unixepoch') as date, COUNT(*) as count
        FROM sent_notifications
        WHERE sent_at >= ?
        GROUP BY date
        ORDER BY date ASC`
    )
    .all(cutoffMs) as TrendRow[];
}

// ─── Delivery audit log (durable, queryable, independent of retry state) ─────

export interface DeliveryAuditRecord {
  id: number;
  invoice_id: number;
  trigger: NotificationTrigger;
  recipient_address: string;
  channel: SubscriptionChannel;
  destination: string;
  event_id: string | null;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  last_error: string | null;
  attempt_timestamps: number[]; // decoded from JSON
  created_at: number;
  updated_at: number;
}

export interface DeliveryAuditFilter {
  recipient?: string;
  eventId?: string;
  trigger?: string;
  channel?: string;
  status?: 'pending' | 'delivered' | 'failed';
  startTime?: number; // ms epoch inclusive
  endTime?: number; // ms epoch inclusive
  limit?: number;
  offset?: number;
}

export function createDeliveryAuditLog(entry: {
  invoice_id: number;
  trigger: NotificationTrigger;
  recipient_address: string;
  channel: SubscriptionChannel;
  destination: string;
  event_id?: string | null;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  last_error?: string | null;
  attempt_timestamps: number[];
}): DeliveryAuditRecord {
  const now = Date.now();
  const result = getDb()
    .prepare(
      `INSERT INTO delivery_audit_log
        (invoice_id, trigger, recipient_address, channel, destination, event_id, status, attempts, last_error, attempt_timestamps, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.invoice_id,
      entry.trigger,
      entry.recipient_address,
      entry.channel,
      entry.destination,
      entry.event_id ?? null,
      entry.status,
      entry.attempts,
      entry.last_error ?? null,
      JSON.stringify(entry.attempt_timestamps),
      now,
      now
    );

  return {
    id: Number(result.lastInsertRowid),
    invoice_id: entry.invoice_id,
    trigger: entry.trigger,
    recipient_address: entry.recipient_address,
    channel: entry.channel,
    destination: entry.destination,
    event_id: entry.event_id ?? null,
    status: entry.status,
    attempts: entry.attempts,
    last_error: entry.last_error ?? null,
    attempt_timestamps: entry.attempt_timestamps,
    created_at: now,
    updated_at: now,
  };
}

export function updateDeliveryAuditLog(
  id: number,
  updates: Partial<Pick<DeliveryAuditRecord, 'status' | 'attempts' | 'last_error' | 'attempt_timestamps'>>
): void {
  const fields: string[] = [];
  const params: any[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    params.push(updates.status);
  }
  if (updates.attempts !== undefined) {
    fields.push('attempts = ?');
    params.push(updates.attempts);
  }
  if (updates.last_error !== undefined) {
    fields.push('last_error = ?');
    params.push(updates.last_error);
  }
  if (updates.attempt_timestamps !== undefined) {
    fields.push('attempt_timestamps = ?');
    params.push(JSON.stringify(updates.attempt_timestamps));
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);

  getDb()
    .prepare(`UPDATE delivery_audit_log SET ${fields.join(', ')} WHERE id = ?`)
    .run(...params);
}

export function getDeliveryAuditLogs(filter: DeliveryAuditFilter = {}): DeliveryAuditRecord[] {
  const clauses: string[] = [];
  const params: any[] = [];

  if (filter.recipient) {
    clauses.push('recipient_address = ?');
    params.push(filter.recipient);
  }
  if (filter.eventId) {
    clauses.push('event_id = ?');
    params.push(filter.eventId);
  }
  if (filter.trigger) {
    clauses.push('trigger = ?');
    params.push(filter.trigger);
  }
  if (filter.channel) {
    clauses.push('channel = ?');
    params.push(filter.channel);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.startTime !== undefined) {
    clauses.push('created_at >= ?');
    params.push(filter.startTime);
  }
  if (filter.endTime !== undefined) {
    clauses.push('created_at <= ?');
    params.push(filter.endTime);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filter.limit !== undefined ? Math.min(Math.max(filter.limit, 1), 1000) : 100;
  const offset = filter.offset ?? 0;

  const rows = getDb()
    .prepare(
      `SELECT * FROM delivery_audit_log
       ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as any[];

  return rows.map((row) => ({
    id: row.id,
    invoice_id: row.invoice_id,
    trigger: row.trigger,
    recipient_address: row.recipient_address,
    channel: row.channel,
    destination: row.destination,
    event_id: row.event_id,
    status: row.status,
    attempts: row.attempts,
    last_error: row.last_error,
    attempt_timestamps: JSON.parse(row.attempt_timestamps),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export function getDeliveryAuditLogById(id: number): DeliveryAuditRecord | undefined {
  const row = getDb().prepare('SELECT * FROM delivery_audit_log WHERE id = ?').get(id) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    invoice_id: row.invoice_id,
    trigger: row.trigger,
    recipient_address: row.recipient_address,
    channel: row.channel,
    destination: row.destination,
    event_id: row.event_id,
    status: row.status,
    attempts: row.attempts,
    last_error: row.last_error,
    attempt_timestamps: JSON.parse(row.attempt_timestamps),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function countDeliveryAuditLogs(filter: DeliveryAuditFilter = {}): number {
  const clauses: string[] = [];
  const params: any[] = [];

  if (filter.recipient) {
    clauses.push('recipient_address = ?');
    params.push(filter.recipient);
  }
  if (filter.eventId) {
    clauses.push('event_id = ?');
    params.push(filter.eventId);
  }
  if (filter.trigger) {
    clauses.push('trigger = ?');
    params.push(filter.trigger);
  }
  if (filter.channel) {
    clauses.push('channel = ?');
    params.push(filter.channel);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.startTime !== undefined) {
    clauses.push('created_at >= ?');
    params.push(filter.startTime);
  }
  if (filter.endTime !== undefined) {
    clauses.push('created_at <= ?');
    params.push(filter.endTime);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const row = getDb()
    .prepare(`SELECT COUNT(*) as count FROM delivery_audit_log ${where}`)
    .get(...params) as { count: number };
  return row.count;
}

// ─── Dispatch attempts (issue #1059: at-least-once delivery journal) ─────────

/** Lifecycle of a durable delivery intent. Only `pending` rows are work. */
export type DispatchAttemptStatus = 'pending' | 'delivered' | 'failed';

/**
 * The subscription shape the processor and delivery layer actually pass around
 * at runtime — the `subscriptions` DB row (`stellar_address`, `destination`,
 * `triggers`, `webhook_secret`) rather than the service-layer projection
 * declared in `src/types.ts`. The extra fields are optional so a plain
 * `Subscription` stays assignable; {@link dispatchDestinationOf} resolves the
 * destination whichever shape the caller had.
 */
export interface DispatchAttemptSubscription extends Omit<Subscription, 'id'> {
  id?: string | number;
  stellar_address?: string;
  destination?: string;
  triggers?: string[];
  webhook_secret?: string;
  created_at?: number;
}

/** A fully-typed, deserialised `dispatch_attempts` row. */
export interface DispatchAttempt {
  id: string;
  dedup_key: string;
  invoice_id: number;
  trigger: NotificationTrigger;
  recipient_address: string;
  channel: SubscriptionChannel;
  destination: string;
  /** `null` when the notification is not tied to a chain event. */
  event_id: string | null;
  status: DispatchAttemptStatus;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
  /** Deserialised straight back into what `deliverNotification` expects. */
  subscription: Subscription;
  payload: NotificationPayload;
}

export interface EnqueuedDispatchAttempt {
  id: string;
  dedup_key: string;
  status: DispatchAttemptStatus;
  /** True when a row for this notification identity already existed. */
  deduplicated: boolean;
  /** True when that existing row was already delivered — there is nothing to send. */
  alreadyDelivered: boolean;
}

/**
 * The destination a delivery would physically use, in the same precedence the
 * delivery layer does: the persisted row's `destination`, falling back to the
 * service-layer fields. Exported so the flush records the exact tuple the send
 * used — the dedup key must not depend on guesswork.
 */
export function dispatchDestinationOf(subscription: DispatchAttemptSubscription): string {
  return subscription.destination ?? subscription.webhookUrl ?? subscription.email ?? '';
}

/**
 * The natural identity of a notification: invoice + trigger + recipient +
 * channel + destination + event. Serialised as a fixed-order JSON array so the
 * fields cannot alias each other (a `|` inside a destination would collide two
 * different tuples otherwise), and so scheduled notifications (no event id)
 * still produce a stable key.
 */
export function dispatchDedupKey(input: {
  invoiceId: number;
  trigger: NotificationTrigger;
  recipientAddress: string;
  channel: SubscriptionChannel;
  destination: string;
  eventId?: string | null;
}): string {
  return JSON.stringify([
    input.invoiceId,
    input.trigger,
    input.recipientAddress,
    input.channel,
    input.destination,
    input.eventId ?? '',
  ]);
}

function dispatchAttemptId(dedupKey: string): string {
  return createHash('sha256').update(dedupKey).digest('hex');
}

/**
 * Durably record the intent to deliver, BEFORE any provider is contacted
 * (issue #1059). Idempotent by construction: `INSERT OR IGNORE` against the
 * `dedup_key` UNIQUE index, so re-enqueueing the same notification — a retried
 * poll, a duplicate event, a restart replaying its cursor — never creates a
 * second dispatch and never throws.
 *
 * The caller uses the result to decide whether to attempt delivery now: only a
 * `pending` row is work.
 */
export function enqueueDispatchAttempt(
  subscription: DispatchAttemptSubscription,
  payload: NotificationPayload
): EnqueuedDispatchAttempt {
  const destination = dispatchDestinationOf(subscription);
  const dedupKey = dispatchDedupKey({
    invoiceId: payload.invoice.id,
    trigger: payload.trigger,
    recipientAddress: payload.recipientAddress,
    channel: subscription.channel,
    destination,
    eventId: payload.eventId,
  });
  const id = dispatchAttemptId(dedupKey);
  const db = getDb();

  const result = db
    .prepare(
      `INSERT OR IGNORE INTO dispatch_attempts
         (id, dedup_key, invoice_id, trigger, recipient_address, channel, destination,
          event_id, subscription, payload, status, attempts, last_error,
          created_at, updated_at, delivered_at)
       VALUES
         (@id, @dedup_key, @invoice_id, @trigger, @recipient_address, @channel, @destination,
          @event_id, @subscription, @payload, 'pending', 0, NULL,
          @created_at, @created_at, NULL)`
    )
    .run({
      id,
      dedup_key: dedupKey,
      invoice_id: payload.invoice.id,
      trigger: payload.trigger,
      recipient_address: payload.recipientAddress,
      channel: subscription.channel,
      destination,
      event_id: payload.eventId ?? '',
      subscription: JSON.stringify(subscription),
      payload: JSON.stringify(payload),
      created_at: Date.now(),
    });

  if (result.changes === 0) {
    const existing = db
      .prepare('SELECT status FROM dispatch_attempts WHERE id = ?')
      .get(id) as { status: DispatchAttemptStatus } | undefined;
    const status = existing?.status ?? 'pending';
    return {
      id,
      dedup_key: dedupKey,
      status,
      deduplicated: true,
      alreadyDelivered: status === 'delivered',
    };
  }

  return { id, dedup_key: dedupKey, status: 'pending', deduplicated: false, alreadyDelivered: false };
}

function rowToDispatchAttempt(row: {
  id: string;
  dedup_key: string | null;
  invoice_id: number;
  trigger: string;
  recipient_address: string;
  channel: string;
  destination: string;
  event_id: string;
  subscription: string;
  payload: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
}): DispatchAttempt | undefined {
  try {
    return {
      id: row.id,
      dedup_key: row.dedup_key ?? '',
      invoice_id: row.invoice_id,
      trigger: row.trigger as NotificationTrigger,
      recipient_address: row.recipient_address,
      channel: row.channel as SubscriptionChannel,
      destination: row.destination,
      event_id: row.event_id === '' ? null : row.event_id,
      status: row.status as DispatchAttemptStatus,
      attempts: row.attempts,
      last_error: row.last_error,
      created_at: row.created_at,
      updated_at: row.updated_at,
      delivered_at: row.delivered_at,
      subscription: JSON.parse(row.subscription) as Subscription,
      payload: JSON.parse(row.payload) as NotificationPayload,
    };
  } catch (error: any) {
    // A row whose intent cannot be reconstructed stays pending and carries the
    // reason, so it is visible to operators instead of vanishing from the queue.
    recordDispatchAttemptFailure(row.id, `Unreadable dispatch attempt: ${error?.message ?? error}`);
    return undefined;
  }
}

/**
 * The durable work queue: dispatch intents that were written but never confirmed
 * delivered — including anything left over by a crash mid-dispatch. Ordered by
 * arrival so a restart resumes in the original send order; `id` breaks ties
 * deterministically because several rows can share a `created_at` millisecond.
 */
export function getPendingDispatchAttempts(limit = 500): DispatchAttempt[] {
  const rows: any[] = getDb()
    .prepare(
      `SELECT * FROM dispatch_attempts
       WHERE status = 'pending'
       ORDER BY created_at ASC, id ASC
       LIMIT ?`
    )
    .all(Math.max(1, Math.min(limit, 5000)));

  return rows
    .map((row) => rowToDispatchAttempt(row))
    .filter((attempt): attempt is DispatchAttempt => attempt !== undefined);
}

/**
 * Confirm the attempt reached its destination. The row is closed out, not
 * deleted: the dispatch history and its `attempts` count stay queryable, and the
 * `status <> 'delivered'` guard makes this the single winner if two flushes race
 * (the loser gets `false` and must not log the notification as sent again).
 */
export function markDispatchAttemptDelivered(
  id: string,
  deliveredAt: number = Date.now()
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE dispatch_attempts
         SET status = 'delivered',
             delivered_at = ?,
             updated_at = ?,
             attempts = attempts + 1,
             last_error = NULL
       WHERE id = ? AND status <> 'delivered'`
    )
    .run(deliveredAt, deliveredAt, id);
  return result.changes > 0;
}

/**
 * Record a failed provider call. The row stays `pending` so a later flush retries
 * it — that is what makes the guarantee at-least-once rather than at-most-once —
 * while `attempts` and `last_error` make repeated failures observable.
 */
export function recordDispatchAttemptFailure(id: string, error: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE dispatch_attempts
         SET status = 'pending',
             attempts = attempts + 1,
             last_error = ?,
             updated_at = ?
       WHERE id = ?`
    )
    .run(error, now, id);
}

/**
 * Retention enforcement consistent with docs/privacy.md:
 * - sent_notifications: 30 days (from sent_at)
 * - webhook_delivery_logs: 90 days (from created_at)
 * - delivery_audit_log: 90 days (from created_at) — matches webhook logs as the
 *   durable counterpart independent of retry state.
 * - dispatch_attempts: 90 days for TERMINAL rows only. A `pending`
 *   row is undelivered work, so purging it would silently drop the
 *   notification and break the at-least-once guarantee (issue #1059).
 * - redeemed_unsubscribe_tokens: 90 days from redemption.
 *
 * Each category's eligibility and deletion count is recorded without storing
 * recipient data, so the purge itself remains auditable.
 */
export function purgeExpiredDeliveryLogs(
  nowMs: number = Date.now(),
  options: { dryRun?: boolean; maxRows?: number } = {}
): {
  sentNotifications: number;
  webhookLogs: number;
  auditLogs: number;
  dispatchAttempts: number;
  redeemedTokens: number;
  totalEligible: number;
  dryRun: boolean;
  alertThresholdExceeded: boolean;
} {
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

  const sentCutoff = nowMs - thirtyDaysMs;
  const longCutoff = nowMs - ninetyDaysMs;
  const dryRun = options.dryRun ?? false;
  const db = getDb();

  return db.transaction(() => {
    const categories = [
      {
        name: 'sent_notifications',
        cutoff: sentCutoff,
        countSql: 'SELECT COUNT(*) AS count FROM sent_notifications WHERE sent_at < ?',
        deleteSql: 'DELETE FROM sent_notifications WHERE sent_at < ?',
      },
      {
        name: 'webhook_delivery_logs',
        cutoff: longCutoff,
        countSql: 'SELECT COUNT(*) AS count FROM webhook_delivery_logs WHERE created_at < ?',
        deleteSql: 'DELETE FROM webhook_delivery_logs WHERE created_at < ?',
      },
      {
        name: 'delivery_audit_log',
        cutoff: longCutoff,
        countSql: 'SELECT COUNT(*) AS count FROM delivery_audit_log WHERE created_at < ?',
        deleteSql: 'DELETE FROM delivery_audit_log WHERE created_at < ?',
      },
      {
        name: 'dispatch_attempts',
        cutoff: longCutoff,
        countSql: "SELECT COUNT(*) AS count FROM dispatch_attempts WHERE status IN ('delivered', 'failed') AND created_at < ?",
        deleteSql: "DELETE FROM dispatch_attempts WHERE status IN ('delivered', 'failed') AND created_at < ?",
      },
      {
        name: 'redeemed_unsubscribe_tokens',
        cutoff: longCutoff,
        countSql: 'SELECT COUNT(*) AS count FROM redeemed_unsubscribe_tokens WHERE redeemed_at < ?',
        deleteSql: 'DELETE FROM redeemed_unsubscribe_tokens WHERE redeemed_at < ?',
      },
    ];
    const eligible = categories.map((category) => ({
      ...category,
      count: (db.prepare(category.countSql).get(category.cutoff) as { count: number }).count,
    }));
    const totalEligible = eligible.reduce((sum, category) => sum + category.count, 0);
    const alertThresholdExceeded =
      options.maxRows !== undefined && totalEligible > options.maxRows;
    const shouldDelete = !dryRun && !alertThresholdExceeded;
    const deleted: Record<string, number> = {};

    for (const category of eligible) {
      const deletedRows = shouldDelete
        ? db.prepare(category.deleteSql).run(category.cutoff).changes
        : 0;
      deleted[category.name] = deletedRows;
      db.prepare(
        `INSERT INTO retention_deletion_audit
          (category, cutoff_at, eligible_rows, deleted_rows, run_mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        category.name,
        category.cutoff,
        category.count,
        deletedRows,
        alertThresholdExceeded ? 'alerted' : shouldDelete ? 'deleted' : 'dry-run',
        nowMs
      );
    }

    return {
      sentNotifications: deleted.sent_notifications,
      webhookLogs: deleted.webhook_delivery_logs,
      auditLogs: deleted.delivery_audit_log,
      dispatchAttempts: deleted.dispatch_attempts,
      redeemedTokens: deleted.redeemed_unsubscribe_tokens,
      totalEligible,
      dryRun: dryRun || alertThresholdExceeded,
      alertThresholdExceeded,
    };
  })();
}
