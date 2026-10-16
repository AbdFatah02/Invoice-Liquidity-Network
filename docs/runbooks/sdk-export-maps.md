# Runbook: SDK Export Map Consistency

**Control:** `scripts/check-sdk-export-maps.mjs`
**CI:** `.github/workflows/sdk-export-maps.yml` (blocking on PRs and pushes to `main`/`dev`, plus a weekly scheduled sweep), the `Validate package.json consistency` job in `ci.yml` (`pnpm check:sdk-export-maps`), and the `Core · test` job (runs the guard's unit tests).
**Evidence artifact:** `sdk-export-maps-report` (JSON, 30-day retention) on every run, plus a one-line job summary.
**Owner:** `@iln/sdk` surface owners (SDK + React package maintainers).
**Origin:** #1210

## What it protects

The three SDK surfaces are resolved through their `exports` maps by three
different resolvers:

| Surface | Package | Resolvers |
|---|---|---|
| `sdk/` | `@iln/sdk` | Node CJS/ESM, bundlers, React Native, TypeScript |
| `packages/sdk/` | `@iln/sdk-next` | Node CJS/ESM, bundlers (browser), TypeScript |
| `packages/react/` | `@iln/react` | Rollup/bundler, Node, TypeScript |

The maps had drifted: `packages/sdk` and `packages/react` listed `types`
**after** their runtime conditions. TypeScript resolves the first matching
condition, so a `types` entry behind `import`/`require` can be shadowed and
consumers silently lose declarations. A future edit could similarly let the
top-level `main`/`module`/`types` fields point at different files than
`exports["."]`, so resolvers that ignore `exports` load a different module.

## Invariants

| Rule | What fails |
|---|---|
| `exports-present` | a surface has no `exports` map, no `"."` entry, or a bare-path `"."` |
| `condition-contract` | `exports["."]` is missing `types`, `import` or `require` |
| `types-first` | an export condition object lists `types` anywhere but first |
| `target-relative` | an export target is not a `./…` path |
| `legacy-field-drift` | top-level `main`/`module`/`types` disagree with the matching `exports["."]` condition |
| `example-specifier` | an example pins `@iln/sdk` to a published version range, or a `file:` specifier resolves to a package that is not `@iln/sdk` |

## Run it locally

```bash
pnpm check:sdk-export-maps                      # human output, exit 1 on findings
node scripts/check-sdk-export-maps.mjs --json=report.json
pnpm test:sdk-export-maps                       # unit tests
```

## When the check fails

1. Open the `sdk-export-maps-report` artifact or the inline `::error`
   annotations. Each finding gives `rule`, `file` and a message.
2. Fix it in the surface manifest named by `file`:
   - `types-first`: move the `"types"` key to the top of that export entry.
   - `condition-contract`: add the missing condition, pointing at the built
     artifact (`./dist/index.d.ts`, `./dist/index.js`, `./dist/index.cjs`).
   - `legacy-field-drift`: make the top-level field equal the corresponding
     `exports["."]` condition.
   - `target-relative`: prefix the target with `./`.
   - `example-specifier`: use `file:../../sdk` (or `workspace:*`) in examples,
     never a version range.
3. Re-run `pnpm check:sdk-export-maps` and `pnpm test:sdk-export-maps` before
   pushing.

## Verifying the control is active

- The weekly scheduled run of **SDK Export Maps** should show green with an
  uploaded `sdk-export-maps-report` whose `summary.total` is `0`.
- `scripts/__tests__/check-sdk-export-maps.test.mjs` includes a test that runs
  the guard against the real repository. Reverting the `types` ordering in
  `packages/sdk/package.json` or `packages/react/package.json` fails
  `Core · test` even if the dedicated workflow is disabled.

## Recovery path

If a bad export map ships, consumers see missing declarations or a
`ERR_PACKAGE_PATH_NOT_EXPORTED` / `Cannot find module` error:

1. Revert the manifest change on `main` (the guard blocks the regression from
   re-landing).
2. Re-release the affected surface (`sdk/` or `packages/sdk/` via their
   release workflows) so the corrected map is republished.
3. File a postmortem if the bad map reached npm — see
   [incident-response.md](../incident-response.md).
