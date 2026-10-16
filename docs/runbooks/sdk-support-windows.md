# Runbook: SDK Versioning and Support Windows

**Control:** `scripts/check-sdk-support-windows.mjs`
**Policy of record:** [docs/sdk-versioning.md](../sdk-versioning.md)
**Manifest:** [docs/sdk-support-windows.json](../sdk-support-windows.json)
**CI:** `.github/workflows/sdk-support-windows.yml` (blocking on PRs and pushes to `main`/`dev`, plus a monthly sweep so expiring windows are caught), the `Validate package.json consistency` job in `ci.yml`, and the `Core · test` job (guard unit tests).
**Evidence artifact:** `sdk-support-windows-report` (JSON, 30-day retention) on every run, plus a one-line job summary.
**Owner:** @iln/sdk, @iln/sdk-next and @iln/react maintainers.
**Origin:** #1211

## What it protects

Every SDK surface must declare a support window. Before this control, a release
could ship a version that no manifest or document claimed to support, and an
expired window would go unnoticed because nothing compared the declared window
to the calendar. The guard makes both failure modes unreachable in CI.

## Invariants

| Rule | What fails |
|---|---|
| `manifest-shape` | `docs/sdk-support-windows.json` is missing/unparseable, has no `surfaces` array, or an entry is missing a required field |
| `surface-coverage` | a surface has no entry, its `directory` is wrong, or the manifest lists an unknown surface |
| `version-drift` | an entry's `version` differs from the surface's `package.json` version |
| `window-validity` | `introduced`/`eol` is not an ISO date, or `eol` is not after `introduced` |
| `support-status` | `status` is unknown, an active surface's window has closed, or an `eol` surface's window is still open |
| `documented` | `docs/sdk-versioning.md` is missing or stops mentioning a surface's package name/version |

The `eol` date is inclusive: a surface is still supported on its final day and
fails the check the following day.

## Run it locally

```bash
pnpm check:sdk-support-windows                    # human output, exit 1 on findings
node scripts/check-sdk-support-windows.mjs --json=report.json
pnpm test:sdk-support-windows                     # unit tests
```

## When the check fails

1. Open the `sdk-support-windows-report` artifact or the inline `::error`
   annotations.
2. Fix the manifest and the docs together:
   - `version-drift`: set `surfaces[].version` to the version in the surface's
     `package.json`.
   - `surface-coverage`: add the missing entry (or remove the unknown one).
   - `support-status`: if a window closed, set `status` to `eol`; if the version
     is still supported, extend `eol`. If a surface was promoted or
     deprecated, update `status` and `eol` together.
   - `documented`: update the table in `docs/sdk-versioning.md`.
3. Run `pnpm check:sdk-support-windows` and `pnpm test:sdk-support-windows`
   before pushing.

## Verifying the control is active

- The monthly scheduled run of **SDK Support Windows** should show green with
  an uploaded report whose `summary.total` is `0` and whose `summary.today` is
  the run date.
- `scripts/__tests__/check-sdk-support-windows.test.mjs` runs the guard against
  the real repository, so reverting a manifest version or deleting the
  versioning docs fails `Core · test` even if the dedicated workflow is
  disabled.

## Recovery path

If a version ships without a declared window:

1. Add or correct the entry in `docs/sdk-support-windows.json` and the row in
   `docs/sdk-versioning.md`, then re-run the guard.
2. Preserve compatibility: do not change another surface's window in the same
   change; declare the new version's window explicitly.
3. If consumers were told the wrong `eol`, announce the correction in
   [`CHANGELOG.md`](../../CHANGELOG.md) and the
   [SDK Migration Guide](../sdk-migration-guide.md).
