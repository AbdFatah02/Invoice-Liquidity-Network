/**
 * End-to-end tests for the preferences API (Issue #741 compliance audit).
 *
 * Verifies:
 *  - One-click unsubscribe takes effect immediately
 *  - The data-export endpoint returns preferences + subscriptions + sent log
 *  - The tokenized unsubscribe URL minted and redeemed correctly
 *  - Invalid tokens are rejected
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { createDb, setDb } from '../db';
import { createPreferencesRouter } from '../preferences-api';
import { mintUnsubscribeToken, verifyUnsubscribeToken } from '../preferences-api';
import { preferencesService } from '../preferences';

// Round-3 reviewer feedback: set the unsubscribe secret in `beforeAll`
// (not at module-load time) so per-worker module evaluation order cannot
// leave it unset when mint/verify is first invoked.
const UNSUBSCRIBE_SECRET = 'test-secret-do-not-use-anywhere-else-32-bytes-long';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/preferences', createPreferencesRouter());
  return app;
}

// Round-2 reviewer feedback: prior fixtures contained 0–9 (digits not in
// Stellar's base32 alphabet `A-Z2-7`) and were 54 chars instead of 56. The
// new export-endpoint validation `/^G[A-Z2-7]{55}$/` therefore rejected
// them. Use valid 56-char Stellar-shaped addresses that match the regex.
const ADDRESS_A = 'G' + 'A'.repeat(55); // 56 chars, base32-clean
const ADDRESS_B = 'G' + 'B'.repeat(55); // distinct address for cross-tenant tests

let db: InstanceType<typeof Database>;

beforeAll(() => {
  process.env.PREFERENCES_UNSUBSCRIBE_SECRET = UNSUBSCRIBE_SECRET;
});

beforeEach(() => {
  db = createDb(':memory:');
  setDb(db);
});

afterEach(() => {
  // Defense in depth so the :memory: SQLite handle does not leak across test
  // files in the same vitest worker. Drop the module-level cache too so a
  // later test that calls `getDb()` does not receive the previous in-memory
  // db by accident.
  try {
    db.close();
  } catch {
    /* already closed */
  }
  setDb(null as any);
  // Reset module-state between tests since preferencesService uses an in-memory map.
  preferencesService.delete(ADDRESS_A);
  preferencesService.delete(ADDRESS_B);
});

describe('GET /preferences/:address/export (#741)', () => {
  it('returns preferences, subscriptions, and delivery log', async () => {
    // Seed: build a subscription + a delivery log row + set preferences.
    db.prepare(
      `INSERT INTO subscriptions (stellar_address, channel, destination, triggers, created_at)
       VALUES (?, 'email', ?, ?, ?)`
    ).run(ADDRESS_A, 'user@example.com', JSON.stringify(['invoice_funded']), Date.now());

    db.prepare(
      `INSERT INTO sent_notifications
       (invoice_id, trigger, recipient_address, channel, destination, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(42, 'invoice_funded', ADDRESS_A, 'email', 'user@example.com', Date.now());

    preferencesService.upsert(ADDRESS_A, {
      enabledChannels: ['email'],
      frequency: 'daily',
    });

    const res = await request(makeApp()).get(`/preferences/${ADDRESS_A}/export`);
    expect(res.status).toBe(200);
    expect(res.body.schemaVersion).toBe(1);
    expect(res.body.address).toBe(ADDRESS_A);
    expect(res.body.preferences.enabledChannels).toEqual(['email']);
    expect(res.body.preferences.frequency).toBe('daily');
    expect(res.body.subscriptions).toHaveLength(1);
    expect(res.body.subscriptions[0].destination).toBe('user@example.com');
    expect(res.body.sentLog).toHaveLength(1);
    expect(res.body.sentLog[0].trigger).toBe('invoice_funded');
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['content-disposition']).toContain(ADDRESS_A);
  });

  it('returns defaults when the address has never set preferences', async () => {
    const res = await request(makeApp()).get(`/preferences/${ADDRESS_B}/export`);
    expect(res.status).toBe(200);
    expect(res.body.preferences.frequency).toBe('realtime');
    expect(res.body.preferences.enabledChannels).toEqual(['email', 'webhook']);
    expect(res.body.subscriptions).toEqual([]);
    expect(res.body.sentLog).toEqual([]);
  });
});

describe('POST /preferences/erasure/:address', () => {
  beforeEach(() => {
    process.env.ERASURE_OPERATOR_TOKEN = 'operator-test-token-that-is-at-least-32-chars';
  });

  afterEach(() => {
    delete process.env.ERASURE_OPERATOR_TOKEN;
  });

  it('requires operator authorization and removes contact data while preserving anonymized audit history', async () => {
    const token = process.env.ERASURE_OPERATOR_TOKEN!;
    preferencesService.upsert(ADDRESS_A, { enabledChannels: ['email'] });
    db.prepare(`INSERT INTO subscriptions (stellar_address, channel, destination, triggers, created_at)
      VALUES (?, 'email', 'person@example.com', '[]', ?)`)
      .run(ADDRESS_A, Date.now());
    db.prepare(`INSERT INTO sent_notifications
      (invoice_id, trigger, recipient_address, channel, destination, sent_at)
      VALUES (1, 'invoice_paid', ?, 'email', 'person@example.com', ?)`)
      .run(ADDRESS_A, Date.now());
    db.prepare(`INSERT INTO delivery_audit_log
      (invoice_id, trigger, recipient_address, channel, destination, status, attempts,
       attempt_timestamps, created_at, updated_at)
      VALUES (1, 'invoice_paid', ?, 'email', 'person@example.com', 'delivered', 1, '[]', ?, ?)`)
      .run(ADDRESS_A, Date.now(), Date.now());

    const denied = await request(makeApp()).post(`/preferences/erasure/${ADDRESS_A}`)
      .send({ requestId: 'privacy-req-0001', operatorId: 'ops@example.test' });
    expect(denied.status).toBe(401);

    const response = await request(makeApp())
      .post(`/preferences/erasure/${ADDRESS_A}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ requestId: 'privacy-req-0001', operatorId: 'ops@example.test' });
    expect(response.status).toBe(200);
    expect(response.body.result).toMatchObject({ subscriptions: 1, sentNotifications: 1, anonymizedAuditRows: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM subscriptions WHERE stellar_address = ?').get(ADDRESS_A)).toMatchObject({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM sent_notifications WHERE recipient_address = ?').get(ADDRESS_A)).toMatchObject({ count: 0 });
    expect(db.prepare('SELECT recipient_address, destination FROM delivery_audit_log').get())
      .toMatchObject({ recipient_address: '', destination: '' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM erasure_request_audit').get()).toMatchObject({ count: 1 });
    expect(preferencesService.get(ADDRESS_A).enabledChannels).toEqual(['email', 'webhook']);
  });

  it('does not erase data owned by another address', async () => {
    const token = process.env.ERASURE_OPERATOR_TOKEN!;
    db.prepare(`INSERT INTO subscriptions (stellar_address, channel, destination, triggers, created_at)
      VALUES (?, 'email', 'other@example.com', '[]', ?)`)
      .run(ADDRESS_B, Date.now());
    const response = await request(makeApp())
      .post(`/preferences/erasure/${ADDRESS_A}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ requestId: 'privacy-req-0002', operatorId: 'ops@example.test' });
    expect(response.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS count FROM subscriptions WHERE stellar_address = ?').get(ADDRESS_B))
      .toMatchObject({ count: 1 });
  });
});

describe('POST /preferences/:address/unsubscribe (#741)', () => {
  it('immediately clears all channels', async () => {
    preferencesService.upsert(ADDRESS_A, {
      enabledChannels: ['email', 'sms'],
      frequency: 'daily',
    });

    const res = await request(makeApp()).post(`/preferences/${ADDRESS_A}/unsubscribe`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.preferences.enabledChannels).toEqual([]);

    const after = await request(makeApp()).get(`/preferences/${ADDRESS_A}`);
    expect(after.body.preferences.enabledChannels).toEqual([]);
  });

  it('is idempotent (calling twice is safe)', async () => {
    const app = makeApp();
    const r1 = await request(app).post(`/preferences/${ADDRESS_A}/unsubscribe`);
    const r2 = await request(app).post(`/preferences/${ADDRESS_A}/unsubscribe`);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.preferences.enabledChannels).toEqual([]);
  });
});

describe('POST /preferences/unsubscribe/token/:token (#741)', () => {
  it('mints and redeems a token that clears channels', async () => {
    preferencesService.upsert(ADDRESS_A, {
      enabledChannels: ['email', 'webhook'],
    });

    const token = mintUnsubscribeToken(ADDRESS_A);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[a-f0-9]+\.[a-f0-9]+$/);

    const verified = verifyUnsubscribeToken(token);
    expect(verified).toBe(ADDRESS_A);

    const res = await request(makeApp()).post(`/preferences/unsubscribe/token/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.preferences.enabledChannels).toEqual([]);
  });

  it('a round-tripped unmodified token is accepted (positive control)', async () => {
    preferencesService.upsert(ADDRESS_A, { enabledChannels: ['email'] });
    const token = mintUnsubscribeToken(ADDRESS_A);
    const res = await request(makeApp()).post(`/preferences/unsubscribe/token/${token}`);
    expect(res.status).toBe(200);
  });

  it('rejects a token whose HMAC signature is tampered', async () => {
    const token = mintUnsubscribeToken(ADDRESS_A);
    const parts = token.split('.');
    // Flip the first hex char of the HMAC digset.
    const tamperedSig = parts[2].startsWith('0')
      ? `1${parts[2].slice(1)}`
      : `0${parts[2].slice(1)}`;
    const tampered = `${parts[0]}.${parts[1]}.${tamperedSig}`;
    // Tampered tokens MUST verify as null …
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
    // … and the HTTP endpoint MUST reject them with 400.
    const res = await request(makeApp()).post(`/preferences/unsubscribe/token/${tampered}`);
    expect(res.status).toBe(400);
  });

  it('rejects a token whose address segment is tampered', async () => {
    const token = mintUnsubscribeToken(ADDRESS_A);
    const parts = token.split('.');
    // Replace base64url address bytes; signature will no longer match.
    const addressBytes = Buffer.from(ADDRESS_B).toString('base64url');
    const tampered = `${addressBytes}.${parts[1]}.${parts[2]}`;
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
    const res = await request(makeApp()).post(`/preferences/unsubscribe/token/${tampered}`);
    expect(res.status).toBe(400);
  });

  it('enforces single-use — replays return HTTP 409', async () => {
    preferencesService.upsert(ADDRESS_A, { enabledChannels: ['email'] });
    const token = mintUnsubscribeToken(ADDRESS_A);
    const r1 = await request(makeApp()).post(`/preferences/unsubscribe/token/${token}`);
    expect(r1.status).toBe(200);
    const r2 = await request(makeApp()).post(`/preferences/unsubscribe/token/${token}`);
    expect(r2.status).toBe(409);
  });

  it('rejects a malformed token', async () => {
    const res = await request(makeApp()).post('/preferences/unsubscribe/token/garbage');
    expect(res.status).toBe(400);
    const res2 = await request(makeApp()).post('/preferences/unsubscribe/token/only.two-parts');
    expect(res2.status).toBe(400);
  });

  it('returns an HTML acknowledgement for browser clicks', async () => {
    preferencesService.upsert(ADDRESS_A, { enabledChannels: ['email'] });
    const token = mintUnsubscribeToken(ADDRESS_A);

    const res = await request(makeApp())
      .post(`/preferences/unsubscribe/token/${token}`)
      .set('Accept', 'text/html');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('You have been unsubscribed');
    expect(res.text).toContain(ADDRESS_A);
  });
});

describe('GET /preferences/:address/export — input validation (#741)', () => {
  it('rejects an address that does not match the Stellar base32 pattern', async () => {
    const res = await request(makeApp()).get('/preferences/not-a-stellar-address/export');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Stellar G-address/);
  });
});

describe('Existing CRUD endpoints still work (#741 regression)', () => {
  it('GET/PATCH/DELETE round-trip', async () => {
    const app = makeApp();
    const get1 = await request(app).get(`/preferences/${ADDRESS_A}`);
    expect(get1.body.preferences.frequency).toBe('realtime');

    await request(app).patch(`/preferences/${ADDRESS_A}`).send({ frequency: 'weekly' });

    const get2 = await request(app).get(`/preferences/${ADDRESS_A}`);
    expect(get2.body.preferences.frequency).toBe('weekly');

    await request(app).delete(`/preferences/${ADDRESS_A}`);
    const get3 = await request(app).get(`/preferences/${ADDRESS_A}`);
    expect(get3.body.preferences.frequency).toBe('realtime'); // back to defaults
  });
});
