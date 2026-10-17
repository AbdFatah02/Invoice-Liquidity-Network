# Indexer Cursor Divergence Operator Recovery Runbook (Issue #1269)

## Overview
This runbook details operational procedures for detecting, diagnosing, and resolving indexer cursor divergence between the ILN indexer SQLite/PostgreSQL database and Soroban on-chain ledger state.

## Detection Signals
- **Alert `IndexerCursorLagHigh`**: `stellar_soroban_latest_ledger - indexer_last_processed_ledger > 100`
- **Alert `StateSnapshotDrift`**: Discrepancy between on-chain contract invoice status and indexer database `invoices.status`.

## Diagnosis Procedure
1. Query current indexer cursor:
   ```bash
   pnpm --filter iln-indexer exec ts-node -e "import { getCursorLedger } from './src/db'; console.log('Cursor:', getCursorLedger());"
   ```
2. Query latest ledger sequence from Soroban RPC:
   ```bash
   curl -s -X POST -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' \
     https://soroban-testnet.stellar.org
   ```

## Recovery Steps
### Option A: Automatic Reorg Rollback
If a chain reorganization occurred, the poller automatically detects `latestLedger < storedCursor` and executes `rollbackToLedger(latestKnownLedger)`.

### Option B: Manual Cursor Reset & Re-sync
1. Pause the indexer process:
   ```bash
   docker-compose stop indexer
   ```
2. Set cursor back to the known good ledger (e.g., 500 ledgers prior):
   ```bash
   pnpm --filter iln-indexer exec ts-node -e "import { setCursorLedger } from './src/db'; setCursorLedger(TARGET_LEDGER);"
   ```
3. Restart indexer and observe catch-up logs:
   ```bash
   docker-compose start indexer
   docker-compose logs -f indexer
   ```
