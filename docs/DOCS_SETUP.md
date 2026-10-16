# Docs Setup and Migration Guide

This file covers two things:
1. **Migration checklist** — tracking progress from `docs/` (Nextra 2) to
   `packages/docs/` (Nextra 3 / App Router), which is the canonical deployed site.
2. **Developer setup** — how to run each site locally and how CI/deploy works.

---

## Canonical vs. legacy sites at a glance

| | `docs/` | `packages/docs/` |
|---|---|---|
| Package name | `@invoice-liquidity/docs` | `@invoice-liquidity/docs-next` |
| Framework | Nextra 2, Next.js 14, Pages Router | Nextra 3, Next.js 15, App Router |
| Deployed? | **No** | **Yes — docs.iln.finance** |
| CNAME | — | `docs.iln.finance` |
| Built by CI | `docs-deploy.yml` triggers build validation | `docs-deploy.yml` builds & deploys `packages/docs/dist` |
| Changelog target | `docs/changelog.md` (auto-committed by `docs-changelog.yml`) | — |
| Content source | `docs/*.md` | `packages/docs/content/*.mdx` |

---

## Migration checklist

Track porting each content section from `docs/` to `packages/docs/content/`.
Check a box once the `.mdx` file exists in `packages/docs/content/` and the
page renders correctly on the deployed site.

### Infrastructure

- [x] Protocol overview (`docs/protocol-overview.md` → `packages/docs/content/protocol-overview.mdx`)
- [x] Smart contract architecture (`docs/architecture.md` → `packages/docs/content/smart-contracts/architecture.mdx`)
- [x] Invoice lifecycle (`docs/contracts/invoice-contract.md` → `packages/docs/content/smart-contracts/invoice-lifecycle.mdx`)
- [x] SDK installation (`docs/sdk-quickstart.md` → `packages/docs/content/sdk-reference/installation.mdx`)
- [x] SDK API reference (`docs/sdk-api-reference.md` → `packages/docs/content/sdk-reference/api-reference.mdx`)
- [x] Governance (`docs/governance-guide.md` → `packages/docs/content/governance/index.mdx`)
- [x] Tutorials — first invoice (`docs/tutorials/first-invoice.md` → `packages/docs/content/tutorials/first-invoice.mdx`)
- [x] Tutorials — LP funding (`docs/tutorials/lp-funding.md` → `packages/docs/content/tutorials/lp-funding.mdx`)
- [x] Frontend integration guide (`docs/integration-guide.md` → `packages/docs/content/frontend-guide/integration.mdx`)
- [x] Horizon API reference (`docs/api-collection.md` → `packages/docs/content/api-reference/horizon.mdx`)
- [x] Notifications API (`docs/notifications.md` → `packages/docs/content/api-reference/notifications.mdx`)
- [x] Soroban RPC reference (`docs/indexer/api-reference.md` → `packages/docs/content/api-reference/soroban-rpc.mdx`)

### Remaining content to port

> **Package names when porting:** use `@iln/sdk` for the stable SDK (`sdk/`)
> and `@iln/sdk-next` for `packages/sdk/`. `packages/docs/content/` is
> scanned by `scripts/check-sdk-package-names.mjs`, so a retired name in a
> ported page fails CI. The SDK pages below (migration guide, E2E, trust
> model, sdk-next notes) were already migrated to the canonical names in
> #1218 and can be ported as-is. See
> [runbooks/sdk-package-names.md](runbooks/sdk-package-names.md).

- [ ] Local development guide (`docs/local-development.md`)
- [ ] CI/CD reference (`docs/ci-cd.md`)
- [ ] Security guide (`docs/security-guide.md`)
- [ ] Threat model (`docs/threat-model.md`)
- [ ] Glossary (`docs/glossary.md`)
- [ ] Changelog page (`docs/changelog.md`)
- [ ] SDK migration guide (`docs/sdk-migration-guide.md`)
- [ ] SDK E2E testing guide (`docs/sdk-e2e.md`)
- [ ] SDK trust model (`docs/sdk-trust-model.md`)
- [ ] SDK next migration notes (`docs/sdk-next-migration.md`)
- [ ] Release process (`docs/release-process.md`)
- [ ] RFC process (`docs/rfc-process.md`)
- [ ] DeFi integrations (`docs/defi-integrations.md`)
- [ ] Protocol economics (`docs/protocol-economics.md`)
- [ ] Stellar primer (`docs/stellar-primer.md`)
- [ ] Multi-token support (`docs/tokens/multi-token-support.md`)
- [ ] Reputation overview (`docs/reputation/overview.md`)
- [ ] Indexer architecture (`docs/indexer/architecture.md`)
- [ ] Indexer configuration (`docs/indexer/configuration.md`)
- [ ] Indexer deployment (`docs/indexer/deployment.md`)
- [ ] Indexer troubleshooting (`docs/indexer/troubleshooting.md`)
- [ ] Contract governance (`docs/contracts/governance-contract.md`)
- [ ] Contract reputation (`docs/contracts/reputation-contract.md`)
- [ ] Mainnet launch checklist (`docs/mainnet-launch-checklist.md`)
- [ ] Troubleshooting guide (`docs/troubleshooting.md`)
- [ ] Analytics (`docs/analytics.md`)
- [ ] Privacy policy (`docs/privacy.md`)
- [ ] Errors reference (`docs/errors.md`)
- [ ] Deployment infrastructure (`docs/deployment/infrastructure.md`)
- [ ] Cross-repo dependencies (`docs/cross-repo-dependencies.md`)
- [ ] Cross-repo sync (`docs/cross-repo-sync.md`)
- [ ] Branch protection policy (`docs/branch-protection.md`)
- [ ] Scripts reference (`docs/scripts.md`)
- [ ] API versioning/migration (`docs/api-versioning-migration.md`)
- [ ] Mutation testing (`docs/mutation-testing.md`)
- [ ] Indexer data model (`docs/indexer-data-model.md`)

### Post-migration cleanup

- [ ] Remove `docs/pages/` directory (Nextra 2 Pages Router entry)
- [ ] Remove `docs/components/AlgoliaSearch.tsx` (or port to `packages/docs`)
- [ ] Remove `docs/theme.config.jsx` (Nextra 2 theme)
- [ ] Remove `docs/next.config.js` (Nextra 2 Next.js config)
- [ ] Remove `docs/tsconfig.json` (Nextra 2 TypeScript config)
- [ ] Remove `docs/package.json` and `@invoice-liquidity/docs` from workspace
- [ ] Remove `docs/.env.example` (Algolia keys, superseded by packages/docs setup)
- [ ] Configure Algolia DocSearch for `packages/docs` (see setup section below)
- [ ] Update `docs-deploy.yml` to drop the `docs/**` path trigger once `docs/` is content-only
- [ ] Archive or redirect `docs/algolia-crawler-config.json` to `packages/docs/`
- [ ] Update this file (remove migration checklist, keep dev guide only)

---

## Developer setup

### Canonical site — `packages/docs/` (deployed to `docs.iln.finance`)

```bash
# From repo root
pnpm --filter @invoice-liquidity/docs-next dev
# Runs at http://localhost:3000

pnpm --filter @invoice-liquidity/docs-next build
# Produces packages/docs/dist/ — same bundle CI deploys
```

### Legacy site — `docs/` (not deployed, content source)

```bash
# From repo root
pnpm --filter @invoice-liquidity/docs dev
# Runs at http://localhost:3000

pnpm --filter @invoice-liquidity/docs build
# Build-validates the Nextra 2 site locally
```

---

## CI / deploy flow

`docs-deploy.yml` runs on every push to `main` and on every PR that touches
`packages/docs/**` or `docs/**`:

| Trigger | `build` job | `deploy` job |
|---|---|---|
| `push` to `main` | Runs (`packages/docs/`) | Runs — publishes `packages/docs/dist` to GitHub Pages |
| `pull_request` | Runs — fails PR if build breaks | Skipped (never publishes from PRs) |
| `workflow_dispatch` | Runs | Runs — manual publish |

`docs-changelog.yml` runs on every push to `main` and on `v*.*.*` tags. It
calls `.local/repo-ops/aggregate-changelogs.js`, writes the result to
`docs/changelog.md`, and auto-commits it. This means `docs/changelog.md` is
always regenerated in the legacy site; once the changelog page is ported to
`packages/docs/content/`, this workflow should be updated to target the new
location.

---

## Algolia DocSearch setup (for `packages/docs/`)

1. Apply at [docsearch.algolia.com](https://docsearch.algolia.com/) using the
   site URL `https://docs.iln.finance`.
2. Once approved, add credentials to `packages/docs/.env.local`:
   ```
   NEXT_PUBLIC_ALGOLIA_APP_ID=<your_app_id>
   NEXT_PUBLIC_ALGOLIA_API_KEY=<your_search_api_key>
   NEXT_PUBLIC_ALGOLIA_INDEX_NAME=iln-docs
   ```
3. Apply `docs/algolia-crawler-config.json` in the Algolia Crawler dashboard.
   The config was audited in July 2026 and updated for the Nextra 3 App Router
   URL structure — selectors now target `<main>` (not `<article>`) and
   sub-heading records are extracted for granular search results.
4. Run the Algolia crawler after the first post-migration deploy.

> **Sitemap gap:** `packages/docs` uses `output: 'export'` without a sitemap
> plugin, so no `sitemap.xml` is generated. The crawler config uses
> `discoveryPatterns` for URL discovery instead. Once `next-sitemap` is added
> to `packages/docs`, restore the `sitemaps` entry in
> `docs/algolia-crawler-config.json`.
>
> **Credentials:** `docs/algolia-crawler-config.json` contains placeholder
> `appId`/`apiKey` values. Replace them with real DocSearch credentials in the
> Algolia dashboard — do not commit real credentials to the repo.
