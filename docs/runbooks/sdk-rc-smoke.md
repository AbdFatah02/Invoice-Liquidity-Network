# Runbook: SDK Release-Candidate Pack Smoke

**Control:** `scripts/sdk-rc-smoke.mjs`
**Tests:** `scripts/__tests__/sdk-rc-smoke.test.mjs`
**CI:** the `SDK RC pack smoke (#1212)` job in
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) (blocking on PRs and
pushes to `main`/`dev`), plus the `Core · test` job (guard unit tests).
**Evidence artifact:** `sdk-rc-smoke-report` (JSON, uploaded on every run).
**Owner:** @iln/sdk and @iln/sdk-next maintainers.
**Origin:** #1212

## What it protects

Both publishable SDK surfaces (`@iln/sdk` and `@iln/sdk-next`) must ship a
tarball that actually resolves for a consumer. Before this control, a package
could pass every source-level check and still be broken on install because its
`exports` map pointed at files the `files` field never packed.

This was not hypothetical: `@iln/sdk`'s `./legacy` subpath (the compatibility
shim from #1219) advertised `dist/legacy-imports.*`, but the shim was never added
to the tsup build, so the files did not exist in the published tarball. The
smoke reproduces a real `npm install` and catches exactly that class of defect.

## How it works

For each surface the script:

1. builds the package when `dist/` is absent (or `--force-build` is given);
2. runs `npm pack --ignore-scripts` to produce the exact tarball npm would ship;
3. extracts the tarball into a scratch `node_modules`;
4. resolves every `exports` subpath with Node's own CommonJS and ESM resolvers;
5. checks every `types` / `import` / `require` / `default` target is in the pack.

## Invariants

| Rule | What fails |
|---|---|
| `pack-fields` | the tarball has no readable `package.json`, the packed name is not the expected surface, or the packed manifest has no `exports` map |
| `pack-integrity` | an `import`/`require`/`default` export target is not inside the tarball (a `files` field omitting built output) |
| `type-targets` | a `types` export target is not inside the tarball |
| `require-resolve` | Node's CommonJS resolver cannot resolve an export subpath from the extracted package |
| `import-resolve` | Node's ESM resolver cannot resolve the `import` condition for an export subpath |
| `resolve-failed` | the tarball could not be extracted for resolution |

## Run it locally

```bash
pnpm check:sdk-rc-smoke                                  # human output, exit 1 on findings
node scripts/sdk-rc-smoke.mjs --json=rc-smoke-report.json
node scripts/sdk-rc-smoke.mjs --no-build                 # verify already-built dist/
pnpm test:sdk-rc-smoke                                   # guard unit tests
```

Flags: `--root=<dir>` (repository root), `--json=<file>` (write the report),
`--no-build` (skip the build step), `--force-build` (rebuild even when `dist/`
exists), `--work-dir=<dir>` and `--keep` (retain the scratch directory for
debugging). A full run takes a couple of minutes because it builds and packs
both surfaces.

## When the check fails

1. Open the `sdk-rc-smoke-report` artifact. It names the failing package, the
   rule, and the offending export target.
2. Fix the producer, not the smoke:
   - `pack-integrity` / `type-targets`: the built file exists on disk but the
     package's `files` field (or build entry list) omits it. Add the entry to
     the build config so the output is emitted, or widen `files`. Verify with
     `node scripts/sdk-rc-smoke.mjs --force-build`.
   - `require-resolve` / `import-resolve`: the target is packed but the
     `exports` conditions point at the wrong extension/condition. Align the
     export map with the emitted files.
   - `pack-fields`: the package name/version or `exports` map is wrong.
3. Re-run `pnpm check:sdk-rc-smoke` and `pnpm test:sdk-rc-smoke` before pushing.

## Verifying the control is active

- A green `SDK RC pack smoke (#1212)` job shows `sdk-rc-smoke-report` with
  `summary.ok: true` and `summary.total: 0`.
- `scripts/__tests__/sdk-rc-smoke.test.mjs` includes a repository wiring guard
  asserting that `sdk/tsup.config.ts` builds `src/legacy-imports.ts` and that
  `sdk/package.json`'s `./legacy` targets point at `dist/legacy-imports.*`, so
  the #1219 regression cannot silently return.

## Recovery path

If a broken tarball is published:

1. Fix the build/`files`/`exports` mismatch, then cut a patch release.
2. Deprecate the broken version on the registry
   (`npm deprecate "@iln/sdk@<version>" "broken export map; use <version>"`).
3. Record the incident and the corrected version in
   [`CHANGELOG.md`](../../CHANGELOG.md) and the
   [SDK Migration Guide](../sdk-migration-guide.md).
