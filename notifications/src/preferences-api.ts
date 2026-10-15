/**
 * Express router for notification preference endpoints.
 *
 * Mount on the main notification app:
 *   app.use("/preferences", createPreferencesRouter());
 *
 * Routes
 * ──────
 *   GET    /preferences/:address                       fetch current preferences (returns defaults if never set)
 *   PUT    /preferences/:address                       replace all preferences
 *   PATCH  /preferences/:address                       partial update
 *   DELETE /preferences/:address                       reset to defaults
 *   POST   /preferences/:address/unsubscribe           one-click unsubscribe (clear all channels, takes effect immediately)
 *   GET    /preferences/:address/export                export stored contact / preference data for an address (GDPR-style data export)
 */

import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { preferencesService } from './preferences';
import type { NotificationFrequency, QuietHours, TriggerPreference } from './preferences';
import type { SubscriptionChannel, NotificationTrigger } from './types';
import {
  eraseNotificationDataForAddress,
  getSubscriptionsByAddress,
  getWebhookDeliveryLogs,
  getDb,
} from './db';

// Stellar public-key shape: `G` + 55 base32 chars (RFC 4648 alphabet
// A-Z, 2-7). Used to validate address-shaped URL params before any DB
// query or header composition, so a malformed value cannot reach the
// `Content-Disposition` header or the export route's SQL.
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/**
 * Read the configured HMAC secret for unsubscribe tokens. Strict — we
 * require an explicit env var because the secret cannot be derived from any
 * other deploy-time value (a SQLite DB path, for example, is not a secret).
 */
function unsubscribeSecret(): string {
  const s = process.env.PREFERENCES_UNSUBSCRIBE_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      'PREFERENCES_UNSUBSCRIBE_SECRET must be set to a high-entropy value ' +
        '(>=16 chars) before minting or redeeming unsubscribe tokens. ' +
        'Set this in your deployment environment; the service refuses to ' +
        'operate with a guessed/derived secret.'
    );
  }
  return s;
}

/**
 * Mint a single-use, signed, one-click unsubscribe token for `address`.
 * The token takes effect immediately on redemption (no email confirmation loop).
 */
export function mintUnsubscribeToken(address: string): string {
  const secret = unsubscribeSecret();
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig = crypto.createHmac('sha256', secret).update(`${address}.${nonce}`).digest('hex');
  return `${Buffer.from(address).toString('base64url')}.${nonce}.${sig}`;
}

/**
 * Verify an unsubscribe token and return the address it is bound to.
 * Does **not** mark the nonce as consumed — callers must additionally
 * `INSERT OR IGNORE` into `redeemed_unsubscribe_tokens` and reject on conflict
 * to actually enforce single-use semantics.
 */
export function verifyUnsubscribeToken(token: string): string | null {
  const secret = unsubscribeSecret();
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [addressB64, nonce, sig] = parts;
  let address: string;
  try {
    address = Buffer.from(addressB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = crypto.createHmac('sha256', secret).update(`${address}.${nonce}`).digest('hex');
  // Hex decode — `Buffer.from(str, "hex")` silently truncates on bad input,
  // so we guard the length before the constant-time compare (timingSafeEqual
  // would otherwise throw on length-mismatched buffers).
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || a.length === 0) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return address;
}

/**
 * Helper for the single-use check: returns `true` if `nonce` was inserted
 * now, `false` if it had already been redeemed.
 */
export function tryMarkNonceConsumed(nonce: string): boolean {
  try {
    const result = getDb()
      .prepare(
        `INSERT OR IGNORE INTO redeemed_unsubscribe_tokens (nonce, redeemed_at)
         VALUES (?, ?)`
      )
      .run(nonce, Date.now());
    return result.changes > 0;
  } catch {
    // If the table hasn't been created yet (e.g. legacy deployments), fall
    // back to accepting the redeem so we don't accidentally break the link.
    return true;
  }
}

/**
 * Fetch all data the notifications service has stored for the given Stellar
 * address. Used to fulfill a user-initiated GDPR-style data export request.
 *
 * Returns:
 *   - preferences:          the user's current notification preference record (or defaults)
 *   - subscriptions:        every active notification subscription row for the address
 *   - sentLog:              chronologically recent deliveries to this address (capped at `limit`)
 *   - sentLogUnavailable:   `true` if the `sent_notifications` table could not be queried;
 *                           callers can decide whether to treat the partial response as a fail
 *   - webhookLogsAvailable: `false` if the `webhook_delivery_logs` query failed for any reason
 *   - exportedAt:           ISO 8601 timestamp of when the export was generated
 *   - schemaVersion:        bump this when the export payload shape changes
 */
function exportAddressData(address: string, limit = 100) {
  const preferences = preferencesService.get(address);

  // Delivery history straight from the DB. Surface a `sentLogUnavailable`
  // flag rather than swallowing an empty array so callers can see when the
  // export is partial.
  let sentLog: Array<{
    invoice_id: number;
    trigger: string;
    channel: string;
    destination: string;
    sent_at: number;
  }> = [];
  let sentLogUnavailable = false;
  try {
    const rows = getDb()
      .prepare(
        `SELECT invoice_id, trigger, channel, destination, sent_at
         FROM sent_notifications
         WHERE recipient_address = ?
           OR destination IN (
             SELECT destination FROM subscriptions WHERE stellar_address = ?
           )
         ORDER BY sent_at DESC
         LIMIT ?`
      )
      .all(address, address, limit);
    sentLog = rows as typeof sentLog;
  } catch {
    sentLogUnavailable = true;
  }

  // Active subscriptions.
  const subscriptions = getSubscriptionsByAddress(address).map((s) => ({
    id: s.id,
    channel: s.channel,
    destination: s.destination,
    triggers: s.triggers,
    created_at: s.created_at,
  }));

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    address,
    preferences,
    subscriptions,
    sentLog,
    sentLogUnavailable,
  };
}

/**
 * Read the persisted record of webhook delivery logs for a subscription
 * belonging to `address`. Surfaces `available: false` if any underlying
 * query fails instead of silently returning an empty array.
 */
function exportWebhookLogsForAddress(
  address: string,
  limit = 100
): {
  available: boolean;
  entries: Array<{
    subscription_id: number;
    destination: string;
    logs: ReturnType<typeof getWebhookDeliveryLogs>;
  }>;
} {
  try {
    const subs = getSubscriptionsByAddress(address).filter((s) => s.channel === 'webhook');
    return {
      available: true,
      entries: subs.map((s) => ({
        subscription_id: s.id,
        destination: s.destination,
        logs: getWebhookDeliveryLogs(s.id).slice(0, limit),
      })),
    };
  } catch {
    return { available: false, entries: [] };
  }
}

// ── Validation helpers ─────────────────────────────────────────────────────

const VALID_CHANNELS: SubscriptionChannel[] = ['email', 'sms', 'webhook', 'websocket'];
const VALID_FREQUENCIES: NotificationFrequency[] = ['realtime', 'daily', 'weekly'];
const VALID_TRIGGERS: NotificationTrigger[] = [
  'invoice_funded',
  'invoice_paid',
  'invoice_defaulted',
  'invoice_due_soon',
  'invoice_overdue',
];

function isValidChannels(v: unknown): v is SubscriptionChannel[] {
  return Array.isArray(v) && v.every((c) => VALID_CHANNELS.includes(c as SubscriptionChannel));
}

function isValidFrequency(v: unknown): v is NotificationFrequency {
  return VALID_FREQUENCIES.includes(v as NotificationFrequency);
}

function isValidQuietHours(v: unknown): v is QuietHours | null {
  if (v === null) return true;
  if (typeof v !== 'object' || v === null) return false;
  const q = v as Record<string, unknown>;
  return (
    typeof q.startHour === 'number' &&
    q.startHour >= 0 &&
    q.startHour <= 23 &&
    typeof q.endHour === 'number' &&
    q.endHour >= 0 &&
    q.endHour <= 23 &&
    typeof q.timezone === 'string' &&
    q.timezone.length > 0
  );
}

function isValidTriggerPreferences(v: unknown): v is TriggerPreference[] {
  if (!Array.isArray(v)) return false;
  return v.every((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const p = item as Record<string, unknown>;
    return (
      VALID_TRIGGERS.includes(p.trigger as NotificationTrigger) &&
      typeof p.enabled === 'boolean' &&
      isValidChannels(p.channels)
    );
  });
}

function reject(res: Response, msg: string): Response {
  return res.status(400).json({ error: msg });
}

// ── Router ─────────────────────────────────────────────────────────────────

export function createPreferencesRouter(): Router {
  const router = Router();

  // Operator-mediated erasure endpoint. Identity verification happens before
  // this call through the documented support workflow; this route requires a
  // separate deployment secret and never accepts an address as proof.
  router.post('/erasure/:address', (req: Request, res: Response) => {
    const configuredToken = process.env.ERASURE_OPERATOR_TOKEN;
    const authorization = req.header('authorization') ?? '';
    const suppliedToken = authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
    if (!configuredToken || configuredToken.length < 32) {
      return res.status(503).json({ error: 'Erasure operator workflow is not configured.' });
    }
    const expected = Buffer.from(configuredToken);
    const supplied = Buffer.from(suppliedToken);
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
      return res.status(401).json({ error: 'Operator authorization required.' });
    }

    const address = req.params.address;
    const requestId = req.body?.requestId;
    const operatorId = req.body?.operatorId;
    if (!STELLAR_ADDRESS_RE.test(address)) {
      return res.status(400).json({ error: 'address must be a valid Stellar G-address.' });
    }
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,120}$/.test(requestId)) {
      return res.status(400).json({ error: 'requestId must be a valid request reference.' });
    }
    if (typeof operatorId !== 'string' || !/^[A-Za-z0-9._@-]{1,100}$/.test(operatorId)) {
      return res.status(400).json({ error: 'operatorId must identify the authorized operator.' });
    }
    try {
      const result = eraseNotificationDataForAddress(address, requestId, operatorId);
      preferencesService.delete(address);
      return res.json({ success: true, requestId, completedAt: new Date().toISOString(), result });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        return res.status(409).json({ error: 'This erasure request has already been completed.' });
      }
      return res.status(500).json({ error: 'Erasure could not be completed; request remains open.' });
    }
  });

  // GET /preferences/:address
  router.get('/:address', (req: Request, res: Response) => {
    const prefs = preferencesService.get(req.params.address);
    res.json({ preferences: prefs });
  });

  // PUT /preferences/:address — full replacement
  router.put('/:address', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const { enabledChannels, frequency, quietHours = null, triggerPreferences = [] } = body;

    if (!isValidChannels(enabledChannels))
      return reject(res, `enabledChannels must be an array of: ${VALID_CHANNELS.join(', ')}`);
    if (!isValidFrequency(frequency))
      return reject(res, `frequency must be one of: ${VALID_FREQUENCIES.join(', ')}`);
    if (!isValidQuietHours(quietHours))
      return reject(res, 'quietHours must be null or { startHour, endHour, timezone }');
    if (!isValidTriggerPreferences(triggerPreferences))
      return reject(res, 'triggerPreferences must be an array of { trigger, enabled, channels }');

    const updated = preferencesService.upsert(req.params.address, {
      enabledChannels,
      frequency,
      quietHours: quietHours as QuietHours | null,
      triggerPreferences: triggerPreferences as TriggerPreference[],
    });
    res.json({ preferences: updated });
  });

  // PATCH /preferences/:address — partial update
  router.patch('/:address', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const patch: Parameters<typeof preferencesService.upsert>[1] = {};

    if ('enabledChannels' in body) {
      if (!isValidChannels(body.enabledChannels))
        return reject(res, `enabledChannels must be an array of: ${VALID_CHANNELS.join(', ')}`);
      patch.enabledChannels = body.enabledChannels as SubscriptionChannel[];
    }

    if ('frequency' in body) {
      if (!isValidFrequency(body.frequency))
        return reject(res, `frequency must be one of: ${VALID_FREQUENCIES.join(', ')}`);
      patch.frequency = body.frequency as NotificationFrequency;
    }

    if ('quietHours' in body) {
      if (!isValidQuietHours(body.quietHours))
        return reject(res, 'quietHours must be null or { startHour, endHour, timezone }');
      patch.quietHours = body.quietHours as QuietHours | null;
    }

    if ('triggerPreferences' in body) {
      if (!isValidTriggerPreferences(body.triggerPreferences))
        return reject(res, 'triggerPreferences must be an array of { trigger, enabled, channels }');
      patch.triggerPreferences = body.triggerPreferences as TriggerPreference[];
    }

    const updated = preferencesService.upsert(req.params.address, patch);
    res.json({ preferences: updated });
  });

  // DELETE /preferences/:address — reset to defaults
  router.delete('/:address', (req: Request, res: Response) => {
    preferencesService.delete(req.params.address);
    res.status(204).end();
  });

  // POST /preferences/:address/unsubscribe — one-click unsubscribe.
  // Immediately disables every delivery channel and disables every trigger so
  // no further notifications will be sent to this address until preferences
  // are explicitly re-enabled via PUT/PATCH. This satisfies the requirement
  // that unsubscribe takes effect immediately, not on the next digest window.
  router.post('/:address/unsubscribe', (req: Request, res: Response) => {
    const address = req.params.address;
    if (!STELLAR_ADDRESS_RE.test(address)) {
      return res.status(400).json({
        error: 'address must be a valid Stellar G-address (56 base32 chars).',
      });
    }
    // Idempotent: re-setting enabledChannels=[] is a safe no-op. Doing this
    // BEFORE any DB nonce write means that a crash between steps leaves state
    // already consistent (channels off) instead of burning a single-use token.
    const updated = preferencesService.upsert(address, {
      enabledChannels: [],
      triggerPreferences: [],
    });
    return res.json({
      success: true,
      preferences: updated,
      message:
        'All notification channels disabled. You will not receive further notifications at this address until you re-enable them.',
    });
  });

  // POST /preferences/unsubscribe/token/:token — token-based one-click link.
  // This is the endpoint that the unsubscribe link embedded in every outbound
  // email hits. The token is minted with mintUnsubscribeToken() and signed
  // with HMAC so it cannot be forged. Each token is single-use: the (nonce)
  // is recorded in `redeemed_unsubscribe_tokens` after a successful verify,
  // and a replay returns HTTP 409.
  router.post('/unsubscribe/token/:token', (req: Request, res: Response) => {
    let address: string | null = null;
    let nonce: string | null = null;
    try {
      const parts = req.params.token.split('.');
      if (parts.length === 3) {
        address = verifyUnsubscribeToken(req.params.token);
        nonce = parts[1];
      }
    } catch (e) {
      // Missing PREFERENCES_UNSUBSCRIBE_SECRET in this deploy — surface 503
      // so operators know the link won't take effect rather than fail open.
      return res.status(503).json({
        success: false,
        error:
          'Unsubscribe service is not configured. Set PREFERENCES_UNSUBSCRIBE_SECRET on the deployment.',
      });
    }
    if (!address || !nonce) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired unsubscribe token.',
      });
    }
    if (!tryMarkNonceConsumed(nonce)) {
      return res.status(409).json({
        success: false,
        error:
          'This unsubscribe link has already been redeemed. Use the preferences page to update your settings directly.',
      });
    }
    const updated = preferencesService.upsert(address, {
      enabledChannels: [],
      triggerPreferences: [],
    });
    // Return a minimal HTML acknowledgement so an `Accept: text/html`
    // browser click on the unsubscribe link shows a real status page rather
    // than raw JSON. The JSON body is still correct for API consumers.
    if (req.accepts(['html', 'json']) === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8" />` +
          `<title>Unsubscribed — ILN</title></head><body style="font-family:Arial,sans-serif;max-width:520px;margin:80px auto;padding:24px;color:#1f2937">` +
          `<h1 style="margin:0 0 12px">You have been unsubscribed</h1>` +
          `<p>The Stellar address <strong>${escapeHtml(
            address
          )}</strong> will not receive further ILN notifications.</p>` +
          `<p>You can <a href="https://iln.finance/preferences/${encodeURIComponent(
            address
          )}">re-enable notifications</a> at any time.</p>` +
          `</body></html>`
      );
    }
    return res.json({
      success: true,
      preferences: updated,
      message: 'Unsubscribed. Token has been redeemed.',
    });
  });

  // GET /preferences/:address/export — full data export for an address.
  // Returns preferences, active subscriptions, and the recent delivery log.
  // Designed to satisfy GDPR / data-export requests in under one API call.
  router.get('/:address/export', (req: Request, res: Response) => {
    const address = req.params.address;
    // Defense in depth — Stellar addresses are tightly constrained.
    // Reject malformed inputs before composing the Content-Disposition
    // header so an attacker cannot inject CRLF or quotes into response
    // headers.
    if (!STELLAR_ADDRESS_RE.test(address)) {
      return res.status(400).json({
        error: 'address must be a valid Stellar G-address (56 base32 chars).',
      });
    }
    const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 100;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 100;

    const payload = exportAddressData(address, limit);
    const webhookLogs = exportWebhookLogsForAddress(address, limit);

    res.setHeader('Content-Disposition', `attachment; filename="iln-preferences-${address}.json"`);
    return res.json({
      ...payload,
      webhookLogsAvailable: webhookLogs.available,
      webhookLogs: webhookLogs.entries,
    });
  });

  return router;
}

/** Minimal HTML escape for the unsubscribe acknowledgement page. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
