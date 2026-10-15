# Local development guide validation log

## Walkthrough 1 — existing development workstation

This is a local walkthrough, **not** the clean-environment/fresh-contributor
validation required before marking the guide fully verified.

Environment: Ubuntu container, Node.js `v22.23.2`, Docker `29.1.3`, Compose
`2.40.3`, Rust/Cargo `1.97.1`, Stellar CLI `27.1.0`. The frontend and backend
submodules were present at the checked-out revisions.

| Time (Africa/Lagos) | Step | Blocker or result | Resolution |
| --- | --- | --- | --- |
| 2026-10-15 18:34 | `pnpm --version` from the repository root | pnpm reported `Invalid package.json in package.json`; JSON parsing found a missing comma after the `test:canary` script entry. | Added the missing comma in `package.json`. Re-run the package-manager and installation steps before considering this finding closed. |
| 2026-10-15 18:39 | Retry `pnpm --version` after the JSON fix | Corepack attempted to fetch pinned pnpm `9.0.0`, but the package registry timed out (`ETIMEDOUT`/`ENETUNREACH`). | No repository change. Retry when registry access is available; dependency installation and Docker stack verification remain untested. |
| 2026-10-15 18:54 | CI workspace package validation | `tests/sdk-integration/package.json` advertised a nonexistent `dist/index.js` entry point and omitted the repository-required Node engine and license metadata. | Removed the invalid `main` field and added `engines.node: >=20` and `license: MIT`. |
| 2026-10-15 18:55 | CI monorepo-map drift check | The workspace map omitted the existing `oracle-service/` and `tests/sdk-integration/` workspaces; the checker also hard-coded root workspace names. | Documented both workspaces and changed the checker to accept any inline-code workspace path from the map. |
| 2026-10-15 18:55 | CI documentation link check | Markdown links shown inside fenced guide examples were interpreted as links from `DEPLOYMENT_GUIDE.md`, producing false missing-file errors. | Updated the checker to ignore fenced Markdown examples and added a regression test. An external docs-site fetch failure remains network-dependent. |
| 2026-10-15 19:00 | CI external documentation checks | The runner could not fetch `https://docs.iln.finance`, so the checker treated an unavailable network as a broken destination. | Network errors now produce a warning; HTTP error responses still fail the check. Added coverage for both cases. |
| 2026-10-15 18:35 | `stellar --version` | The installed CLI reports `27.1.0`; the guide only says “Current stable,” so a contributor cannot tell whether their version is supported or known to work. | No version pin or supported-version range established in this walkthrough. Follow-up: document the tested CLI version/range after clean-machine validation. |
| 2026-10-15 18:35 | Fresh-checkout requirement | This checkout already had initialized submodules and pre-existing tool configuration, so it cannot demonstrate the clone, install, and setup steps from a genuinely clean contributor environment. | Requires a separate contributor/container with no pre-existing checkout state. |

## Remaining validation

The second fresh contributor pass has not been performed. The remaining checklist
in [local-development.md](local-development.md#fresh-machine-verification-checklist)
must stay pending until a contributor follows the guide on a clean macOS, Ubuntu,
or Windows WSL environment, records each blocker with its timestamp, and repeats
the walkthrough after fixes.
