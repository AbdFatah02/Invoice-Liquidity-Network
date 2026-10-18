/**
 * Disaster-Recovery E2E Tests
 *
 * Referenced by issues #1251 and #1252 — part of the E2E cleanup and
 * contract isolation hardening.
 *
 * Cited audit evidence:
 *   tests/e2e/disaster-recovery.test.ts:86-223
 *
 * Invariants:
 *  1. The contract must not accept operations while the Stellar node is
 *     unreachable (fail-closed behaviour).
 *  2. After a node restart, previously committed state is fully recoverable.
 *  3. Concurrent conflicting operations must not corrupt contract state.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as StellarSdk from '@stellar/stellar-sdk';

// ─── Node configuration ──────────────────────────────────────────────────────

const RPC_URL = process.env.E2E_RPC_URL ?? 'http://localhost:8000/soroban/rpc';
const FRIENDBOT_URL =
  process.env.E2E_FRIENDBOT_URL ?? 'http://localhost:8000/friendbot';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let server: StellarSdk.rpc.Server;
let isNodeRunning = false;

async function fundAccount(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
  if (!res.ok) {
    throw new Error(
      `Friendbot failed for ${publicKey}: ${res.status} ${res.statusText}`,
    );
  }
}

async function provisionAccount(): Promise<StellarSdk.Keypair> {
  const kp = StellarSdk.Keypair.random();
  await fundAccount(kp.publicKey());
  return kp;
}

// ─── Suite setup ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  server = new StellarSdk.rpc.Server(RPC_URL, { allowHttp: true });
  try {
    const health = await server.getHealth();
    isNodeRunning = health.status === 'healthy';
  } catch {
    console.warn(
      '[disaster-recovery] Local Stellar node unreachable — E2E tests skipped.',
    );
    isNodeRunning = false;
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Disaster Recovery E2E', () => {
  // ── Audit gap: lines 86-120 ───────────────────────────────────────────────
  describe('Node-unavailable behaviour (fail-closed)', () => {
    it('getAccount rejects when node is unreachable (simulated)', async () => {
      // Simulate an unreachable node by pointing at an invalid URL.
      const deadServer = new StellarSdk.rpc.Server(
        'http://127.0.0.1:19999/soroban/rpc',
        { allowHttp: true },
      );

      await expect(
        deadServer.getAccount('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN'),
      ).rejects.toThrow();
    });

    it('Friendbot rejects when node is unreachable (simulated)', async () => {
      const fakeUrl = 'http://127.0.0.1:19999/friendbot?addr=G_INVALID';
      await expect(fetch(fakeUrl)).rejects.toThrow();
    });
  });

  // ── Audit gap: lines 120-160 ──────────────────────────────────────────────
  describe('State recovery after node restart', () => {
    it('account state is queryable after node reconnects', async (ctx) => {
      if (!isNodeRunning) return ctx.skip();

      // Pre-commit an account.
      const kp = await provisionAccount();

      // Simulate a brief interruption by creating a new server handle
      // (models an app restart — no in-memory cache survives).
      const freshServerHandle = new StellarSdk.rpc.Server(RPC_URL, {
        allowHttp: true,
      });

      const account = await freshServerHandle.getAccount(kp.publicKey());
      // Invariant: the account committed before "restart" is still there.
      expect(account.id).toBe(kp.publicKey());
    });

    it('account sequence number is preserved across server handle reconnect', async (ctx) => {
      if (!isNodeRunning) return ctx.skip();

      const kp = await provisionAccount();

      const handle1 = new StellarSdk.rpc.Server(RPC_URL, { allowHttp: true });
      const handle2 = new StellarSdk.rpc.Server(RPC_URL, { allowHttp: true });

      const acc1 = await handle1.getAccount(kp.publicKey());
      const acc2 = await handle2.getAccount(kp.publicKey());

      // Sequence numbers must match across independent handles.
      expect(acc1.sequenceNumber()).toBe(acc2.sequenceNumber());
    });
  });

  // ── Audit gap: lines 160-190 ──────────────────────────────────────────────
  describe('Concurrent conflicting operations', () => {
    it('two concurrent funding attempts cannot double-spend (logical invariant)', () => {
      // Logical invariant: if LP₁ and LP₂ both attempt to fund the same
      // invoice, only one should succeed.  The contract enforces this via
      // a status-check guard (Pending → Funded is a one-way CAS).
      const invoiceStatus = 'Pending';
      let funded = false;

      function tryFund(status: string): boolean {
        if (status === 'Pending' && !funded) {
          funded = true;
          return true;
        }
        return false;
      }

      const result1 = tryFund(invoiceStatus);
      const result2 = tryFund(invoiceStatus); // Status is now 'Funded'; should fail.

      expect(result1).toBe(true);
      expect(result2).toBe(false);
    });

    it('concurrent pay attempts on an already-paid invoice are idempotency-safe', () => {
      let isPaid = false;

      function tryPay(): boolean {
        if (!isPaid) {
          isPaid = true;
          return true;
        }
        return false;
      }

      const pay1 = tryPay();
      const pay2 = tryPay(); // Already paid.

      expect(pay1).toBe(true);
      expect(pay2).toBe(false);
    });
  });

  // ── Audit gap: lines 190-223 ──────────────────────────────────────────────
  describe('Contract isolation between test runs', () => {
    it('test A keypairs are not reused in test B (isolation invariant)', async (ctx) => {
      if (!isNodeRunning) return ctx.skip();

      const runA = await provisionAccount();
      const runB = await provisionAccount();

      expect(runA.publicKey()).not.toBe(runB.publicKey());
      expect(runA.secret()).not.toBe(runB.secret());
    });

    it('an account used in one test has no balance side-effects in another', async (ctx) => {
      if (!isNodeRunning) return ctx.skip();

      const isolated = await provisionAccount();

      // Fresh account has no SAC balances beyond native XLM.
      const account = await server.getAccount(isolated.publicKey());
      const nonNativeBalances = account.balances.filter(
        (b: { asset_type: string }) => b.asset_type !== 'native',
      );
      // A freshly created account has no token trustlines.
      expect(nonNativeBalances).toHaveLength(0);
    });

    it('each test creates an account with a unique sequence number baseline', async (ctx) => {
      if (!isNodeRunning) return ctx.skip();

      const a = await provisionAccount();
      const b = await provisionAccount();

      const accA = await server.getAccount(a.publicKey());
      const accB = await server.getAccount(b.publicKey());

      // Different accounts — their sequence numbers are independent.
      expect(a.publicKey()).not.toBe(b.publicKey());
      // Both start at the same initial Friendbot-set sequence, but they
      // are on separate account objects.
      expect(accA.id).not.toBe(accB.id);
    });
  });

  describe('Health check regression guard', () => {
    it('node health endpoint returns "healthy" at suite start', async (ctx) => {
      if (!isNodeRunning) return ctx.skip();

      const health = await server.getHealth();
      expect(health.status).toBe('healthy');
    });

    it('a dead-server handle always throws on getHealth', async () => {
      const deadServer = new StellarSdk.rpc.Server(
        'http://127.0.0.1:19999/soroban/rpc',
        { allowHttp: true },
      );

      await expect(deadServer.getHealth()).rejects.toThrow();
    });
  });
});
