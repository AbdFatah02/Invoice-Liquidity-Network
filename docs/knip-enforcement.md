# Knip dead-code enforcement

`pnpm dead-code:check` runs the full workspace Knip analysis in the required
`Dead Code Check / knip` pull-request check. The accepted baseline is zero
unexplained findings.

Every finding must be resolved in one of two ways:

1. Remove the unused file, dependency, or export.
2. Add the narrowest possible `knip.json` exception with a nearby comment that
   names the external or dynamic consumer and explains why static analysis
   cannot see it.

Broad wildcard exceptions and undocumented additions are review failures. The
CI check runs Knip without `--no-exit-code`, so any newly flagged export fails
the pull request and prevents the backlog from regrowing.

## 2026-10-16 export baseline resolution

The full export scan reported 12 symbols. Eleven had no repository or supported
package consumer and were removed: `setAnalyticsDb`, `queryEventsForExport`,
`sloErrorBudgetBurn`, `observeCost`, `isProviderHealthy`, `stopHealthChecks`,
`escapeAttribute`, and the redundant barrel exports for `buildDigestSubject`,
`escapeAttribute`, `formatDate`, and `shortAddress`.

`disputeKeys` remains public because React SDK consumers need stable query keys
for direct cache invalidation. It has a narrow `@public` annotation on both the
definition and package-barrel export. `knip --include exports` now reports zero
unresolved exports.

