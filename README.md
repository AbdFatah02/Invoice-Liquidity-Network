# Invoice Liquidity Network

[![CI](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/actions/workflows/ci.yml/badge.svg)](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/Nursca/Invoice-Liquidity-Network/branch/main/graph/badge.svg?token=CODECOV_TOKEN)](https://codecov.io/gh/Nursca/Invoice-Liquidity-Network)
[![CodeQL](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/actions/workflows/codeql.yml/badge.svg)](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**Turn unpaid invoices into instant liquidity on-chain, on Stellar.**

Invoice Liquidity Network (ILN) is an open-source, decentralised invoice factoring protocol built on [Stellar](https://stellar.org) using [Soroban](https://soroban.stellar.org) smart contracts. Freelancers, creators, and SMEs unlock the value of outstanding invoices immediately, while DeFi liquidity providers earn yield by funding them at a discount.

No banks. No credit checks. No 60-day waits.

---

## Organisation Repositories

| Repository                                                                                          | Description                                                                 | Language   |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------- |
| [Invoice-Liquidity-Network](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network) | **This repo** — org overview, shared docs, SDK, CLI, indexer, notifications | TypeScript |
| [ILN-Frontend](https://github.com/Invoice-Liquidity-Network/ILN-Frontend)                           | Next.js dApp — freelancer dashboard, LP analytics, governance UI            | TypeScript |
| [ILN-Smart-Contract](https://github.com/Invoice-Liquidity-Network/ILN-Smart-Contract)               | Soroban smart contracts — invoice lifecycle, multi-token, reputation        | Rust       |

---

## How It Works

```
Freelancer                  ILN Contract              Liquidity Provider
    |                            |                            |
    |--- submit_invoice() ------>|                            |
    |    (amount, payer,         |                            |
    |     due_date, discount)    |                            |
    |                            |<--- fund_invoice() --------|
    |                            |    (sends USDC at          |
    |<-- receives USDC -------   |     discounted amount)     |
    |   (amount - discount)      |                            |
    |                            |                            |
   ...    invoice due date       ...                          |
    |                            |                            |
  Payer --- mark_paid() -------->|                            |
                                 |--- releases full amount -->|
                                      (LP earns the spread)
```

1. **Submit** — A freelancer calls `submit_invoice()` with amount, payer, due date, and discount rate
2. **Fund** — A liquidity provider calls `fund_invoice()`, sending USDC. The freelancer receives funds immediately
3. **Pay** — The payer settles the invoice, releasing the full amount to the LP
4. **Earn** — The LP earns the discount spread as yield

---

## Stellar Testnet Deployment

| Contract          | Contract ID                                                |
| ----------------- | ---------------------------------------------------------- |
| ILN-Distribution  | `CAQGPMT3EQK4AABMIR66JJXEOCNCLPTDNXMS5OHZXH4LI24UYAF25V5B` |
| Invoice-Liquidity | `CCPASLHKRFBMVV5PZG3LKDGKFEDXZMB5U7DK42CVLUVWCMUCSRPVBIMO` |
| ILN-Governance    | `CD7GOIU3GNK7EZHG7XWBC7VI4NRVGMRCU7X2FOCAPQN6EGTSW46BY4EB` |

> Mainnet deployment coming after audit. Do not use with real funds until then.

---

## What's in This Repo

This is the **organisation root** — it contains shared infrastructure used across all ILN sub-projects:

### SDK (`sdk/`)

A typed JavaScript/TypeScript SDK with browser Freighter signing and Node.js keypair support.

```bash
npm install @iln/sdk
```

See [`sdk/README.md`](./sdk/README.md) for full API documentation.

### CLI (`cli/`)

A command-line tool for interacting with the ILN contract on testnet and mainnet.

```bash
npm install -g @invoice-liquidity/cli
```

```bash
iln submit --payer G... --amount 100 --due 2025-12-31 --rate 300
iln fund --id 1
iln pay --id 1
iln status --id 1
```

See [`cli/README.md`](./cli/README.md) for setup and usage.

This is the one and only CLI in this repository. `packages/cli` (`@iln/cli`)
was an experimental duplicate with a smaller command set and has been
removed — see [`docs/cli-vs-cli-next.md`](./docs/cli-vs-cli-next.md) for how
its unique commands (`watch`, `export`, `stats`, `reputation`, `network
switch`) were folded in here.

**Development vs Production CLI:**

- The published CLI package (`@invoice-liquidity/cli`) installs the `iln` binary — this is the public-facing tool for interacting with the ILN contract.
- The monorepo's development tooling includes an internal `iln-dev` binary (via `pnpm iln-dev`) — this is an internal development/configuration tool with no public API. Do not install the root package globally; use the CLI package instead.

### Indexer service (`indexer/`)

The production event indexer service — deployed to Railway, polls the Soroban
RPC, persists to SQLite, and exposes a REST + GraphQL API for the frontend.

See [`docs/indexer/`](./docs/indexer/) for architecture, API reference, and deployment guide.

### Indexer client library (`packages/indexer/`)

`@iln/indexer` — a publishable Horizon-based event indexer utility for
frontend apps and external tooling. Wraps the Horizon REST API with typed
pagination and SSE streaming.

```bash
pnpm add @iln/indexer
```

See [`packages/indexer/README.md`](./packages/indexer/README.md) for API reference and usage.

> The two indexer packages are **not duplicates** — they use different data
> sources (Soroban RPC vs Horizon) and serve different purposes. The service
> (`indexer/`) is what the frontend queries; the library (`packages/indexer/`)
> is for direct Horizon-based integrations. See
> [`docs/indexer/README.md`](./docs/indexer/README.md) for a full comparison.

### Notifications (`notifications/`)

A webhook-based notification service for invoice lifecycle events.

See [`docs/notifications.md`](./docs/notifications.md) for setup.

### Scripts (`scripts/`)

Deployment and development helper scripts.

| Script                    | Purpose                            |
| ------------------------- | ---------------------------------- |
| `scripts/deploy.ts`       | Deploy contract to testnet/mainnet |
| `scripts/fund-wallets.sh` | Fund testnet wallets via Friendbot |
| `scripts/seed.sh`         | Seed test data                     |
| `scripts/dev-setup.sh`    | Set up a local dev environment     |

---

## Workspace Layout

This is a **pnpm workspace** (see `pnpm-workspace.yaml`). For a complete table with status, purpose, and dependency information for every workspace, see [docs/monorepo-map.md](docs/monorepo-map.md).

### Which package should I use?

If you are a new integrator, use this quick decision guide to find what you need:

| If you are building...     | You should use...   | NPM Package              |
| -------------------------- | ------------------- | ------------------------ |
| A command-line integration | `cli/`              | `@invoice-liquidity/cli` |
| A TypeScript/Node.js app   | `sdk/`              | `@iln/sdk` |
| A React frontend           | `packages/react/`   | `@iln/react`             |
| Direct Horizon queries     | `packages/indexer/` | `@iln/indexer`           |

> Note: The legacy CLI (`@iln/cli`) has been consolidated into `@invoice-liquidity/cli`. The production SDK is `@iln/sdk` (`sdk/`); `@iln/sdk-next` (`packages/sdk/`) is the experimental rewrite. Always use the top-level `cli/` and `sdk/` directories for new integrations.

The table below lists every workspace package, its directory, npm package name, and role. `pnpm-workspace.yaml` is the single source of truth — the `workspaces` field has been removed from `package.json` because pnpm ignores it.

### Top-level service packages

| Directory        | Package name                       | Role                                                                                        |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `sdk/`           | `@iln/sdk`           | TypeScript SDK — browser Freighter + Node.js keypair signing                                |
| `cli/`           | `@invoice-liquidity/cli`           | Published CLI (`iln` binary) for interacting with the contract                              |
| `indexer/`       | `iln-indexer`                      | Production event indexer service — Soroban RPC → SQLite → REST/GraphQL, deployed on Railway |
| `notifications/` | `@invoice-liquidity/notifications` | Webhook notification service for invoice lifecycle events                                   |
| `docs/`          | `@invoice-liquidity/docs`          | Nextra 2 legacy docs source — content `.md` files; **not deployed** (migration in progress) |

### Shared library packages (`packages/*`)

| Directory                 | Package name                   | Role                                                                                                              |
| ------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `packages/sdk/`           | `@iln/sdk-next`                | SDK package variant (experimental / next iteration)                                                               |
| `packages/docs/`          | `@invoice-liquidity/docs-next` | **Canonical deployed docs site** (Nextra 3, Next.js 15 App Router) — [docs.iln.finance](https://docs.iln.finance) |
| `packages/shared/`        | `@iln/shared`                  | Shared utilities consumed by SDK, CLI, and other packages                                                         |
| `packages/indexer/`       | `@iln/indexer`                 | Horizon-based event indexer utility library (stateless, publishable)                                              |
| `packages/react/`         | `@iln/react`                   | React component library for ILN protocol interactions                                                             |
| `packages/opentelemetry/` | `@iln/opentelemetry`           | OpenTelemetry instrumentation helpers                                                                             |
| `packages/mock-backend/`  | `@iln/mock-backend`            | Mock backend for local testing without a live Stellar node                                                        |
| `packages/eslint-config/` | `@iln/eslint-config`           | Shared ESLint configuration used across all workspaces                                                            |
| `packages/test-utils/`    | `@iln/test-utils`              | Test helper utilities shared across packages                                                                      |
| `packages/upgrade-tests/` | `@iln/upgrade-tests`           | Upgrade compatibility test suite                                                                                  |
| `packages/scripts/`       | _(internal)_                   | Internal dev scripts and the `iln-dev` binary                                                                     |

### Example applications (`examples/*`)

| Directory                      | Role                                   |
| ------------------------------ | -------------------------------------- |
| `examples/analytics-plugin/`   | Analytics plugin integration example   |
| `examples/governance-monitor/` | On-chain governance monitoring example |
| `examples/javascript-example/` | Plain JavaScript SDK usage example     |
| `examples/lp-automation/`      | Automated LP funding bot example       |
| `examples/portfolio-report/`   | LP/freelancer portfolio report script  |
| `examples/react-example/`      | React app SDK integration example      |
| `examples/submit-invoice/`     | Invoice submission walkthrough example |
| `examples/typescript-example/` | TypeScript SDK usage example           |

> Directories without a `package.json` (`backend/`, `frontend/`, `tests/`, `workers/`, etc.) are **not** pnpm workspaces — they are submodules, supporting scripts, or non-JS artefacts.

---

## Repository Structure

```
.
├── cli/                    # CLI package (@invoice-liquidity/cli)
├── docs/                   # Documentation prose source (Nextra 2 legacy — migration in progress)
├── indexer/                # Production event indexer service (Soroban RPC → SQLite → REST/GraphQL)
├── notifications/          # Webhook notification service
├── packages/docs/          # Canonical docs site (@invoice-liquidity/docs-next, deployed to docs.iln.finance)
├── packages/indexer/       # Horizon event indexer utility (@iln/indexer, publishable library)
├── scripts/                # Deployment & dev scripts
├── sdk/                    # TypeScript SDK (@iln/sdk)
├── tests/                  # E2E integration tests
├── .github/workflows/      # CI/CD pipelines
├── docker-compose.yml      # Local dev environment
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
└── README.md               # You are here
```

> **Frontend** and **Smart Contract** source code lives in their own dedicated repositories (linked above as git submodules).
>
> Two docs directories exist during an in-progress migration. `packages/docs/` is the canonical site deployed to [docs.iln.finance](https://docs.iln.finance). `docs/` holds the source `.md` content files and the Nextra 2 legacy app. See [`docs/DOCS_SETUP.md`](./docs/DOCS_SETUP.md) for the migration checklist.
>
> Two indexer packages exist with different data sources and purposes. `indexer/` is the production deployment service (Soroban RPC). `packages/indexer/` is a Horizon-based client library for frontend/external integrations. See [`docs/indexer/README.md`](./docs/indexer/README.md) for the full comparison.

---

## Getting Started (Local Dev)

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) 1.74+
- [Stellar CLI](https://developers.stellar.org/docs/tools/cli/stellar-cli)
- [Docker](https://docs.docker.com/get-docker/) (for E2E tests)

### Clone with Submodules

```bash
git clone --recurse-submodules https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network.git
cd Invoice-Liquidity-Network

# Or if already cloned:
git submodule update --init --recursive
```

### Start Local Environment

```bash
docker-compose up -d          # Start local Stellar node
npm run test:e2e              # Run E2E integration tests
```

---

## Roadmap

- [x] Core Soroban contract (submit, fund, mark_paid)
- [x] Testnet deployment
- [x] Frontend dApp for freelancers
- [x] LP dashboard with yield analytics
- [x] TypeScript SDK + CLI
- [x] Multi-token support (USDC, EURC, XLM)
- [ ] Off-chain payer verification oracle
- [ ] Formal security audit
- [ ] Mainnet deployment
- [ ] DAO governance for protocol parameters

---

## Documentation

> The live documentation site is **[docs.iln.finance](https://docs.iln.finance)**, built from
> [`packages/docs/`](./packages/docs). The `docs/` directory holds source content files and a
> legacy Nextra 2 app that is not deployed — see [`docs/DOCS_SETUP.md`](./docs/DOCS_SETUP.md)
> for the migration status.

| Doc                                                                          | Description                                                                   |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [docs.iln.finance](https://docs.iln.finance)                                 | **Live documentation site** (canonical, deployed from `packages/docs/`)       |
| [`docs/index.md`](./docs/index.md)                                           | Protocol overview                                                             |
| [`docs/tutorials/lp-funding.md`](./docs/tutorials/lp-funding.md)             | LP funding tutorial                                                           |
| [`docs/governance-guide.md`](./docs/governance-guide.md)                     | Governance guide                                                              |
| [`docs/tokens/multi-token-support.md`](./docs/tokens/multi-token-support.md) | Multi-token support                                                           |
| [`docs/notifications.md`](./docs/notifications.md)                           | Notification system                                                           |
| [`docs/api-collection.md`](./docs/api-collection.md)                         | Horizon and Soroban RPC API collection examples                               |
| [`docs/local-development.md`](./docs/local-development.md)                   | Local dev setup                                                               |
| [`docs/mainnet-launch-checklist.md`](./docs/mainnet-launch-checklist.md)     | Mainnet readiness checklist with owners, statuses, and sign-off               |
| [`docs/glossary.md`](./docs/glossary.md)                                     | Protocol terminology for Stellar, invoice factoring, DeFi, and security terms |
| [`docs/tutorials/first-invoice.md`](./docs/tutorials/first-invoice.md)       | Hands-on invoice submission tutorial                                          |
| [`docs/ci-cd.md`](./docs/ci-cd.md)                                           | CI/CD and deployment environments                                             |
| [`docs/DOCS_SETUP.md`](./docs/DOCS_SETUP.md)                                 | Docs migration checklist and developer setup guide                            |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md)                                       | How to contribute                                                             |
| [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)                                 | Community standards and guidelines                                            |
| [`SECURITY.md`](./SECURITY.md)                                               | Security policy                                                               |

---

## Contributing

We welcome contributions of all kinds — smart contract improvements, documentation, frontend, tests, and research.

Start here: [CONTRIBUTING.md](./CONTRIBUTING.md) for the project-level contribution model, repo decision tree, and Drips Wave guide.

---

## License

MIT — see [LICENSE](./LICENSE)

---

## Built on Stellar

Built on [Stellar](https://stellar.org) and [Soroban](https://soroban.stellar.org).

> This project is not affiliated with Stellar Development Foundation.

## Security

Please refer to our [Security Policy](./SECURITY.md) for information on supported versions and how to report vulnerabilities privately.

## Documentation Site

The ILN documentation site is built with [Nextra 3](https://nextra.site) and deployed to
**[docs.iln.finance](https://docs.iln.finance)** from [`packages/docs/`](./packages/docs).

Two documentation directories exist during an in-progress migration:

- **`packages/docs/`** (`@invoice-liquidity/docs-next`) — the **canonical, deployed site** (Nextra 3, Next.js 15 App Router). This is what `docs-deploy.yml` builds and publishes to GitHub Pages.
- **`docs/`** (`@invoice-liquidity/docs`) — the **legacy source** (Nextra 2, Next.js 14 Pages Router). Not deployed. Holds the authoritative `.md` content files while migration is ongoing. The `docs-changelog.yml` workflow writes `docs/changelog.md` here.

See [`docs/DOCS_SETUP.md`](./docs/DOCS_SETUP.md) for the full migration checklist and remaining work.

### Local development

```bash
# Canonical site (Nextra 3 — what gets deployed)
pnpm --filter @invoice-liquidity/docs-next dev

# Legacy site (Nextra 2 — content source, not deployed)
pnpm --filter @invoice-liquidity/docs dev
```

git add package.json scripts/test-load-notifications.js docs/notifications.md
git commit -m "test: verify notifications service load performance and resilience post-hardening"
git push origin fix/notifications-websocket-limits-and-auth --force
