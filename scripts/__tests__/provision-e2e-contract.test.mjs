import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDeployedContractIdShape,
  isPlaceholderContractId,
  resolveWasmPath,
  verifyContractExists,
} from '../provision-e2e-contract.mjs';

const REAL_ID = 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';

describe('isPlaceholderContractId', () => {
  it('rejects every placeholder shape the audit found (#1242)', () => {
    for (const placeholder of [
      'C_DEPLOYED_CONTRACT_ID',
      'C_MOCK_CONTRACT_ID_REPLACE_ME',
      'C_USDC_CONTRACT_ID_REPLACE_ME',
      'C_GOVERNANCE_CONTRACT_ID_REPLACE_ME',
      'C_XLM_CONTRACT_ID',
      'dummy-contract-id-for-local-dev',
      '',
      '   ',
      undefined,
      null,
    ]) {
      assert.equal(isPlaceholderContractId(placeholder), true, String(placeholder));
    }
  });

  it('accepts a real deployed contract id', () => {
    assert.equal(isPlaceholderContractId(REAL_ID), false);
    assert.equal(isDeployedContractIdShape(REAL_ID), true);
  });

  it('rejects malformed ids that are not placeholder-shaped either', () => {
    assert.equal(isDeployedContractIdShape('C_TOOLONG'), false);
    assert.equal(isDeployedContractIdShape('not-a-contract'), false);
  });
});

describe('resolveWasmPath', () => {
  it('returns null when the explicit path does not exist', () => {
    assert.equal(resolveWasmPath('definitely/not/here.wasm'), null);
  });
});

describe('verifyContractExists', () => {
  it('short-circuits placeholders and malformed ids without touching the chain', async () => {
    assert.deepEqual(await verifyContractExists('http://127.0.0.1:1', 'C_DEPLOYED_CONTRACT_ID'), {
      ok: false,
      reason: 'placeholder',
    });
    assert.deepEqual(await verifyContractExists('http://127.0.0.1:1', 'C_SHORT'), {
      ok: false,
      reason: 'malformed',
    });
  });

  it('reports not_found as a verification failure, not an unknown', async () => {
    // A stub that answers the JSON-RPC call with no ledger entries: the boundary
    // case where the RPC works but the contract was never deployed.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { entries: [] } }),
    });
    try {
      assert.deepEqual(await verifyContractExists('http://localhost:8000/soroban/rpc', REAL_ID), {
        ok: false,
        reason: 'not_found',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts a contract that is present in the ledger', async () => {
    const originalFetch = globalThis.fetch;
    let seenBody = null;
    globalThis.fetch = async (url, init) => {
      seenBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: { entries: [{ contractData: {} }] } }),
      };
    };
    try {
      assert.deepEqual(await verifyContractExists('http://localhost:8000/soroban/rpc', REAL_ID), {
        ok: true,
        reason: undefined,
      });
      assert.equal(seenBody.method, 'getLedgerEntries');
      assert.equal(seenBody.params.keys[0].contractData.contract, REAL_ID);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('propagates transport failures instead of treating them as verification success', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    await assert.rejects(() => verifyContractExists('http://127.0.0.1:1', REAL_ID), /ECONNREFUSED/);
    globalThis.fetch = originalFetch;
  });
});
