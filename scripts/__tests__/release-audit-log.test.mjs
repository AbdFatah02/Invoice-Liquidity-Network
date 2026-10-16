import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAuditEntry,
  serializeEntry,
  appendEntry,
  readEntries,
  verifyEntries,
} from '../release-audit-log.mjs';

describe('buildAuditEntry', () => {
  it('builds a well-formed entry with required fields', () => {
    const entry = buildAuditEntry({
      timestamp: '2026-09-26T00:00:00.000Z',
      actor: 'oashuaib',
      action: 'semantic-release',
      ref: 'abc123',
      outcome: 'success',
      version: '1.3.0',
    });
    assert.deepEqual(entry, {
      timestamp: '2026-09-26T00:00:00.000Z',
      actor: 'oashuaib',
      action: 'semantic-release',
      outcome: 'success',
      ref: 'abc123',
      version: '1.3.0',
    });
  });

  it('defaults timestamp to now when omitted', () => {
    const before = Date.now();
    const entry = buildAuditEntry({ actor: 'a', action: 'x', outcome: 'no-op' });
    const parsed = Date.parse(entry.timestamp);
    assert.ok(parsed >= before);
  });

  it('omits optional fields (ref, version, notes) when not provided', () => {
    const entry = buildAuditEntry({ actor: 'a', action: 'x', outcome: 'no-op' });
    assert.equal('ref' in entry, false);
    assert.equal('version' in entry, false);
    assert.equal('notes' in entry, false);
  });

  it('throws on a missing required field', () => {
    assert.throws(() => buildAuditEntry({ actor: 'a', outcome: 'success' }));
    assert.throws(() => buildAuditEntry({ action: 'x', outcome: 'success' }));
    assert.throws(() => buildAuditEntry({ actor: 'a', action: 'x' }));
  });

  it('throws on an invalid outcome value', () => {
    assert.throws(() => buildAuditEntry({ actor: 'a', action: 'x', outcome: 'maybe' }));
  });
});

describe('serializeEntry / appendEntry / readEntries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-audit-test-'));
  const logPath = join(dir, 'log.jsonl');

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('serializes an entry as a single JSON line', () => {
    const entry = buildAuditEntry({
      timestamp: '2026-09-26T00:00:00.000Z',
      actor: 'a',
      action: 'x',
      outcome: 'success',
    });
    const line = serializeEntry(entry);
    assert.equal(line.includes('\n'), false);
    assert.deepEqual(JSON.parse(line), entry);
  });

  it('appends entries in order and readEntries returns them in order', () => {
    const e1 = buildAuditEntry({ timestamp: 't1', actor: 'a', action: 'x', outcome: 'success' });
    const e2 = buildAuditEntry({ timestamp: 't2', actor: 'a', action: 'y', outcome: 'failure' });
    appendEntry(logPath, e1);
    appendEntry(logPath, e2);

    const entries = readEntries(logPath);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].action, 'x');
    assert.equal(entries[1].action, 'y');
    assert.equal(verifyEntries(entries).valid, true);
  });

  it('detects modified release evidence', () => {
    const entries = readEntries(logPath);
    entries[0].actor = 'forged';
    assert.deepEqual(verifyEntries(entries), {
      valid: false,
      entries: entries.length,
      firstInvalidLine: 1,
      headHash: '0'.repeat(64),
    });
  });

  it('creates the log directory if it does not exist yet', () => {
    const nestedPath = join(dir, 'nested', 'dir', 'log.jsonl');
    appendEntry(nestedPath, buildAuditEntry({ actor: 'a', action: 'x', outcome: 'success' }));
    assert.equal(readEntries(nestedPath).length, 1);
  });

  it('returns an empty array for a log that does not exist yet', () => {
    assert.deepEqual(readEntries(join(dir, 'does-not-exist.jsonl')), []);
  });
});
