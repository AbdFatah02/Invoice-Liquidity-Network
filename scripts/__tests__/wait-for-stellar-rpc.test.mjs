import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RpcReadinessError, waitForStellarRpc } from '../wait-for-stellar-rpc.mjs';

function response(result, { ok = true, status = 200, id } = {}) {
  return { ok, status, json: async () => ({ jsonrpc: '2.0', id, result }) };
}

function scriptedFetch(script) {
  let call = 0;
  return async (_url, init) => {
    const request = JSON.parse(init.body);
    const value = script[call++];
    if (value instanceof Error) throw value;
    return response(value, { id: request.id });
  };
}

describe('waitForStellarRpc (#1245)', () => {
  it('requires consecutive semantic health and ledger successes', async () => {
    const result = await waitForStellarRpc({
      attempts: 2,
      intervalMs: 0,
      fetchImpl: scriptedFetch([
        { status: 'healthy' },
        { sequence: 10 },
        { status: 'healthy' },
        { sequence: 10 },
      ]),
      sleep: async () => {},
    });
    assert.equal(result.ready, true);
    assert.equal(result.latestLedger, 10);
  });

  it('fails closed when transport never becomes available', async () => {
    await assert.rejects(
      waitForStellarRpc({
        attempts: 2,
        intervalMs: 0,
        fetchImpl: scriptedFetch([new Error('down'), new Error('down')]),
        sleep: async () => {},
      }),
      RpcReadinessError
    );
  });

  it('resets the readiness streak across a restart-like failure', async () => {
    const result = await waitForStellarRpc({
      attempts: 4,
      intervalMs: 0,
      fetchImpl: scriptedFetch([
        { status: 'healthy' },
        { sequence: 20 },
        new Error('connection reset'),
        { status: 'healthy' },
        { sequence: 21 },
        { status: 'healthy' },
        { sequence: 22 },
      ]),
      sleep: async () => {},
    });
    assert.equal(result.attempts.length, 4);
    assert.equal(result.latestLedger, 22);
  });

  it('rejects the boundary value of ledger sequence zero', async () => {
    await assert.rejects(
      waitForStellarRpc({
        attempts: 1,
        fetchImpl: scriptedFetch([{ status: 'healthy' }, { sequence: 0 }]),
      }),
      /invalid ledger sequence/
    );
  });
});
