# Compliance audit integrity

ILN uses signed hash chains for compliance-relevant off-chain evidence. The
oracle verdict trail covers price inputs, verification decisions, and KYB
outcomes. Notifications use `compliance_audit_chain` to record delivery-log
creation and updates, privacy erasures, and retention sweeps.

Each entry commits to the previous entry hash, a canonical payload, source,
action, subject, and timestamp. Its SHA-256 hash is authenticated with an HMAC.
SQLite triggers reject updates and deletes from the notification chain. A
database editor can still destroy the whole database, so operators must retain
backups and store periodic head hashes outside that database.

## Operator configuration

Set a high-entropy `NOTIFICATIONS_AUDIT_KEY` through the deployment secret
manager. Keep it separate from the database and application backups. Rotation
starts a new operational trust period and must be recorded in the incident or
change-management system with the final head hash from the previous key.

The oracle equivalent is `ORACLE_AUDIT_KEY`; see the oracle audit trail source
and `/v1/audit/integrity` endpoint.

## Auditor verification

Run verification against a read-only copy of the database:

```bash
NOTIFICATIONS_DB_PATH=notifications.sqlite \
NOTIFICATIONS_AUDIT_KEY="$AUDIT_KEY" \
pnpm --filter iln-notifications exec tsx src/audit-cli.ts --verify-integrity
```

Exit code `0` means the chain, content hashes, and signatures all verify. Exit
code `2` reports the first invalid sequence and one of `broken-link`,
`content-hash-mismatch`, or `signature-mismatch`. Record the returned head hash
with the audit evidence. Any failure is a SEV-1 integrity incident and must be
handled through `docs/incident-response.md`.

## Coverage inventory

| Evidence | Tamper-evidence path |
| --- | --- |
| Oracle prices and calculation inputs | `oracle-service` signed audit trail |
| Oracle verdicts and KYB decisions | Same oracle entry; inputs and rationale are signed |
| Notification delivery outcomes | `notification-delivery` chain events |
| Privacy erasure completion | `erasure` chain events |
| Retention deletion and dry runs | `retention` chain events |
| Release actions | Git-tracked `release-audit/log.jsonl` SHA-256 chain; verify with `node scripts/release-audit-log.mjs --verify` |

