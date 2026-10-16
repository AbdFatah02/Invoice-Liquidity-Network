# Dependency audit escalation policy

`dependency-audit-escalation.yml` runs daily, on demand, and whenever dependency
manifests change. It saves the registry report, deduplicates tracked findings by
fingerprint, files issues for urgent findings, pages the security on-call for
critical findings, and fails the job when release blocking is required.

| Severity | Automated action | Remediation SLA | Release |
| --- | --- | --- | --- |
| Critical | File/update tracked issue and page security on-call | 4 hours | Blocked |
| High | File/update tracked issue | 24 hours | Blocked |
| Moderate | Include in weekly security review | 7 days | Allowed |
| Low | Include in monthly maintenance review | 30 days | Allowed |

Repository administrators must configure `SECURITY_PAGER_WEBHOOK`. A critical
finding fails escalation if the pager is missing or rejects the event, making a
silent notification failure impossible. The workflow receives only issue-write
permission and the built-in `GITHUB_TOKEN`.

To backfill or rehearse locally, produce a JSON report and run the policy:

```bash
mkdir -p .security
pnpm audit --prod --json > .security/pnpm-audit-workspace.json || true
GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo \
  node scripts/dependency-audit-escalation.js .security/pnpm-audit-workspace.json
```

The command exits `1` for a correctly escalated release-blocking finding and
`2` if automation itself failed. Both stop a release.

## Backfill validation

The 2026-10-16 production-lockfile backfill found 4 critical, 64 high, 37
moderate, and 5 low concrete advisories. The policy classifies the critical and
high groups as release blocking, produces one deduplicated tracking issue per
severity (rather than one issue per transitive path), and sends the four
critical findings in one on-call event. Moderate and low findings remain in the
retained workflow artifact for the scheduled reviews. This baseline is evidence
that escalation is exercised against the existing backlog; it is not an
exception to the release gate.

