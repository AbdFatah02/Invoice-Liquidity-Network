# Runbook: Canonical SDK Package Names

**Control:** `scripts/check-sdk-package-names.mjs`
**CI:** `.github/workflows/sdk-package-names.yml` (blocking on PRs and pushes to `main`/`dev`, plus a weekly scheduled sweep) and the `Core · test` job in `ci.yml` (runs the guard's unit tests).
**Evidence artifact:** `sdk-package-names-report` (JSON, 30-day retention) on every run, plus a one-line job summary.
**Origin:** #1218

## Canonical names

| Directory | Package | Status |
|---|---|---|
| `sdk/` | `@iln/sdk` | Stable, production SDK, published to npm |
| `packages/sdk/` | `@iln/sdk-next` | Experimental browser-first rewrite |
| — | `@invoice-liquidity/sdk` <!-- sdk-name-check: allow-legacy --> | **Retired.** No workspace package has this name. |

The retired name used to show up in install snippets, imports, `pnpm --filter`
targets, rollup `external` lists and example manifests. Each of those either
resolved to nothing or to the wrong thing:

- `pnpm --filter <retired name> test:e2e-local` matches zero projects, and pnpm
  exits 0, so `sdk-e2e-local-node.yml` passed without running a single test.
- `@iln/react`'s rollup config marked the retired name as external, so the real
  `@iln/sdk` import was never excluded by that entry (it only stayed external
  because `rollup-plugin-peer-deps-external` caught it as a peer).
- `@iln/react` also listed `@iln/sdk` in both `dependencies` and
  `peerDependencies`, which can install a second SDK copy next to the host
  app's (separate `ILNError` classes break `instanceof`, separate caches).
- Docs told integrators to `npm install` a package this repository does not
  release.

## Rules

| Rule | What fails |
|---|---|
| `manifest-name` | `sdk/package.json` or `packages/sdk/package.json` is missing or not named canonically |
| `legacy-dependency` | any `package.json` depends on a retired name |
| `path-mismatch` | a `file:`/`link:` dependency points at an SDK directory under a different name |
| `dual-declaration` | the SDK is in both `dependencies` and `peerDependencies` |
| `peer-range` | an SDK `peerDependencies` range rejects the SDK's current version |
| `legacy-reference` | a `.md/.mdx/.ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.json/.yml/.yaml` file mentions a retired name |
| `table-mismatch` | a markdown row `` | `sdk/` | `@name` | `` names the wrong package for that directory |

Not scanned: `node_modules`, `dist`, `build`, `coverage`, `.next`, `.turbo`,
`target`, `__fixtures__`, any `CHANGELOG.md`, `history/`, `release-audit/`,
`pnpm-lock.yaml`, and the guard and its tests.

## Run it locally

```bash
pnpm check:sdk-package-names                  # human output, exit 1 on findings
node scripts/check-sdk-package-names.mjs --json=report.json
pnpm test:sdk-package-names                   # unit tests
```

## When the check fails

1. Open the `sdk-package-names-report` artifact or the inline `::error`
   annotations. Each finding gives `rule`, `file`, `line` and a message.
2. Fix it:
   - `legacy-reference` / `legacy-dependency`: replace the retired name with
     `@iln/sdk`, or `@iln/sdk-next` if the code targets `packages/sdk/`.
   - `path-mismatch`: rename the dependency key to the name the target
     directory publishes.
   - `dual-declaration`: keep the SDK as a peer, and add it to
     `devDependencies` (`workspace:*`) for local builds.
   - `peer-range`: widen the range (e.g. `^0.1.0`) to include the version in
     `sdk/package.json`.
   - `table-mismatch`: correct the package-name cell.
3. If a mention of the retired name is needed on purpose (a migration
   note or a dependency-confusion inventory), add the pragma
   `sdk-name-check: allow-legacy` to that same line, inside a comment
   (`<!-- … -->` in markdown, `// …` in code). The pragma covers only that
   one line.

## Verifying the control is active

- The weekly scheduled run of **SDK Package Names** should show green with an
  uploaded `sdk-package-names-report` whose `summary.total` is `0`.
- `scripts/__tests__/check-sdk-package-names.test.mjs` includes a test that
  runs the guard against the real repository. A regression fails `Core · test`
  even if the dedicated workflow is disabled.

## npm registry follow-up (outside this repo)

The retired scope name should stay owned by the org to block
dependency-confusion squatting (see
[dependency-confusion-audit.md](../dependency-confusion-audit.md)). If any
version was ever published under it, a maintainer with publish rights should
run:

```bash
npm deprecate "@invoice-liquidity/sdk@*" "Renamed to @iln/sdk — npm install @iln/sdk" # sdk-name-check: allow-legacy
```

`ILN-Frontend` (the `sync:frontend` repo) should run the same search for the
retired name in its `package.json` and imports and switch to `@iln/sdk`. The
exports are unchanged, so only the specifier changes.
