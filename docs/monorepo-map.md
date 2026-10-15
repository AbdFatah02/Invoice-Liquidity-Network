# Monorepo Map

Every workspace in the ILN monorepo, its purpose, status, and key dependencies.

## Status Legend

| Status | Meaning |
|--------|---------|
| **Stable** | Production-ready, semantically versioned, API-stable |
| **Next** | Active development; API may change; candidates for stable |
| **Experimental** | Proof-of-concept; not for production use |
| **Deprecated** | Superseded; will be removed in a future release |

---

## Top-Level Service Packages

| Path | Package | Status | Purpose | Dependencies |
|------|---------|--------|---------|-------------|
| `sdk/` | `@iln/sdk` | Stable | TypeScript SDK for the Invoice Liquidity Network Soroban contract. Core types, contract clients, and helpers. | — |
| `cli/` | `@invoice-liquidity/cli` | Stable | The single, canonical CLI for interacting with ILN contracts on Stellar (invoice submit/fund/pay/watch/export, protocol stats, reputation, network switching, wallets, and more). `packages/cli` was a duplicate and has been removed — see [cli-vs-cli-next.md](cli-vs-cli-next.md). | `@iln/sdk` |
| `indexer/` | `iln-indexer` | Stable | Production event indexer service. Polls Soroban RPC for contract events, processes invoices, dispatches notifications. | `@iln/sdk`, `@iln/indexer` |
| `notifications/` | `iln-notifications` | Next | Multi-channel notification service (email, webhook, SMS, WebSocket). Digest batching, subscription management, delivery retry. | `@iln/sdk` |
| `oracle-service/` | `@iln/oracle-service` | Next | Off-chain payer verification oracle with risk signals and signed price updates. | `@iln/opentelemetry`, `@stellar/stellar-sdk` |
| `docs/` | `@invoice-liquidity/docs` | Stable (content source of record) | Nextra 2 legacy docs source. Holds the large majority of actual documentation content (54 `.md` files) and is the current source of truth for anything not yet ported. **Not deprecated** — see the Resolution Plans section below. | — |

---

## Test Workspaces

| Path | Package | Purpose | Dependencies |
|------|---------|---------|-------------|
| `tests/sdk-integration/` | `@iln/sdk-integration-tests` | SDK integration-test workspace for type and fixture drift checks. | `@iln/sdk`, Vitest |

---

## Shared Library Packages (`packages/*`)

| Path | Package | Status | Purpose | Dependencies |
|------|---------|--------|---------|-------------|
| `packages/shared/` | `@iln/shared` | Stable | Shared ILN domain types for the SDK, frontend, and related packages. | — |
| `packages/eslint-config/` | `@iln/eslint-config` | Stable | Shared ESLint configuration for all monorepo packages. | — |
| `packages/test-utils/` | `@iln/test-utils` | Stable | Test helper utilities used across SDK and service test suites. | — |
| `packages/indexer/` | `@iln/indexer` | Next | Horizon event indexer utility library — lower-level than `indexer/` service; suitable for embedding. | `@iln/shared` |
| `packages/sdk/` | `@iln/sdk-next` | Next | Browser-first, modular rewrite of `@iln/sdk`, on a path to becoming `@iln/sdk` v2. See [sdk-next-migration.md](sdk-next-migration.md) and the Resolution Plans section below. | `@iln/shared` |
| `packages/docs/` | `@invoice-liquidity/docs-next` | Next (partial content migration) | Canonical **deployed** docs site (Nextra 3 / App Router) at docs.iln.finance. As of this writing it holds 16 content files covering ~12 of the 54 pages in `docs/` — see [DOCS_SETUP.md](DOCS_SETUP.md) for the live migration checklist. It is where the site is *served from*, not yet a complete replacement for `docs/` content. | — |
| `packages/mock-backend/` | `@iln/mock-backend` | Next | In-memory mock backend for frontend development without a live Stellar node. | `@iln/shared` |
| `packages/react/` | `@iln/react` | Next | React hooks for ILN contract data fetching. Consumed by dashboard and examples. | `@iln/shared` |
| `packages/opentelemetry/` | `@iln/opentelemetry` | Experimental | OpenTelemetry instrumentation for the ILN SDK. | `@iln/sdk` |
| `packages/upgrade-tests/` | `@iln/upgrade-tests` | Stable | Upgrade compatibility tests for Soroban contract migrations. | `@iln/shared`, `@iln/sdk` |
| `packages/scripts/` | `@iln/scripts` | — | Internal dev/CI scripts. Not published. | — |

---

## Example Applications (`examples/*`)

| Path | Status | Purpose |
|------|--------|---------|
| `examples/javascript-example/` | Stable | Basic JavaScript example — invoice creation and funding workflow. |
| `examples/typescript-example/` | Stable | TypeScript example with full type safety. |
| `examples/react-example/` | Next | React integration example using `@iln/react` hooks. |
| `examples/submit-invoice/` | Next | Minimal invoice submission CLI helper. |
| `examples/analytics-plugin/` | Experimental | Analytics data export plugin example. |
| `examples/api-collection/` | Experimental | API collection and request examples for local integration testing. |
| `examples/explorer-integration/` | Experimental | External explorer integration sample and API callbacks. |
| `examples/grafana/` | Experimental | Grafana dashboards and monitoring examples for ILN services. |
| `examples/governance-monitor/` | Experimental | Governance proposal monitoring example. |
| `examples/lp-automation/` | Experimental | LP automation script — auto-fund eligible invoices. |
| `examples/portfolio-report/` | Experimental | Portfolio reporting example — LP position snapshots. |

---

## Dependency Flow

```
sdk/                      # Foundation: types, contract clients, helpers
├── packages/shared/      # Shared domain types consumed by everything below
│   └── packages/sdk/     # sdk-next — browser-first rewrite, path to @iln/sdk v2
├── packages/indexer/     # Indexer utility lib → consumed by indexer/
├── packages/react/       # React hooks → consumed by dashboard/examples
├── packages/mock-backend/# Standalone mock → consumed by frontend dev
├── packages/opentelemetry/# Optional instrumentation wrapper
├── packages/upgrade-tests/# Upgrade compatibility test harness & test suites
├── cli/                  # The canonical CLI → uses @iln/sdk
├── indexer/              # Production indexer service → uses @iln/sdk, @iln/indexer
└── notifications/        # Notification service → uses @iln/sdk
```

---

## Resolution Plans

Dated decisions for packages whose status or relationship to another
package was previously undocumented or left pending. See each linked doc
for full detail.

| Date | Package(s) | Resolution |
|------|-----------|------------|
| 2026-08-25 | `packages/invoice-sdk` | **Removed.** Zero-source re-export alias with no remaining consumers; already self-flagged for removal. See the changelog. |
| 2026-08-25 | `packages/cli` vs `cli/` | **Resolved: consolidated into `cli/`.** `packages/cli`'s five unique commands (`watch`, `export`, `stats`, `reputation get`, `network switch`) were ported into `cli/` with parity tests; `packages/cli` was then removed. See [cli-vs-cli-next.md](cli-vs-cli-next.md). |
| 2026-08-25 | `packages/sdk` (`@iln/sdk-next`) vs `sdk/` | **Plan: becomes `@iln/sdk` v2.** `packages/sdk` stays on its own package name and release cadence while it stabilizes; once its API surface is considered final it ships as a major version bump to `@iln/sdk` itself (not a permanent second package), with `docs/sdk-next-migration.md` promoted to the release's migration guide. No fixed date is set for that cutover yet — it is gated on `packages/sdk` reaching feature parity with `sdk/`'s contract surface, not a calendar date. In the meantime `docs/sdk-next-migration.md` is kept accurate against `packages/sdk`'s actual exports (see that file's changelog note). |
| 2026-08-25 | `docs/` vs `packages/docs/` | **Reversed a premature "Deprecated" label.** `packages/docs/content/` currently covers 16 of `docs/`'s 54 `.md` files (see [DOCS_SETUP.md](DOCS_SETUP.md)'s migration checklist). `docs/` remains the content source of record and is not deprecated until that migration is complete; `packages/docs/` remains canonical only for *where the site is deployed from* and *for the content it already has*. |
| 2026-08-31 | `packages/upgrade-tests` | **Completed and promoted to Stable.** Implemented full contract in-place upgrade simulation harness, storage layout integrity and bulk migration tests, SDK forward/backward compatibility checks, authorization enforcement, and emergency circuit breaker preservation test suites (#930). |

---

## Cross-References

- [pnpm-workspace.yaml](../pnpm-workspace.yaml) — authoritative workspace membership
- [docs/cli-vs-cli-next.md](cli-vs-cli-next.md) — history of the CLI consolidation
- [docs/sdk-next-migration.md](sdk-next-migration.md) — `@iln/sdk` vs `@iln/sdk-next` API differences and migration plan
- [docs/DOCS_SETUP.md](DOCS_SETUP.md) — `docs/` → `packages/docs/` migration checklist and dev setup
- [docs/indexer/](indexer/) — indexer architecture, API, and deployment guide
- [docs/notifications.md](notifications.md) — notification service setup and architecture
- [docs/hardening-batch-coordination.md](hardening-batch-coordination.md) — cross-repo hardening batch coordination & de-duplication rules
- [README.md](../README.md#workspace-layout) — workspace layout overview
