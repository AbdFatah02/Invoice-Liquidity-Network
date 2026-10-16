#!/usr/bin/env node

/**
 * release-audit-log.mjs
 *
 * Closes part of issue #1096: an append-only, git-tracked audit trail of
 * every release action taken (who/what/when), for post-release review.
 *
 * Log location: release-audit/log.jsonl (one JSON object per line, oldest
 * first). Kept outside docs/ so it is never picked up by the docs site build,
 * and outside history/ so it can't collide with Upptime's auto-generated
 * uptime history in that directory.
 *
 * Usage:
 *   node scripts/release-audit-log.mjs \
 *     --action <release.yml|semantic-release|manual-recovery|...> \
 *     --actor <github-username-or-local-user> \
 *     --ref <git-sha-or-tag> \
 *     --outcome <success|failure|no-op> \
 *     [--notes "free-text detail"] \
 *     [--version "1.3.0"] \
 *     [--log-path release-audit/log.jsonl]
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

export const DEFAULT_LOG_PATH = join(REPO_ROOT, 'release-audit', 'log.jsonl');

const VALID_OUTCOMES = new Set(['success', 'failure', 'no-op']);
const GENESIS_HASH = '0'.repeat(64);

function hashEntry(previousHash, entry) {
  return createHash('sha256')
    .update(`${previousHash}:${JSON.stringify(entry)}`)
    .digest('hex');
}

/**
 * Builds the audit entry object. Pure — no I/O, no clock ambiguity once a
 * `timestamp` is supplied, so this is fully unit-testable.
 */
export function buildAuditEntry({ timestamp, actor, action, ref, outcome, version, notes }) {
  if (!action) throw new Error('buildAuditEntry: "action" is required');
  if (!actor) throw new Error('buildAuditEntry: "actor" is required');
  if (!outcome) throw new Error('buildAuditEntry: "outcome" is required');
  if (!VALID_OUTCOMES.has(outcome)) {
    throw new Error(`buildAuditEntry: "outcome" must be one of ${[...VALID_OUTCOMES].join(', ')}`);
  }

  const entry = {
    timestamp: timestamp ?? new Date().toISOString(),
    actor,
    action,
    outcome,
  };
  if (ref) entry.ref = ref;
  if (version) entry.version = version;
  if (notes) entry.notes = notes;
  return entry;
}

/** Serializes an entry to a single JSONL line (no trailing content). */
export function serializeEntry(entry) {
  return JSON.stringify(entry);
}

/** Appends a single entry to the JSONL log at `logPath`, creating it (and its directory) if needed. */
export function appendEntry(logPath, entry) {
  mkdirSync(dirname(logPath), { recursive: true });
  const existing = readEntries(logPath);
  const previousHash = existing.at(-1)?.hash ?? GENESIS_HASH;
  const chained = { ...entry, previousHash };
  chained.hash = hashEntry(previousHash, chained);
  appendFileSync(logPath, serializeEntry(chained) + '\n', 'utf8');
  return chained;
}

/** Reads and parses every entry currently in the log (used by tests and by report tooling). */
export function readEntries(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

export function verifyEntries(entries) {
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < entries.length; index += 1) {
    const { hash, ...content } = entries[index];
    const expected = hashEntry(previousHash, content);
    if (content.previousHash !== previousHash || hash !== expected) {
      return {
        valid: false,
        entries: entries.length,
        firstInvalidLine: index + 1,
        headHash: previousHash,
      };
    }
    previousHash = hash;
  }
  return { valid: true, entries: entries.length, headHash: previousHash };
}

function detectActor() {
  return (
    process.env.GITHUB_ACTOR ||
    process.env.USER ||
    (() => {
      try {
        return execSync('git config user.name', { cwd: REPO_ROOT }).toString().trim() || 'unknown';
      } catch {
        return 'unknown';
      }
    })()
  );
}

function getArg(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const logPath = resolve(REPO_ROOT, getArg(args, '--log-path') ?? DEFAULT_LOG_PATH);

  if (args.includes('--verify')) {
    const result = verifyEntries(readEntries(logPath));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.valid ? 0 : 2;
    return;
  }

  const entry = buildAuditEntry({
    actor: getArg(args, '--actor') ?? detectActor(),
    action: getArg(args, '--action'),
    ref: getArg(args, '--ref') ?? process.env.GITHUB_SHA,
    outcome: getArg(args, '--outcome'),
    version: getArg(args, '--version'),
    notes: getArg(args, '--notes'),
  });

  appendEntry(logPath, entry);
  console.log(`Logged release action: ${JSON.stringify(entry)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
