# ILN Deployment & Infrastructure Guide

This guide covers everything needed to run a self-hosted ILN instance — from a local dev environment to a production deployment.

---

## Table of contents

- [Prerequisites](#prerequisites)
- [Stellar network requirements](#stellar-network-requirements)
- [Contract deployment](#contract-deployment)
- [Environment variables](#environment-variables)
- [Local stack with Docker Compose](#local-stack-with-docker-compose)
- [Indexer deployment](#indexer-deployment)
- [Notifications service deployment](#notifications-service-deployment)
- [Frontend deployment](#frontend-deployment)
- [Docs site deployment](#docs-site-deployment)
- [CI/CD setup for a fork](#cicd-setup-for-a-fork)
- [Minimum viable deployment checklist](#minimum-viable-deployment-checklist)

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Rust | ≥ 1.74 | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| wasm32 target | — | `rustup target add wasm32-unknown-unknown` |
| Stellar CLI | latest | `cargo install --locked stellar-cli --features opt` |
| Node.js | ≥ 18 | https://nodejs.org |
| pnpm | 9 | `npm i -g pnpm@9` |
| Docker + Compose | — | https://docs.docker.com/get-docker |

Run the setup script to install all Rust/Stellar dependencies automatically:

```bash
./scripts/dev-setup.sh
```

---

## Stellar network requirements

### Testnet

Use the public Soroban testnet RPC — no account setup needed:

```
RPC_URL=https://soroban-testnet.stellar.org
NETWORK_PASSPHRASE=Test SDF Network ; September 2015
```

Fund your deployer wallet via Friendbot:

```bash
curl "https://friendbot.stellar.org?addr=<YOUR_PUBLIC_KEY>"
```

### Mainnet

Use a Soroban-compatible RPC provider. Options:

- [Validation Cloud](https://validationcloud.io): `https://mainnet.stellar.validationcloud.io/v1/<API_KEY>`
- [Ankr](https://www.ankr.com): `https://rpc.ankr.com/stellar_soroban`
- Self-hosted [stellar/quickstart](https://github.com/stellar/quickstart)

```
RPC_URL=https://mainnet.stellar.validationcloud.io/v1/<API_KEY>
NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
```

Ensure the deployer account has ≥ 2 XLM to cover contract deployment fees.

---

## Contract deployment

The contract source lives in the [ILN-Smart-Contract](https://github.com/Invoice-Liquidity-Network/ILN-Smart-Contract) repo. From the repo root:

### 1. Build

```bash
stellar contract build
# Output: target/wasm32v1-none/release/invoice_liquidity.wasm
```

### 2. Deploy

```bash
# Testnet
npx ts-node scripts/deploy.ts --network=testnet

# Mainnet (requires funded account configured in stellar-cli)
npx ts-node scripts/deploy.ts --network=mainnet
```

The script:
1. Builds the contract WASM
2. Deploys via `soroban contract deploy`
3. Writes the resulting contract ID to `.env` (`CONTRACT_ID=...`) and `README.md`

### 3. Verify

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  -- get_invoice --invoice_id 1
# Expected: InvoiceNotFound error (confirms contract is live)
```

### 4. Configure downstream services

Copy the contract ID into every service's `.env`:

```
CONTRACT_ID=<CONTRACT_ID>
NOTIFICATIONS_CONTRACT_ID=<CONTRACT_ID>
```

---

## Environment variables

### Indexer (`indexer/.env`)

| Variable | Description | Example |
|----------|-------------|---------|
| `CONTRACT_ID` | Deployed contract address | `CD3TE3...` |
| `NETWORK_PASSPHRASE` | Stellar network passphrase | `Test SDF Network ; September 2015` |
| `RPC_URL` | Soroban RPC endpoint | `https://soroban-testnet.stellar.org` |
| `DB_PATH` | SQLite database file path | `indexer.db` |
| `POLL_INTERVAL_MS` | Event polling interval (ms) | `5000` |
| `PORT` | REST API port | `3001` |
| `START_LEDGER` | Ledger to start from (`0` = auto) | `0` |

### Notifications service (`notifications/.env`)

| Variable | Description | Example |
|----------|-------------|---------|
| `NOTIFICATIONS_DB_PATH` | SQLite database file path | `notifications.sqlite` |
| `NOTIFICATIONS_RPC_URL` | Soroban RPC endpoint | `https://soroban-testnet.stellar.org` |
| `NOTIFICATIONS_CONTRACT_ID` | Deployed contract address | `CD3TE3...` |
| `NOTIFICATIONS_NETWORK_PASSPHRASE` | Stellar network passphrase | `Test SDF Network ; September 2015` |
| `NOTIFICATIONS_POLL_INTERVAL_MS` | Polling interval (ms) | `30000` |
| `NOTIFICATIONS_START_LEDGER` | Ledger to start from (`0` = auto) | `0` |
| `NOTIFICATIONS_AUDIT_KEY` | HMAC key for compliance audit evidence; required in production | secret-manager value |
| `RESEND_API_KEY` | Resend API key for email delivery | `re_...` |
| `RESEND_FROM_EMAIL` | Sender address for notification emails | `no-reply@yourdomain.com` |
| `DUE_WARNING_HOURS` | Hours before due date to send warning | `48` |
| `PORT` | HTTP port | `4001` |

---

## Local stack with Docker Compose

The `docker-compose.yml` in the repo root starts a complete local stack:

```bash
docker-compose up -d
```

Services started:

| Service | Port | Description |
|---------|------|-------------|
| `stellar` | 8000, 11626 | Local Stellar node with Soroban RPC |
| `indexer` | 3001 | Event indexer REST API |
| `notifications` | 4001 | Notification service |

After startup, deploy the contract to the local node:

```bash
make deploy-local   # builds + deploys contract, writes .local-contract-id
```

Then seed test data:

```bash
make seed
```

---

## Indexer deployment

The indexer is a Node.js service. It runs anywhere that supports Node ≥ 18.

### Railway (recommended for forks)

A `railway.toml` is already included in `indexer/`. Connect the repo in the Railway dashboard, set the environment variables from the table above, and deploy.

### Self-hosted

```bash
cd indexer
cp .env.example .env    # fill in values
npm install
npm start
```

The indexer exposes a REST API on `PORT` (default `3001`). Point the frontend's `NEXT_PUBLIC_INDEXER_URL` at this address.

---

## Notifications service deployment

```bash
cd notifications
cp .env.example .env    # fill in values, including RESEND_API_KEY
npm install
npm start
```

Runs on `PORT` (default `4001`). No inbound traffic required — it polls the contract directly.

---

## Frontend deployment

The frontend lives in the [ILN-Frontend](https://github.com/Invoice-Liquidity-Network/ILN-Frontend) repo.

### Environment variables (set in Vercel or `.env.local`)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_CONTRACT_ID` | Deployed contract address |
| `NEXT_PUBLIC_NETWORK_PASSPHRASE` | Stellar network passphrase |
| `NEXT_PUBLIC_RPC_URL` | Soroban RPC endpoint |
| `NEXT_PUBLIC_INDEXER_URL` | Indexer REST API base URL |

### Vercel

```bash
vercel --prod
```

Or connect the `ILN-Frontend` repo directly in the Vercel dashboard. Set the environment variables above under Project → Settings → Environment Variables.

### Self-hosted (Docker)

```bash
# In ILN-Frontend repo
docker build -t iln-frontend .
docker run -p 3000:3000 \
  -e NEXT_PUBLIC_CONTRACT_ID=... \
  -e NEXT_PUBLIC_RPC_URL=... \
  iln-frontend
```

---

## Docs site deployment

Docs are Markdown files in `docs/`. Deploy to GitHub Pages via the existing Actions workflow, or to any static host:

```bash
# Example: deploy to Netlify
netlify deploy --dir docs --prod
```

For custom domains, set the CNAME in your DNS and configure it in the hosting provider.

---

## CI/CD setup for a fork

The repo ships with GitHub Actions workflows in `.github/workflows/`. After forking:

1. **Set repository secrets** (Settings → Secrets → Actions):

   | Secret | Used by |
   |--------|---------|
   | `GITHUB_TOKEN` | All workflows (auto-provided) |
   | `PROJECT_PAT` | Project board automation (optional) |

2. **Enable Actions** — GitHub disables Actions on forks by default. Go to Actions → enable workflows.

3. **Update contract IDs** — replace the hardcoded testnet contract IDs in `README.md` and `sdk/src/signers.ts` (`TESTNET_CONTRACT_ID`) with your own after deploying.

4. **Configure branch protection** on `main`:
   - Require status checks: `CI / test`, `CI / build`, `CI / lint`, `CI / node-tests`
   - Require pull request before merging

---

## Minimum viable deployment checklist

Use this checklist to verify a complete deployment before going live.

### Infrastructure

- [ ] Rust ≥ 1.74 and `wasm32-unknown-unknown` target installed
- [ ] Stellar CLI installed and `stellar keys` configured
- [ ] Deployer wallet funded (≥ 2 XLM on target network)

### Contract

- [ ] `stellar contract build` succeeds — `.wasm` file produced
- [ ] `npx ts-node scripts/deploy.ts --network=<network>` succeeds
- [ ] Contract ID recorded in `.env` and `README.md`
- [ ] `get_invoice` invocation returns expected `InvoiceNotFound` (contract live)

### Indexer

- [ ] All required env vars set (see [table](#indexer-indexerenv))
- [ ] `npm start` in `indexer/` runs without errors
- [ ] `GET http://localhost:3001/invoices` returns `200 []`

### Notifications

- [ ] All required env vars set (see [table](#notifications-service-notificationsenv))
- [ ] Valid `RESEND_API_KEY` configured
- [ ] Service starts and polls without errors

### Frontend

- [ ] `NEXT_PUBLIC_CONTRACT_ID`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_INDEXER_URL` set
- [ ] `npm run build` succeeds
- [ ] App loads and connects to Freighter wallet
- [ ] Submit invoice flow completes on testnet

### CI

- [ ] GitHub Actions enabled on the fork
- [ ] All CI checks pass on a test PR (`ci.yml`)
- [ ] Branch protection rules configured on `main`
