#!/usr/bin/env node
/** Idempotent local Stellar node provisioning for E2E and DR rehearsals (#1248). */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { waitForStellarRpc } from './wait-for-stellar-rpc.mjs';

export class NodeProvisionError extends Error {}

export async function provisionE2ENode(options = {}) {
  const {
    composeFile = 'tests/e2e/docker-compose.yml',
    service = 'stellar-quickstart',
    restart = false,
    rpcUrl = 'http://localhost:8000/soroban/rpc',
    run = (args) => spawnSync('docker', args, { encoding: 'utf8' }),
    wait = waitForStellarRpc,
  } = options;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(service)) {
    throw new NodeProvisionError(`Invalid compose service name: ${service}`);
  }
  const command = ['compose', '-f', composeFile, restart ? 'restart' : 'up'];
  if (!restart) command.push('-d');
  command.push(service);
  const result = run(command);
  if (result.status !== 0) {
    throw new NodeProvisionError(
      `docker ${command.join(' ')} failed (${result.status}): ` +
        `${(result.stderr || result.stdout || '').trim()}`
    );
  }
  const readiness = await wait({ url: rpcUrl });
  return {
    control: 'e2e-dr-node-provisioning',
    owner: 'E2E maintainers',
    action: restart ? 'restart' : 'ensure-running',
    composeFile,
    service,
    ready: readiness.ready,
    latestLedger: readiness.latestLedger,
    readiness,
  };
}

function args(argv) {
  const options = { evidence: '.artifacts/e2e-node-provisioning.json', restart: false };
  for (const arg of argv) {
    if (arg === '--restart') options.restart = true;
    else if (arg.startsWith('--evidence=')) options.evidence = arg.slice(11);
    else if (arg.startsWith('--compose-file=')) options.composeFile = arg.slice(15);
    else if (arg.startsWith('--service=')) options.service = arg.slice(10);
    else if (arg.startsWith('--rpc-url=')) options.rpcUrl = arg.slice(10);
    else throw new NodeProvisionError(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = args(process.argv.slice(2));
  const output = resolve(options.evidence);
  try {
    const evidence = await provisionE2ENode(options);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`[e2e-node] ${evidence.action} succeeded at ledger ${evidence.latestLedger}`);
  } catch (error) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(
      output,
      `${JSON.stringify(
        {
          control: 'e2e-dr-node-provisioning',
          owner: 'E2E maintainers',
          ready: false,
          error: error.message,
          recovery: 'docker compose -f tests/e2e/docker-compose.yml logs stellar-quickstart',
        },
        null,
        2
      )}\n`
    );
    console.error(`[e2e-node] ${error.message}`);
    console.error(
      '[e2e-node] recovery: docker compose -f tests/e2e/docker-compose.yml logs ' +
        'stellar-quickstart'
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('provision-e2e-node.mjs')) await main();
