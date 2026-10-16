import { describe, it, expect, afterEach, vi } from 'vitest';
import * as StellarSdk from '@stellar/stellar-sdk';
import {
  E2EPrerequisiteError,
  isPlaceholderContractId,
  optionalContractId,
  requireContractId,
  requireHealthyRpc,
  resolveRpcRetryPolicy,
  retryDelayMs,
  assertPrerequisitesSatisfied,
  evaluatePrerequisites,
  skipsAllowed,
} from './support/e2e-prerequisites';

/**
 * Regression coverage for the fail-closed E2E prerequisite control
 * (#1241, #1242, #1243, #1244).
 *
 * These tests are dependency-free: they run on every `pnpm test:e2e` invocation,
 * including on a machine with no Stellar node, so the control itself can never be
 * "verified" only in an environment where it happens to be satisfied.
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe('E2E prerequisite control', () => {
  describe('contract id resolution', () => {
    it('accepts a real deployed contract id', () => {
      const real = 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
      process.env.CONTRACT_ID = real;
      expect(requireContractId('CONTRACT_ID')).toBe(real);
    });

    it('falls back to the deployed-contract id written by the deployer', () => {
      delete process.env.CONTRACT_ID;
      process.env.DEPLOYED_CONTRACT_ID = 'CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAO2D6LWDFDLNOAAAAAAAAAA';
      expect(requireContractId('CONTRACT_ID', { fallbackEnvVars: ['DEPLOYED_CONTRACT_ID'] })).toBe(
        'CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAO2D6LWDFDLNOAAAAAAAAAA'
      );
    });

    it('fails actionably when the contract id is missing', () => {
      delete process.env.CONTRACT_ID;
      expect(() => requireContractId('CONTRACT_ID')).toThrow(E2EPrerequisiteError);

      try {
        requireContractId('CONTRACT_ID');
        expect.unreachable('requireContractId must throw when CONTRACT_ID is unset');
      } catch (error) {
        const failure = error as E2EPrerequisiteError;
        expect(failure.prerequisite).toBe('CONTRACT_ID contract id');
        expect(failure.message).toContain('CONTRACT_ID=<unset>');
        expect(failure.recovery).toContain('scripts/provision-e2e-contract.mjs');
      }
    });

    it.each([
      'C_DEPLOYED_CONTRACT_ID',
      'C_MOCK_CONTRACT_ID_REPLACE_ME',
      'C_USDC_CONTRACT_ID_REPLACE_ME',
      'C_GOVERNANCE_CONTRACT_ID_REPLACE_ME',
      'C_USDC_CONTRACT_ID',
      '   ',
      '',
    ])(
      'rejects the placeholder contract id %j instead of calling the SDK with it',
      (placeholder) => {
        expect(isPlaceholderContractId(placeholder)).toBe(true);
        process.env.CONTRACT_ID = placeholder;
        expect(() => requireContractId('CONTRACT_ID')).toThrow(
          /Placeholder contract IDs are rejected/
        );
        delete process.env.CONTRACT_ID;
      }
    );

    it('reports absent token contract ids as undefined rather than a placeholder', () => {
      delete process.env.USDC_CONTRACT_ID;
      expect(optionalContractId('USDC_CONTRACT_ID')).toBeUndefined();

      process.env.USDC_CONTRACT_ID = 'C_USDC_CONTRACT_ID_REPLACE_ME';
      expect(optionalContractId('USDC_CONTRACT_ID')).toBeUndefined();

      process.env.USDC_CONTRACT_ID = 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
      expect(optionalContractId('USDC_CONTRACT_ID')).toBe(
        'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW'
      );
    });
  });

  describe('RPC availability', () => {
    const unreachable = 'http://127.0.0.1:1/soroban/rpc';

    it('fails actionably instead of skipping when the RPC is unreachable', async () => {
      await expect(requireHealthyRpc(unreachable)).rejects.toBeInstanceOf(E2EPrerequisiteError);

      try {
        await requireHealthyRpc(unreachable);
        expect.unreachable('requireHealthyRpc must throw when the node is down');
      } catch (error) {
        const failure = error as E2EPrerequisiteError;
        expect(failure.prerequisite).toBe('stellar rpc');
        expect(failure.message).toContain(unreachable);
        expect(failure.recovery).toContain('tests/e2e/docker-compose.yml');
        expect(failure.message).toContain('docs/runbooks/e2e-prerequisites.md');
      }
    });

    it('treats a rejected connection as unavailable, not as a passing suite', async () => {
      // Port 1 is never a Stellar RPC endpoint; the control must never treat a
      // transport error as a healthy node.
      let failed = false;
      try {
        await requireHealthyRpc(unreachable);
      } catch (error) {
        failed = true;
        expect(error).toBeInstanceOf(E2EPrerequisiteError);
      }
      expect(failed).toBe(true);
    });
  });

  describe('prerequisite evaluation', () => {
    const failing = async () => {
      throw new E2EPrerequisiteError('stellar rpc', 'down', 'restart the node');
    };

    it('reports ok when every prerequisite holds', async () => {
      delete process.env.E2E_ALLOW_SKIP;
      const status = await evaluatePrerequisites(async () => {});
      expect(status.ok).toBe(true);
      expect(status.skip).toBe(false);
      expect(() => assertPrerequisitesSatisfied(status)).not.toThrow();
    });

    it('carries an unmet prerequisite as an actionable failure, not a skip', async () => {
      delete process.env.E2E_ALLOW_SKIP;
      const status = await evaluatePrerequisites(failing);

      expect(status.ok).toBe(false);
      expect(status.skip).toBe(false);
      expect(status.error).toBeInstanceOf(E2EPrerequisiteError);
      expect(() => assertPrerequisitesSatisfied(status)).toThrow(E2EPrerequisiteError);
      expect(() => assertPrerequisitesSatisfied(status)).toThrow(
        /unreachable|did not start|recovery/
      );
    });

    it('skips only when E2E_ALLOW_SKIP=1 is explicitly set', async () => {
      process.env.E2E_ALLOW_SKIP = '1';
      expect(skipsAllowed()).toBe(true);

      const status = await evaluatePrerequisites(failing);
      expect(status.ok).toBe(false);
      expect(status.skip).toBe(true);
    });

    it('never swallows a non-prerequisite error, even with the hatch open', async () => {
      process.env.E2E_ALLOW_SKIP = '1';
      await expect(
        evaluatePrerequisites(async () => {
          throw new Error('assertion boom');
        })
      ).rejects.toThrow('assertion boom');
    });
  });
});

/**
 * Regression coverage for the bounded RPC retry policy (#1253): transient
 * failures are retried a finite number of times, but a persistent failure is
 * still surfaced — retrying must never hide an unreachable node.
 */
describe('E2E RPC retry policy (#1253)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to a bounded policy and honours environment overrides', () => {
    const defaults = resolveRpcRetryPolicy({}, {});
    expect(defaults.attempts).toBe(3);
    expect(defaults.baseDelayMs).toBe(250);
    expect(defaults.maxDelayMs).toBe(2000);

    const overridden = resolveRpcRetryPolicy(
      {},
      {
        E2E_RPC_RETRY_ATTEMPTS: '5',
        E2E_RPC_RETRY_BASE_MS: '10',
        E2E_RPC_RETRY_MAX_MS: '40',
      }
    );
    expect(overridden.attempts).toBe(5);
    expect(overridden.baseDelayMs).toBe(10);
    expect(overridden.maxDelayMs).toBe(40);
  });

  it('caps the backoff delay at maxDelayMs', () => {
    const policy = { attempts: 5, baseDelayMs: 100, maxDelayMs: 400, sleep: async () => {} };
    expect(retryDelayMs(0, policy)).toBe(100);
    expect(retryDelayMs(1, policy)).toBe(200);
    expect(retryDelayMs(2, policy)).toBe(400);
    expect(retryDelayMs(9, policy)).toBe(400);
  });

  it('retries transient transport failures and succeeds once the node is healthy', async () => {
    const getHealth = vi
      .spyOn(StellarSdk.rpc.Server.prototype, 'getHealth')
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue({ status: 'healthy' } as any);

    const server = await requireHealthyRpc('http://localhost:8000/soroban/rpc', {
      retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {} },
    });

    expect(server).toBeInstanceOf(StellarSdk.rpc.Server);
    expect(getHealth).toHaveBeenCalledTimes(3);
  });

  it('never hides a persistent RPC failure: it throws after the bounded attempts', async () => {
    const getHealth = vi
      .spyOn(StellarSdk.rpc.Server.prototype, 'getHealth')
      .mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(
      requireHealthyRpc('http://127.0.0.1:1/soroban/rpc', {
        retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {} },
      })
    ).rejects.toThrow(/is unreachable .* after 3 attempts/);

    expect(getHealth).toHaveBeenCalledTimes(3);
  });

  it('does not retry when the policy allows a single attempt', async () => {
    const getHealth = vi
      .spyOn(StellarSdk.rpc.Server.prototype, 'getHealth')
      .mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(
      requireHealthyRpc('http://127.0.0.1:1/soroban/rpc', {
        retry: { attempts: 1, sleep: async () => {} },
      })
    ).rejects.toThrow(/after 1 attempt/);

    expect(getHealth).toHaveBeenCalledTimes(1);
  });
});
