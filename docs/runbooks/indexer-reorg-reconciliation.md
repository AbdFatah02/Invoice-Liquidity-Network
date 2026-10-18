# Indexer Reorg Reconciliation & Event Idempotency Runbook

Operational guide for indexer chain tip rewind reconciliation, fork replacement persistence, removed event rollback, and idempotent replay handling.

- **Primary Owner**: Indexer Engineering Team (`@abdfatah02`, `@sublime247`)
- **Applies to**: `iln-indexer` (`indexer/src/poller.ts`, `indexer/src/processor.ts`, `indexer/src/db.ts`)
- **Relevant Issues**: #1257, #1258, #1259, #1260, #1262, #1263, #1264

---

## What the Controls Do

### 1. Idempotent Event Application Across Replays (#1260)
- **Problem**: Previously, `insertEvent` could be executed before `fetchInvoice` completed or partial writes occurred during re-scans/crashes, leading to silently skipped updates or inconsistent rows on restart/replay.
- **Control**: Event ingestion and invoice mutation execute inside an atomic SQLite transaction (`applyEventWithInvoice`). If RPC calls fail or the process halts mid-execution, uncommitted events are not persisted, ensuring subsequent replay cleanly retries and succeeds without duplicate mutations.

### 2. Cursor State Reconciliation on Chain Tip Rewinds (#1259)
- **Problem**: When a network reorganization occurs, the latest ledger reported by the RPC node falls below the local indexer cursor.
- **Control**: The poller detects `latestKnownLedger < stored`, bounds the rollback distance to `MAX_REORG_ROLLBACK_LEDGERS` (100 ledgers), rolls the cursor and database state back in-cycle, and re-polls from the rewound ledger. If reorg flapping exceeds `MAX_REORG_RETRIES` (3 attempts), the poller aborts the cycle and increments `iln_reorg_abortions_total` to fail closed rather than spinning in an unbounded loop.

### 3. Persist Fork Replacement Decisions for Restart Safety (#1258)
- **Problem**: Crash or restart during a chain reorganization could leave cursor and event state out of sync without operator-visible audit trails.
- **Control**: On detecting a fork, the indexer records a `fork_decisions` row in SQLite (`status: 'in_progress'`) capturing `from_ledger`, `to_ledger`, and `tip_ledger`. Upon successful rollback and state reconciliation, the row transitions to `status: 'completed'` with counts of removed events and affected invoices. On poller startup, any pending in-progress fork decision is automatically detected and reconciled before polling begins.

### 4. Rollback for Removed Events (#1257)
- **Problem**: Previously, rolling back only deleted entries from `events`, leaving `invoices` rows modified or created by the abandoned fork intact.
- **Control**: In `rollbackToLedger`, all invoices affected by events in `ledger > targetLedger` are inspected. Invoices created exclusively on the abandoned fork are deleted from `invoices`. Invoices with prior canonical history are rolled back to their last valid state (`Pending`, `Funded`, etc.), clearing any funder/funded_at fields that originated on the abandoned fork. Corresponding Redis cache entries are invalidated.

### 5. Detect and Quarantine Incomplete Reorg Recovery (#1262)
- **Problem**: If a node crashes repeatedly during reorg rollback or if database corruption prevents rollback completion, the poller could enter an infinite restart crash loop attempting to reconcile the same broken fork decision.
- **Control**: In-progress fork decisions track `recovery_attempts`. If recovery fails or exceeds `MAX_REORG_RECOVERY_ATTEMPTS` (3), the fork decision is transitioned to `'quarantined'`, inserted into `reorg_quarantine` with reasons and error details, and metrics `iln_reorg_quarantined_total` and `iln_reorg_quarantined_active` are incremented. The poller safe cursor fallback prevents crash loops while fail-closed alerts notify operators.

### 6. Cursor Monotonicity Invariants (#1263)
- **Problem**: Unverified cursor rewinds during regular forward polling could skip confirmed events or introduce silent data loss if an unhandled edge case or RPC payload regressed the cursor.
- **Control**: `setCursorLedger` strictly enforces non-decreasing cursor monotonicity (`new_ledger >= current_ledger`). Direct rewinds outside authorized rollback paths throw a descriptive invariant error and increment `iln_cursor_monotonicity_violations_total`. Rewinds are exclusively authorized through `rollbackToLedger`.

### 7. Property-Based Cursor and Replay Testing (#1264)
- **Problem**: Static test suites may miss adversarial or non-deterministic edge cases across combinations of reorg depths, event interleavings, duplicate payloads, or crash timings.
- **Control**: Comprehensive `fast-check` property tests in `indexer/tests/cursor-property.test.ts` continually prove cursor monotonicity across random increments, replay idempotency across shuffled and duplicated streams, bounded rollback invariants across arbitrary fork depths, and quarantine threshold triggers across failure sequences.

---

## Operational Metrics & Signals

The indexer exports the following Prometheus metrics:

| Metric | Type | Labels | Description |
| --- | --- | --- | --- |
| `iln_reorg_rollbacks_total` | Counter | - | Total number of chain reorganizations detected and rolled back |
| `iln_reorg_abortions_total` | Counter | - | Number of polling cycles aborted due to persistent/unstable reorgs |
| `iln_reorg_removed_events_total` | Counter | - | Total number of contract events removed during reorg rollbacks |
| `iln_reorg_fork_decisions_total` | Counter | `status` (`in_progress`, `completed`, `aborted`, `quarantined`) | Total number of fork replacement decisions recorded |
| `iln_reorg_pending_decisions` | Gauge | - | Count of uncompleted in-progress fork decisions (should be 0 under normal operation) |
| `iln_reorg_quarantined_total` | Counter | - | Total count of corrupted or exhausted reorg recoveries quarantined |
| `iln_reorg_quarantined_active` | Gauge | - | Current count of active quarantined reorg records requiring operator triage |
| `iln_cursor_monotonicity_violations_total` | Counter | - | Count of rejected attempts to violate cursor monotonicity |
| `iln_duplicate_events_total` | Counter | - | Number of duplicate events safely deduplicated during replays |

---

## Operator Recovery Paths

### Alert: `IndexerReorgQuarantined` (`iln_reorg_quarantined_total > 0` or `iln_reorg_quarantined_active > 0`)
1. **Meaning**: A fork replacement recovery encountered repeated crashes or unrecoverable rollback errors and was isolated to prevent an infinite crash loop.
2. **Action**:
   - Inspect quarantined records in the database:
     ```sql
     SELECT * FROM reorg_quarantine ORDER BY id DESC LIMIT 10;
     ```
   - Check the `reason` and `error_details` fields to identify why rollback failed (e.g., SQLite constraint error, filesystem corruption, or invalid target ledger).
   - Validate canonical ledger sequence on Soroban RPC:
     ```bash
     curl -s -X POST -H 'Content-Type: application/json' \
       -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' $SOROBAN_RPC_URL
     ```
   - Once resolved, manually reconcile the cursor or clear the quarantined entry if safe.

### Alert: `IndexerCursorMonotonicityViolation` (`iln_cursor_monotonicity_violations_total > 0`)
1. **Meaning**: A code path attempted to rewind the indexer cursor without an authorized rollback call.
2. **Action**:
   - Inspect poller and application logs for `[DB] Cursor monotonicity violation`.
   - Verify whether a network reorg occurred without invoking `rollbackToLedger`.
   - Ensure external RPC node responses are monotonic and not flapping across stale replicas.

### Alert: `IndexerReorgDidNotStabilise` (`iln_reorg_abortions_total > 0`)
1. **Meaning**: The Soroban RPC node tip has repeatedly rewound or flapped more than 3 times within a single polling cycle.
2. **Action**:
   - Check upstream RPC health and node synchronization status.
   - Verify if an upstream Stellar network fork or node sync issue is in progress.
   - Inspect recent fork decisions in the SQLite database:
     ```sql
     SELECT * FROM fork_decisions ORDER BY id DESC LIMIT 10;
     ```
   - If an RPC provider is partitioned or lagging, switch indexer RPC endpoint in `.env` (`SOROBAN_RPC_URL`).

### Alert: `IndexerPendingForkDecisions` (`iln_reorg_pending_decisions > 0`)
1. **Meaning**: A previous worker run crashed while executing a fork replacement rollback.
2. **Action**:
   - The indexer automatically reconciles pending fork decisions on the next polling cycle.
   - Check indexer logs for:
     `[poller] Recovering pending fork replacement decision #<id> (from <from> to <to>)`
   - Verify that the cursor and invoice states align with the canonical chain.

---

## Automated Verification

Run targeted regression, property, and boundary tests:

```bash
pnpm --filter iln-indexer test tests/quarantine.test.ts tests/cursor-monotonicity.test.ts tests/cursor-property.test.ts tests/reorg-idempotency.test.ts tests/poller.test.ts
```

