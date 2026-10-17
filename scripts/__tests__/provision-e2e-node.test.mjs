import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NodeProvisionError, provisionE2ENode } from '../provision-e2e-node.mjs';

const ready = async () => ({ ready: true, latestLedger: 42, attempts: [] });

describe('provisionE2ENode (#1248)', () => {
  it('idempotently ensures the DR node is running before probing it', async () => {
    let command;
    const result = await provisionE2ENode({
      run: (args) => {
        command = args;
        return { status: 0, stdout: '', stderr: '' };
      },
      wait: ready,
    });
    assert.deepEqual(command, [
      'compose',
      '-f',
      'tests/e2e/docker-compose.yml',
      'up',
      '-d',
      'stellar-quickstart',
    ]);
    assert.equal(result.ready, true);
    assert.equal(result.latestLedger, 42);
  });

  it('fails before readiness when compose cannot provision the node', async () => {
    await assert.rejects(
      provisionE2ENode({ run: () => ({ status: 1, stderr: 'daemon unavailable' }), wait: ready }),
      /daemon unavailable/
    );
  });

  it('uses the explicit restart operation for replay rehearsals', async () => {
    let command;
    const result = await provisionE2ENode({
      restart: true,
      run: (args) => {
        command = args;
        return { status: 0, stdout: '', stderr: '' };
      },
      wait: ready,
    });
    assert.deepEqual(command, [
      'compose',
      '-f',
      'tests/e2e/docker-compose.yml',
      'restart',
      'stellar-quickstart',
    ]);
    assert.equal(result.action, 'restart');
  });

  it('rejects a service-name injection at the input boundary', async () => {
    await assert.rejects(
      provisionE2ENode({
        service: 'stellar-quickstart;down',
        run: () => ({ status: 0 }),
        wait: ready,
      }),
      NodeProvisionError
    );
  });
});
