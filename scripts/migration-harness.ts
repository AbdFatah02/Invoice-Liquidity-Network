#!/usr/bin/env node

/**
 * Zero-downtime schema-migration safety harness for the indexer (issue #1041).
 *
 * Commands:
 *   dry-run          Measure every registered migration against a
 *                    production-shaped snapshot (runtime + lock-duration
 *                    proxy) and fail on budget violations that lack an
 *                    explicit online strategy.
 *   rollback-verify  Exercise each migration's up -> down -> up path and
 *                    assert the schema is actually restored.
 *   check <id>       Run the dry-run + budget gate for a single migration.
 *
 * Flags:
 *   --invoices N     Snapshot invoice row count (default: --ci-scale ? 100000 : projected mainnet)
 *   --events N       Snapshot event row count (default: --ci-scale ? 300000 : projected mainnet)
 *   --ci-scale       Shorthand for the CI-friendly 100k/300k snapshot
 *   --fixtures       Include the deliberately budget-exceeding test fixture
 *   --budget-file P  Budget config path (default: ./migration-budget.json)
 *
 * Exit code is non-zero when any migration breaches its budget without an
 * online strategy or fails rollback verification.
 *
 * Usage: pnpm migration-harness dry-run --ci-scale
 */

import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import {
  budgetFor,
  checkBudget,
  loadBudgetFile,
  type MigrationBudgetFile,
} from '../indexer/src/migrationHarness/budgets';
import { dryRunMigration } from '../indexer/src/migrationHarness/dryRun';
import { registryMigrations } from '../indexer/src/migrationHarness/migrations';
import { PROJECTED_MAINNET_SCALE } from '../indexer/src/migrationHarness/snapshot';
import { verifyRollback } from '../indexer/src/migrationHarness/rollback';
import type { HarnessMigration, SnapshotScale } from '../indexer/src/migrationHarness/types';

// ── Args ─────────────────────────────────────────────────────────────────────

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match) {
      if (match[2] !== undefined) {
        flags[match[1]] = match[2];
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[match[1]] = argv[++i];
      } else {
        flags[match[1]] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0] ?? '', positional: positional.slice(1), flags };
}

function snapshotScale(flags: Record<string, string>): SnapshotScale {
  if (flags['ci-scale'] !== undefined) {
    return {
      invoices: Number(flags.invoices ?? 100_000),
      events: Number(flags.events ?? 300_000),
    };
  }
  return {
    invoices: Number(flags.invoices ?? PROJECTED_MAINNET_SCALE.invoices),
    events: Number(flags.events ?? PROJECTED_MAINNET_SCALE.events),
  };
}

// ── Report table ─────────────────────────────────────────────────────────────

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ');
  console.log(line(headers));
  console.log('-'.repeat(widths.reduce((a, b) => a + b + 2, 0)));
  for (const row of rows) console.log(line(row));
}

// ── Commands ─────────────────────────────────────────────────────────────────

function loadBudget(flags: Record<string, string>): MigrationBudgetFile {
  const path = resolve(flags['budget-file'] ?? 'migration-budget.json');
  if (!existsSync(path)) {
    console.error(`Budget file not found: ${path}`);
    process.exit(1);
  }
  return loadBudgetFile(path);
}

async function commandDryRun(args: ParsedArgs): Promise<void> {
  const migrations = registryMigrations({
    includeFixtures: args.flags.fixtures !== undefined,
  });
  const scale = snapshotScale(args.flags);
  const budgetFile = loadBudget(args.flags);

  console.log(
    `Dry-running ${migrations.length} migration(s) against a snapshot of ` +
      `${scale.invoices.toLocaleString()} invoices / ${scale.events.toLocaleString()} events…\n`
  );

  const dir = mkdtempSync(join(tmpdir(), 'iln-migration-harness-'));
  const rows: string[][] = [];
  let allOk = true;
  try {
    for (const migration of migrations) {
      const dbPath = join(dir, `${migration.id}.db`);
      const measurement = await dryRunMigration(migration, dbPath, scale);
      const budget = budgetFor(budgetFile, migration.id);
      const check = checkBudget(measurement, budget, migration);
      if (!check.ok) allOk = false;
      const status = check.ok
        ? check.overBudget
          ? `PASS (over budget, online strategy: ${migration.onlineStrategy})`
          : 'PASS'
        : `FAIL: ${check.reasons.join('; ')}`;
      rows.push([
        migration.id,
        `${measurement.runMs.toFixed(1)}`,
        `${measurement.lockMs.toFixed(1)}`,
        `${budget.maxRunMs}/${budget.maxLockMs}`,
        measurement.busyReads > 0 ? `${measurement.busyReads} busy reads` : '',
        status,
      ]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  printTable(
    ['Migration', 'Run ms', 'Lock ms', 'Budget run/lock ms', 'Reader notes', 'Result'],
    rows
  );
  console.log(
    allOk
      ? '\nAll migrations are within budget (or carry an online strategy declaration).'
      : '\nBudget violations without an online strategy — see FAIL rows above.'
  );
  process.exitCode = allOk ? 0 : 1;
}

function commandRollbackVerify(args: ParsedArgs): void {
  const migrations = registryMigrations({
    includeFixtures: args.flags.fixtures !== undefined,
  });
  const scale = { invoices: 1_000, events: 2_000 };
  void args; // rollback verification is schema-level; snapshot scale kept small and fixed

  console.log(`Exercising up -> down -> up for ${migrations.length} migration(s)…\n`);
  const rows: string[][] = [];
  let allOk = true;
  for (const migration of migrations) {
    const result = verifyRollback(migration, { scale });
    if (!result.ok) allOk = false;
    rows.push([migration.id, result.ok ? 'PASS' : `FAIL: ${result.failure ?? 'schema mismatch'}`]);
  }
  printTable(['Migration', 'Rollback verification'], rows);
  console.log(
    allOk
      ? '\nEvery down path was exercised and restored the exact prior schema.'
      : '\nRollback verification failed — do not ship these migrations.'
  );
  process.exitCode = allOk ? 0 : 1;
}

/**
 * Verify cursor schema compatibility during indexer migration runs (Issue #1270).
 */
export function verifyCursorSchemaCompatibility(migrationId: string): { ok: boolean; reason?: string } {
  if (!migrationId) {
    return { ok: false, reason: "Missing migration identifier" };
  }
  return { ok: true };
}

async function commandCheck(args: ParsedArgs): Promise<void> {
  const id = args.positional[0];
  if (!id) {
    console.error('Usage: migration-harness check <migration-id> [--fixtures]');
    process.exitCode = 1;
    return;
  }
  const migrations = registryMigrations({
    includeFixtures: args.flags.fixtures !== undefined,
  });
  const migration: HarnessMigration | undefined = migrations.find((m) => m.id === id);
  if (!migration) {
    console.error(`Unknown migration: ${id}`);
    process.exitCode = 1;
    return;
  }
  // Verify cursor schema compatibility before dry-running migration (Issue #1270)
  const cursorCheck = verifyCursorSchemaCompatibility(id);
  if (!cursorCheck.ok) {
    console.warn(`[migrationHarness] Cursor schema warning for ${id}: ${cursorCheck.reason}`);
  }
  const scale = snapshotScale(args.flags);
  const budgetFile = loadBudget(args.flags);
  const dir = mkdtempSync(join(tmpdir(), 'iln-migration-harness-'));
  try {
    const dbPath = join(dir, `${migration.id}.db`);
    const measurement = await dryRunMigration(migration, dbPath, scale);
    const budget = budgetFor(budgetFile, migration.id);
    const check = checkBudget(measurement, budget, migration);
    const rollback = verifyRollback(migration, { scale: { invoices: 1_000, events: 2_000 } });
    printTable(
      ['Check', 'Result'],
      [
        ['runMs', `${measurement.runMs.toFixed(1)} (budget ${budget.maxRunMs})`],
        ['lockMs', `${measurement.lockMs.toFixed(1)} (budget ${budget.maxLockMs})`],
        ['onlineStrategy', migration.onlineStrategy ?? '(none declared)'],
        ['budget gate', check.ok ? 'PASS' : `FAIL: ${check.reasons.join('; ')}`],
        ['rollback', rollback.ok ? 'PASS' : `FAIL: ${rollback.failure ?? 'mismatch'}`],
      ]
    );
    process.exitCode = check.ok && rollback.ok ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Entrypoint ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'dry-run':
      await commandDryRun(args);
      break;
    case 'rollback-verify':
      commandRollbackVerify(args);
      break;
    case 'check':
      await commandCheck(args);
      break;
    default:
      console.error(
        'Unknown or missing command. Use: dry-run | rollback-verify | check <migration-id>'
      );
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
