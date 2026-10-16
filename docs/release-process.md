# ILN Release Process

This document describes the process for releasing new versions of the Invoice Liquidity Network protocol across coordinated repositories.

## Overview

ILN releases require coordinating changes across the following repositories and packages:

1. **ILN-Smart-Contract** — Rust/Soroban contracts (deployed to Stellar)
2. **Invoice-Liquidity-Network (SDK)** — `@iln/sdk` (`sdk/`) and `@iln/sdk-next` (`packages/sdk/`)
3. **Invoice-Liquidity-Network (CLI)** — `@invoice-liquidity/cli` (`cli/`)
4. **Invoice-Liquidity-Network (Indexer)** — `@iln/indexer` (`packages/indexer/`)
5. **Invoice-Liquidity-Network (Notifications)** — `@iln/notifications` (`notifications/`)
6. **ILN-Frontend** — Next.js dApp (`ILN-Frontend`)

The correct release order is critical: smart contract deployment must complete before SDK updates, and SDK updates must complete before frontend and dependent service deployments.

## Workflow Relationships

This repository contains four release-related workflows. The following diagram shows what triggers each, what they publish, and how they relate:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Release Workflows                                │
├──────────────────────┬──────────────────────────────────────────────────┤
│ Workflow             │ Trigger / Relationship                           │
├──────────────────────┼──────────────────────────────────────────────────┤
│ coordinate-release   │ workflow_dispatch (manual)                       │
│                      │ Orchestrator — does NOT call the other three     │
│                      │ via workflow_call. Tags repos, polls CI,         │
│                      │ and sends Discord notifications.                 │
├──────────────────────┼──────────────────────────────────────────────────┤
│ release.yml          │ push to main (changesets)                        │
│                      │ Opens "Version Packages" PR; merging it          │
│                      │ publishes ALL packages via changeset publish.    │
│                      │ Independent of coordinate-release.yml.           │
├──────────────────────┼──────────────────────────────────────────────────┤
│ sdk-release.yml      │ push of v* tags OR PR touching packages/sdk/     │
│                      │ Publishes @iln/sdk-next (packages/sdk) to npm    │
│                      │ with provenance; creates GitHub Release.         │
│                      │ Dry-run on PRs. Independent of the other three   │
│                      │ workflows.                                       │
└──────────────────────┴──────────────────────────────────────────────────┘
```

### Sequence Diagram — Automated Release (changesets path)

```
Developer          main branch          release.yml            npm
  │                    │                     │                   │
  │── merge PR ───────>│                     │                   │
  │                    │── push trigger ────>│                   │
  │                    │                     │── detect changesets
  │                    │                     │── open "Version    │
  │                    │                     │   Packages" PR     │
  │                    │<─────────────────── │                   │
  │                    │                     │                   │
  │── merge version PR>│                     │                   │
  │                    │── push trigger ────>│                   │
  │                    │                     │── changeset publish
  │                    │                     │── npm publish ────>│
  │                    │                     │── attest provenance│
```

### Sequence Diagram — Tag-based Release (sdk / scripts)

```
Developer          v* tag              sdk-release.yml         npm
  │                    │                     │                   │
  │── git push tag ───>│                     │                   │
  │                    │── push trigger ────>│                   │
  │                    │                     │── install + build  │
  │                    │                     │── test             │
  │                    │                     │── npm publish ────>│
  │                    │                     │── GitHub Release   │
```

### Sequence Diagram — Cross-Repo Coordinated Release

```
Maintainer       coordinate-release.yml     Smart Contract Repo    SDK Repo       Frontend Repo
  │                      │                         │                 │                │
  │── dispatch(v1.2.0)──>│                         │                 │                │
  │                      │── validate version       │                 │                │
  │                      │── tag v1.2.0 ───────────>│                 │                │
  │                      │── poll CI (≤10 min) ─────│                 │                │
  │                      │── update contract IDs ──────────────────> │                │
  │                      │── run SDK tests ─────────────────────────>│                │
  │                      │── tag sdk-v1.2.0 ────────────────────────>│                │
  │                      │── trigger frontend update ───────────────────────────────> │
  │                      │── poll frontend CI ───────────────────────────────────────│
  │                      │── tag frontend-v1.2.0 ───────────────────────────────────>│
  │                      │── Discord notification                    │                │
```

### Key Observations

- **No `workflow_call` dependencies exist** between the four workflows. Each is independently triggered.
- `coordinate-release.yml` is a **manual orchestrator** — it uses `gh api` and `gh workflow run` to tag repos and trigger CI, but does not invoke `release.yml`, `sdk-release.yml`, or `scripts-release.yml` as callable workflows.
- `release.yml` (changesets) and `sdk-release.yml` (tag-based) can **both publish `@iln/sdk-next`** (packages/sdk) depending on the release path chosen. This is not a bug — they serve different release strategies (changesets workflow vs. manual tag push). However, teams should pick one strategy to avoid duplicate publishes.
- The former `scripts-release.yml` was removed (issue #878): its target, `@iln/scripts` (packages/scripts), is `private: true` and explicitly "not for public installation", so the workflow could never publish and was documentation ahead of reality.

## Release Order

### Phase 1: Smart Contract (ILN-Smart-Contract)

1. Deploy new contract version to Stellar testnet/mainnet
2. Tag the contract repository with the version (e.g., `v1.2.0`)
3. CI verifies deployment and generates new contract IDs

### Phase 2: Shared Packages (Invoice-Liquidity-Network repo)

1. Update contract IDs in SDK based on new deployment
2. Update SDK version if needed
3. Run full SDK test suite (`pnpm test` from package directory)
4. Run CLI tests (`pnpm test` from `cli/` directory)
5. Run indexer tests (`pnpm test` from `packages/indexer/` directory)
6. Run notifications tests (`pnpm test` from `notifications/` directory)
7. Tag releases for each published package

### Phase 3: Frontend (ILN-Frontend)

1. Update SDK dependency in frontend package.json
2. Run frontend CI (build, linting, tests)
3. Tag frontend release

## Automated Release Workflow

The `.github/workflows/coordinate-release.yml` workflow automates this process.

### Triggering a Release

1. Go to the main repository: [Invoice-Liquidity-Network](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network)
2. Navigate to **Actions** → **Coordinate Cross-Repo Release**
3. Click **Run workflow**
4. Fill in the required inputs:
   - **Version**: Semantic version (e.g., `v1.2.0`)
   - **Dry run** (optional): Check to test without making changes
   - **Discord webhook** (optional): Paste webhook URL for notifications

### Workflow Inputs

```yaml
version:
  description: Release version in semantic format (e.g., v1.2.0)
  required: true
  example: v1.2.0

dry_run:
  description: Skip actual tagging, just simulate the process
  required: false
  default: false

discord_webhook:
  description: Discord webhook URL for release notification
  required: false
  example: https://discordapp.com/api/webhooks/...
```

### Workflow Steps

The automated workflow performs these steps in sequence:

1. **Validate version format** — Ensures version follows semantic versioning
2. **Tag smart contract repo** — Creates a git tag in ILN-Smart-Contract
3. **Wait for smart contract CI** — Polls GitHub Actions until deployment completes
4. **Update SDK contract IDs** — Fetches new contract IDs and updates SDK
5. **Run SDK tests** — Verifies SDK still works with new contract IDs
6. **Tag SDK release** — Creates a git tag in Invoice-Liquidity-Network
7. **Update frontend SDK version** — Updates package.json in ILN-Frontend
8. **Wait for frontend CI** — Polls GitHub Actions until frontend CI completes
9. **Tag frontend release** — Creates a git tag in ILN-Frontend
10. **Send Discord notification** — Posts release summary to Discord (optional)

## Manual Release Process (If Workflow Fails)

If the automated workflow encounters issues, you can perform a manual release:

### 1. Smart Contract Release

```bash
# In ILN-Smart-Contract repo
git tag v1.2.0
git push origin v1.2.0

# Wait for CI to complete and verify contract IDs
# Document new contract IDs from CI logs
```

### 2. SDK Release

```bash
# In Invoice-Liquidity-Network repo, sdk/ directory
# Update contract IDs in sdk/src/config.ts or similar
# Update SDK version in sdk/package.json

pnpm install
pnpm test
pnpm build

git add .
git commit -m "chore(sdk): update contract IDs for v1.2.0"
git tag v1.2.0
git push origin main v1.2.0

# Optionally publish to npm
pnpm publish --provenance --access public
```

### 3. CLI Release

```bash
# In Invoice-Liquidity-Network repo, cli/ directory
pnpm install
pnpm test
pnpm build

git add .
git commit -m "chore(cli): update contract IDs for v1.2.0"
git tag v1.2.0
git push origin main v1.2.0

# Optionally publish to npm
pnpm publish --provenance --access public
```

### 4. Indexer Release

```bash
# In Invoice-Liquidity-Network repo, packages/indexer/ directory
pnpm install
pnpm test
pnpm build

git add .
git commit -m "chore(indexer): update contract IDs for v1.2.0"
git tag v1.2.0
git push origin main v1.2.0

# Optionally publish to npm
pnpm publish --provenance --access public
```

### 5. Notifications Release

```bash
# In Invoice-Liquidity-Network repo, notifications/ directory
pnpm install
pnpm test
pnpm build

git add .
git commit -m "chore(notifications): update contract IDs for v1.2.0"
git tag v1.2.0
git push origin main v1.2.0

# Optionally publish to npm
pnpm publish --provenance --access public
```

### 6. Frontend Release

```bash
# In ILN-Frontend repo
# Update SDK dependency
pnpm install @iln/sdk@latest

pnpm test
pnpm build

git add .
git commit -m "chore(frontend): update SDK to v1.2.0"
git tag frontend-v1.2.0
git push origin main frontend-v1.2.0
```

## Dry Run Mode

Use dry-run mode to test the entire workflow without making actual changes:

1. Run the workflow with:
   - **Version**: `v1.2.0`
   - **Dry run**: ✓ (checked)

The workflow will log all steps it would perform but skip tagging and pushing changes.

## Environment Setup

To enable the automated workflow, ensure:

### Repository Secrets

Set these secrets in the main repository settings:

- `GITHUB_TOKEN` — Already available via `secrets.GITHUB_TOKEN`
- `NPM_TOKEN` — npm automation token with publish rights (for npm publish steps)
- No additional secrets required for basic functionality

### Discord Webhook (Optional)

To receive release notifications:

1. Create a Discord server/channel (if not exists)
2. Set up a webhook in Discord channel settings
3. Copy the webhook URL
4. Paste it when running the workflow in the "Discord webhook URL" input

### Cross-Repo Access

The workflow uses the GitHub token to access sibling repositories. Ensure:

- All three repositories are in the same organization
- The token has sufficient permissions (typically default for same-org workflows)

## Rollback

If a release fails or needs to be rolled back:

### Delete tags (if incorrectly tagged)

```bash
git tag -d v1.2.0
git push origin --delete v1.2.0
```

### Revert SDK/Frontend changes

```bash
# If you need to revert to previous SDK version in frontend
pnpm install @iln/sdk@<previous-version>
git add package.json package-lock.json
git commit -m "chore: revert SDK to previous version"
git push origin main
```

## Troubleshooting

### Workflow timeout

- The workflow waits up to 10 minutes for dependent CI to complete
- If CI is slow, extend the polling interval in the workflow file

### Contract ID updates not reflected

- Verify that contract IDs are correctly exported from smart contract CI
- Check that SDK files are updated in the correct locations (typically `sdk/src/config.ts` or similar)

### Frontend dependency resolution fails

- Check that SDK package.json version is published to npm before frontend tries to install
- Manually run `pnpm install` in frontend after SDK release tag is created

### Discord notification fails

- Verify webhook URL is correct
- Check Discord channel permissions for the webhook
- If webhook is invalid, the workflow will continue but log a warning

## Manual Triggers (`workflow_dispatch`)

All deploy and release workflows support manual triggering from the GitHub UI:

| Workflow | Has `workflow_dispatch` | Inputs |
| -------- | ---------------------- | ------ |
| `deploy.yml` | Yes | `network` (testnet/mainnet), `dry_run` |
| `docs-deploy.yml` | Yes | None |
| `coordinate-release.yml` | Yes | `version`, `dry_run`, `discord_webhook` |
| `release.yml` | Yes | None (triggers changeset flow) |
| `sdk-release.yml` | Yes | None (requires `v*` tag ref) |

### When to use manual triggers

- **Re-deploy docs** after a failed automatic deployment: run `docs-deploy.yml` → "Run workflow".
- **Re-cut a release** after a failed publish: run `release.yml` → "Run workflow" on `main`, or push a new tag for `sdk-release.yml`.
- **Dry-run a cross-repo release**: run `coordinate-release.yml` with `dry_run: true`.

## Future Improvements

Potential enhancements to the release process:

- [ ] Automated changelog generation based on commits since last release
- [ ] Automatic npm publish after SDK tag creation
- [ ] Slack notification alternative to Discord
- [ ] Release notes template population
- [ ] Mainnet vs testnet release coordination
- [ ] Automated frontend deploy to staging/production

## Package Provenance Verification (issue #878)

### Audit result

Every npm publish path in this repository was audited on 2026-08-26 for
provenance attestation (`--provenance` / OIDC-based publishing), and the
verification steps below were recorded as evidence for the mainnet launch
checklist ("Release provenance verified").

| Publish path | Workflow | Provenance configured? | Package published? |
|---|---|---|---|
| `packages/sdk` → `@iln/sdk-next` | `sdk-release.yml` (tag `v*`) | ✅ `pnpm publish --provenance`, `id-token: write`, `NPM_CONFIG_PROVENANCE=true` | Not yet (first release pending) |
| `packages/sdk` → `@iln/sdk-next` | `release.yml` (changesets) | ✅ `NPM_CONFIG_PROVENANCE=true`, `id-token: write` | Not yet |
| `packages/scripts` → `@iln/scripts` | ~~`scripts-release.yml`~~ | Removed (package is private; see below) | n/a |

Findings and fixes:

1. **Provenance flags were already correct** in `sdk-release.yml` and
   `release.yml` — the `--provenance` flag, `NPM_CONFIG_PROVENANCE=true`, and
   the `id-token: write` permission are the three pieces GitHub Actions
   OIDC-based publishing needs, and all are present.
2. **Stale package name.** `sdk-release.yml` documented `@iln/sdk`, but
   `packages/sdk` was renamed to `@iln/sdk-next` during the packages
   consolidation. The workflow header now matches the package it publishes.
3. **Dead workflow removed.** `scripts-release.yml` targeted `@iln/scripts`,
   which is `private: true` and described as "not for public installation" —
   `npm publish` refuses private packages, so the workflow could never
   succeed. It was removed; nothing publishes `@iln/scripts`.
4. **Nothing is published to npm yet** — every candidate package name returns
   404 on the registry and there are no release tags. The provenance claim in
   docs/security-guide.md was documentation ahead of reality; it now states
   the configuration status and the procedure, not an achieved publication.

### How to verify a published package's provenance (per release)

Once a package is published, verify the attestation before announcing it:

```bash
# 1. The npm registry's attestations endpoint answers for the published version:
curl -s https://registry.npmjs.org/-/npm/v1/attestations/@iln/sdk-next@<version> | jq

# 2. Or check the version metadata carries a provenance field:
npm view @iln/sdk-next@<version> --json | jq '.provenance'

# 3. Or verify the tarball against the repo's GitHub Actions run:
github_token=... gh attestation verify \
  "$(npm pack @iln/sdk-next@<version> --silent)" \
  --repo Invoice-Liquidity-Network/Invoice-Liquidity-Network
```

A passing verification links the tarball to the exact GitHub Actions workflow
run and commit SHA that built it (SLSA Level 3).

## NPM Scope Ownership and Publishing Policy

### Registered Scopes

The project publishes npm packages under two scopes:

| Scope | Owner | 2FA Required |
|---|---|---|
| `@iln` | Invoice Liquidity Network maintainers | Yes |
| `@invoice-liquidity` | Invoice Liquidity Network maintainers | Yes |

Both scopes must be registered under the project's control. **Maintainers must
verify scope ownership and 2FA on the publishing account before any publish
workflow runs.** Unclaimed or poorly-controlled scopes create a
dependency-confusion/typosquatting risk.

### Unpublished-but-referenced Packages

The following internal packages are referenced in the monorepo but are not yet
published to npm. They MUST NOT be installed from npm by external consumers;
they resolve from the workspace instead.

| Local Name | Published Name | Status |
|---|---|---|
| `packages/test-utils` | `@iln/test-utils` | Unpublished |
| `packages/scripts` | `@iln/scripts` | Unpublished |
| `packages/sdk` | `@iln/sdk-next` | Unpublished |
| `packages/mock-backend` | `@iln/mock-backend` | Unpublished |
| `packages/indexer` | `@iln/indexer` | Unpublished |
| `packages/eslint-config` | `@iln/eslint-config` | Unpublished |
| `packages/upgrade-tests` | `@iln/upgrade-tests` | Unpublished |
| `packages/shared` | `@iln/shared` | Unpublished |
| `packages/react` | `@iln/react` | Unpublished |
| `packages/opentelemetry` | `@iln/opentelemetry` | Unpublished |
| `packages/sdk` | `@iln/sdk-next` | Publishable via `sdk-release.yml` / changesets (`release.yml`); not yet published |
| `cli/` | `@invoice-liquidity/cli` | Unpublished |
| `docs/` | `@invoice-liquidity/docs` | Unpublished |
| `indexer/` | `iln-indexer` | Unpublished |
| `notifications/` | `iln-notifications` | Unpublished |

> **Action required:** Add a placeholders publish task to reserve these names
> if the project's standard practice is to prevent squatting. Coordinate with a
> maintainer who has npm registry access.

### Verification Checklist (per release)

1. Confirm `@iln` and `@invoice-liquidity` scopes are owned by the project org.
2. Confirm the npm automation token used in CI has `2FA-required` publish access.
3. Review the unpublished-but-referenced table above and reserve any new names
   before they appear in a public release.
