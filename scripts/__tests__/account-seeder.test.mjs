import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const seedScript = join(repoRoot, 'account-seeder', 'seed.sh');
const roots = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'iln-seeder-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const calls = join(root, 'stellar-calls.log');
  writeFileSync(
    join(bin, 'stellar'),
    `#!/bin/sh\ncase "$1 $2" in\n  'keys address') printf 'G_%s\\n' "$3" ;;\n  'keys show') printf 'S_%s\\n' "$3" ;;\n  'contract asset') printf 'C_MOCK_ASSET\\n' ;;\n  *) printf '%s\\n' "$*" >> '${calls}' ;;\nesac\n`
  );
  chmodSync(join(bin, 'stellar'), 0o755);
  mkdirSync(join(root, '.docker-output'));
  writeFileSync(join(root, '.docker-output', 'contract-id.txt'), 'C_REAL_CONTRACT\n');
  return { root, bin, calls };
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

test('scenario controls create multiple actor groups, invoice history, and funder positions', () => {
  const { root, bin, calls } = fixture();
  const result = spawnSync('bash', [seedScript], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FREELANCER_COUNT: '2',
      PAYER_COUNT: '2',
      FUNDER_COUNT: '2',
      INVOICES_PER_FREELANCER: '2',
      FUNDED_INVOICE_COUNT: '2',
      FIRST_INVOICE_ID: '7',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const accountsJson = readFileSync(join(root, '.docker-output', 'accounts.json'), 'utf8');
  let accounts;
  try {
    accounts = JSON.parse(accountsJson);
  } catch (error) {
    assert.fail(`${error.message}\n${accountsJson}`);
  }
  assert.equal(Object.keys(accounts.freelancers).length, 2);
  assert.equal(Object.keys(accounts.payers).length, 2);
  assert.equal(Object.keys(accounts.funders).length, 2);
  const log = readFileSync(calls, 'utf8');
  assert.equal((log.match(/submit_invoice/g) ?? []).length, 4);
  assert.equal((log.match(/fund_invoice/g) ?? []).length, 2);
  assert.match(log, /--invoice_id 7/);
  assert.match(log, /--invoice_id 8/);
});
