# Runbook: @iln/react Peer-Dependency Contract

**Control:** `scripts/check-react-peer-contract.mjs`
**Tests:** `scripts/__tests__/check-react-peer-contract.test.mjs`
**Policy of record:** [docs/sdk-versioning.md](../sdk-versioning.md) ("Compatibility guarantees")
**CI:** `.github/workflows/react-peer-contract.yml` (blocking on PRs and pushes
to `main`/`dev`), the `Validate package.json consistency` job in `ci.yml`, and
the `Core · test` job (guard unit tests).
**Evidence artifact:** `react-peer-contract-report` (JSON, 30-day retention) on
every run, plus a one-line job summary.
**Owner:** @iln/react maintainers.
**Origin:** #1213

## What it protects

`@iln/react` runs inside a host React application. React, the React Query
runtime and the ILN SDK must be supplied by the host and never bundled into the
published build — otherwise consumers get two copies of React (broken hooks) or
a private SDK copy that ignores their configuration. The peer ranges are also
the documented compatibility contract, so the manifest, the bundler config and
the docs have to move together.

## Invariants

| Rule | What fails |
|---|---|
| `contract-shape` | `packages/react/package.json` is missing/unparseable, has no `peerDependencies` object, or no `engines.node` range |
| `peer-missing` | one of `react`, `@tanstack/react-query`, `@iln/sdk` is not a peer dependency |
| `peer-range` | a peer range differs from the contract (`react@^19.0.0`, `@tanstack/react-query@^5.62.0`, `@iln/sdk@^0.1.0`) |
| `sdk-version-drift` | the `@iln/sdk` peer range no longer admits the version in `sdk/package.json` |
| `peer-bundled` | a peer is not listed in the rollup config's `external` array |
| `dev-mirror` | a peer is missing from `devDependencies`, so the package cannot build or test in-repo |
| `node-engine` | `engines.node` does not require Node 20 or newer |
| `documented` | `docs/sdk-versioning.md` stops stating the contract, or `docs/SDK_COMPATIBILITY_MATRIX.md` contradicts it |

## Run it locally

```bash
pnpm check:react-peer-contract                    # human output, exit 1 on findings
node scripts/check-react-peer-contract.mjs --json=react-peer-contract-report.json
pnpm test:react-peer-contract                     # unit tests
```

## When the check fails

1. Open the `react-peer-contract-report` artifact or the inline output.
2. Fix the source of truth and everything that mirrors it:
   - `peer-range` / `peer-missing`: update `peerDependencies` in
     `packages/react/package.json` to the contracted range. Only change the
     contract itself (the `PEER_CONTRACT` constant and
     `docs/sdk-versioning.md`) when a coordinated, announced upgrade is
     intended.
   - `sdk-version-drift`: widen the `@iln/sdk` peer range (e.g. `^0.2.0`) and
     update `docs/sdk-versioning.md` and `docs/SDK_COMPATIBILITY_MATRIX.md` in
     the same change.
   - `peer-bundled`: add the peer to the `external` array in
     `packages/react/rollup.config.js` so it is never bundled.
   - `dev-mirror`: add the peer to `devDependencies` so CI can build and test
     the package.
   - `documented`: update `docs/sdk-versioning.md` and/or
     `docs/SDK_COMPATIBILITY_MATRIX.md` to match the manifest.
3. Re-run `pnpm check:react-peer-contract` and `pnpm test:react-peer-contract`
   before pushing.

## Verifying the control is active

- A green **React Peer Contract** workflow shows `react-peer-contract-report`
  with `summary.ok: true` and `summary.total: 0`.
- `scripts/__tests__/check-react-peer-contract.test.mjs` runs the guard against
  the real repository, so reintroducing the exact `@iln/sdk` peer range or
  dropping a peer fails the `Core · test` (and dedicated) jobs.

## Recovery path

If a published `@iln/react` bundle inlined a peer or declared the wrong range:

1. Correct the manifest and rollup config, then cut a patch release.
2. Deprecate the bad version
   (`npm deprecate "@iln/react@<version>" "bundled peer; use <version>"`).
3. Note the correction in [`CHANGELOG.md`](../../CHANGELOG.md) and the
   [SDK Migration Guide](../sdk-migration-guide.md).
