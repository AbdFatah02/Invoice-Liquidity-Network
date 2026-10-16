#!/usr/bin/env tsx
/**
 * Audit log query CLI — internal tool for support/compliance investigations.
 * Query the durable delivery-confirmation audit log by recipient, event, or time range.
 *
 * Usage:
 *   tsx src/audit-cli.ts --recipient GABC --limit 20
 *   tsx src/audit-cli.ts --event evt-123 --start 2026-01-01 --end 2026-01-31
 *   tsx src/audit-cli.ts --channel email --status failed
 *
 * Or via the API:
 *   curl "http://localhost:4001/audit/deliveries?recipient=GABC&start=2026-01-01T00:00:00Z"
 */

import {
  createDb,
  setDb,
  getDeliveryAuditLogs,
  countDeliveryAuditLogs,
  purgeExpiredDeliveryLogs,
  verifyComplianceAuditChain,
} from './db';

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=')[1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

async function main() {
  // Use persistent DB by default; for CLI, allow override via env
  const dbPath = process.env.NOTIFICATIONS_DB_PATH ?? 'notifications.sqlite';
  try {
    setDb(createDb(dbPath));
  } catch (e) {
    console.error('Failed to open DB at', dbPath, e);
    process.exit(1);
  }

  if (hasFlag('verify-integrity')) {
    const result = verifyComplianceAuditChain();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.valid ? 0 : 2);
  }

  if (hasFlag('purge')) {
    const maxRowsArg = getArg('max-rows');
    const maxRows = maxRowsArg === undefined ? undefined : Number(maxRowsArg);
    if (maxRows !== undefined && (!Number.isInteger(maxRows) || maxRows < 0)) {
      console.error('--max-rows must be a non-negative integer');
      process.exit(1);
    }
    const result = purgeExpiredDeliveryLogs(Date.now(), {
      dryRun: hasFlag('dry-run'),
      maxRows,
    });
    console.log('Retention sweep:', result);
    console.log('Per-category outcome recorded in retention_deletion_audit.');
    return;
  }

  if (hasFlag('help') || args.length === 0) {
    console.log(`
Audit CLI — query delivery-confirmation audit log
Options:
  --recipient <addr>   Filter by recipient Stellar address
  --event <id>         Filter by eventId
  --trigger <name>     Filter by trigger (invoice_funded, invoice_paid, invoice_defaulted, invoice_due_soon, invoice_overdue)
  --channel <name>     Filter by channel (email, webhook, sms, websocket)
  --status <name>      Filter by status (pending, delivered, failed)
  --start <ISO>        Start time (inclusive, ISO 8601)
  --end <ISO>          End time (inclusive, ISO 8601)
  --limit <n>          Limit (default 100, max 1000)
  --offset <n>         Offset (default 0)
  --purge              Run expired-record retention sweep and exit
  --dry-run            With --purge, preview eligible records without deleting
  --max-rows <n>       With --purge, alert and skip if eligible rows exceed n
  --help               Show this help

Examples:
  tsx src/audit-cli.ts --recipient GABC --limit 20
  tsx src/audit-cli.ts --event evt-123
  tsx src/audit-cli.ts --start 2026-01-15T00:00:00Z --end 2026-01-16T00:00:00Z
    `);
    return;
  }

  const filter: any = {};
  const recipient = getArg('recipient');
  const eventId = getArg('event');
  const trigger = getArg('trigger');
  const channel = getArg('channel');
  const status = getArg('status');
  const start = getArg('start');
  const end = getArg('end');
  const limit = getArg('limit');
  const offset = getArg('offset');

  if (recipient) filter.recipient = recipient;
  if (eventId) filter.eventId = eventId;
  if (trigger) filter.trigger = trigger;
  if (channel) filter.channel = channel;
  if (status) {
    if (!['pending', 'delivered', 'failed'].includes(status)) {
      console.error('status must be pending, delivered, or failed');
      process.exit(1);
    }
    filter.status = status;
  }
  if (start) {
    const ms = Date.parse(start);
    if (Number.isNaN(ms)) {
      console.error('start must be ISO 8601');
      process.exit(1);
    }
    filter.startTime = ms;
  }
  if (end) {
    const ms = Date.parse(end);
    if (Number.isNaN(ms)) {
      console.error('end must be ISO 8601');
      process.exit(1);
    }
    filter.endTime = ms;
  }
  if (limit) filter.limit = parseInt(limit, 10);
  if (offset) filter.offset = parseInt(offset, 10);

  const records = getDeliveryAuditLogs(filter);
  const total = countDeliveryAuditLogs(filter);

  console.log(
    `\n=== Delivery Audit Log — ${total} total matching records (showing ${records.length}) ===\n`
  );
  if (records.length === 0) {
    console.log('No records found for filter:', JSON.stringify(filter, null, 2));
    return;
  }

  console.table(
    records.map((r) => ({
      id: r.id,
      invoice: r.invoice_id,
      trigger: r.trigger,
      recipient: r.recipient_address.slice(0, 8) + '…',
      channel: r.channel,
      status: r.status,
      attempts: r.attempts,
      last_error: r.last_error ? r.last_error.slice(0, 40) : '',
      created_at: new Date(r.created_at).toISOString(),
      attempt_timestamps: r.attempt_timestamps.length,
    }))
  );

  console.log(
    `\nRetention: 30d for sent_notifications, 90d for webhook_delivery_logs & delivery_audit_log (docs/privacy.md)`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
