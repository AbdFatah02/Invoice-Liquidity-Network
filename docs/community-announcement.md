# Mainnet Launch Communications & Community Plan

This document outlines the official launch announcement copy, support channels, security incident contact channels, and the maintainer on-call availability schedule for the Invoice Liquidity Network (ILN) mainnet launch.

---

## 1. Launch Announcement Draft

### Title
**Invoice Liquidity Network (ILN) Launches on Stellar Mainnet**

### Body
Today, the Invoice Liquidity Network (ILN) officially deploys to the Stellar mainnet. 

ILN is a decentralized invoice factoring protocol built on Soroban smart contracts. It enables freelancers, contractors, and businesses to tokenize receivables and access instant non-custodial liquidity from liquidity providers (LPs) in USDC, EURC, and XLM.

#### What is live today:
- **Core Invoice Factoring Contracts**: Immutable invoice lifecycle execution, escrow handling, and settlement logic on Soroban.
- **TypeScript SDK & CLI**: Production-ready `@iln/sdk` and `@invoice-liquidity/cli` for programmatic invoice creation, funding, and status querying.
- **Production Indexer**: Real-time event ingestion with GraphQL, REST endpoints, and automated SQLite database backups.
- **Notification Service**: Webhook, Email, and SMS alerts for funding, payment, and due-date events.
- **Decentralized Governance**: Multi-sig administrative quorum and timelock parameter change mechanisms.

#### Honest Framing & Protocol Parameters
As an early-stage DeFi protocol, safety and stability are our top priorities:
- Initial protocol fee rate is set to **1.0%** (100 bps) with max discount rates capped via governance.
- Emergency circuit breaker mechanisms are active and guarded by a multi-sig admin with a strict timelock.
- Users are encouraged to start with small invoice volumes while liquidity pools bootstrap.

#### Getting Started
- **Web App**: _Coming at mainnet launch_
- **Documentation**: [https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/tree/main/docs](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/tree/main/docs)
- **Source Code**: [https://github.com/Invoice-Liquidity-Network](https://github.com/Invoice-Liquidity-Network)

---

## 2. Official Support & Community Channels

| Channel | Destination / Handle | Purpose | SLA / Response Time |
|---|---|---|---|
| **Discord** | `#general-support` & `#developer-chat` | Community discussions, integration help, general troubleshooting | Within 4 hours during launch window |
| **Telegram** | `https://t.me/InvoiceLiquidityNetwork` | Community announcements & quick user inquiries | Best effort |
| **Developer Forum** | GitHub Discussions (`Invoice-Liquidity-Network`) | Feature proposals, technical RFCs, SDK questions | Within 24 hours |
| **Email Support** | `support@invoiceliquidity.network` | Sensitive billing or user inquiries | Within 12 hours |

---

## 3. Incident Contact & Escalation Path

For security vulnerabilities and emergency operational issues, follow the dedicated escalation channels below:

### Urgent Security Reports
- **Security Email**: `security@invoiceliquidity.network` (Monitored 24/7 with PGP key available in [`SECURITY.md`](../SECURITY.md))
- **GitHub Advisory**: Open a [Private Security Advisory](https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/security/advisories/new)
- **Safe Harbour**: Good-faith research is explicitly protected under our [Safe Harbour Policy](../SECURITY.md#safe-harbour).

### Operational Incidents & Outages
- **Live Status Page**: _Coming at mainnet launch_
- **Emergency War Room**: Discord `#incident-response` (restricted to core on-call maintainers)

---

## 4. Mainnet Cutover Announcement

### Purpose

This section documents the coordinated, cross-repo mainnet-cutover announcement that will be published across all three repositories (ILN, Smart Contracts, Frontend) on a synchronized schedule. The announcement confirms that mainnet hardening work is complete and readiness criteria are met.

### Announcement Scope & Coordination

The mainnet cutover announcement differs from the initial launch announcement (§1) in that it:
1. References **completed readiness work** with concrete evidence (merged PRs, audit results, stress test outcomes)
2. Coordinates timing and messaging across three repos to deliver a unified narrative
3. Defines publication channels and embargo windows to prevent fragmented messaging
4. Addresses common integration concerns from the testnet phase

### Key Themes for Cutover Narrative

#### Theme 1: Hardening Work Completed

- **Default Handling:** Concentrated-default blocking via oracle fraud signals (PR #1179 merged)
- **Escrow Fairness:** Proportional LP recovery in `claim_default` without double-counting (completed, audited)
- **Settlement Assurance:** Payer settlement flow with simulation-before-signing and partial-payment support (completed, load-tested under 10x concurrent users)
- **Risk Management:** LP risk gating, insurance pool with dynamic reserves, reputation-driven pricing (live on testnet, transitioning to mainnet)

#### Theme 2: API Completeness & Stability

- **Endpoint Audit:** All exposed endpoints documented and enforced via CI drift detection (see [`docs/api-collection.md`](./api-collection.md))
- **GraphQL & REST Stability:** Dual-endpoint support with consistent versioning (`/v1`), deprecation headers on unversioned routes
- **Load Test Results:** Indexer sustains 10x subscriber load without latency SLO breaches; export pagination tested with >1M row datasets
- **Backup & Recovery:** Automated daily backups with restore verification; full database recovery tested monthly

#### Theme 3: Oracle & Verification Resilience

- **Fraud Signal Blocking:** Repeated defaults flag as blocking (2+ in 30 days), preventing reputation washing
- **Provider Failover:** Primary RPC fails over to secondary without stale data; KYB provider unavailability triggers graceful degradation ("unknown" verdict)
- **Audit Trail Integrity:** All published verdicts logged with HMAC chaining; integrity verification available to auditors at `/v1/audit/integrity`
- **Attestation:** Signed verdicts with public key rotation schedule published at `/v1/signing/config`

#### Theme 4: Liquidity Stress Scenarios Addressed

- **Concentrated Defaults:** Blocked by oracle fraud signal; LP risk gating dims high-risk payers
- **Oracle Staleness:** Graceful degradation to "unknown" + on-chain history fallback prevents data unavailability from halting the protocol
- **Escrow Auction Edge Cases:** Dutch-auction bounds enforced on-chain; out-of-range auctions revert and trigger governance review

### Announcement Copy (Draft)

**Headline:** "Invoice Liquidity Network Mainnet Cutover — Hardening Complete"

**Body:**

After six months of intensive hardening across smart contracts, oracle, indexer, and frontend, the ILN team is ready to transition to mainnet.

The testnet phase delivered critical evidence of protocol resilience:
- Default handling was stress-tested with concentrated-default scenarios; the protocol correctly blocked repeated offenders and protected LP capital via oracle fraud signals.
- The indexer sustained 10x concurrent subscribers without SLO violations; load tests confirm sub-block-latency invoice updates.
- Payer verification survives KYB provider outages by gracefully degrading to on-chain reputation history, ensuring no false confidence.
- Every API endpoint is catalogued, versioned, and enforced by CI drift detection; undocumented routes cannot ship.

**Timeline:**
- **Announcement Date (T-0):** Coordinated across all three repos
- **Embargo Lifting:** T+0 06:00 UTC (allows time-zone coverage across Global South)
- **Publication Channels:** GitHub announcements, Discord #general-support pinned message, Telegram, community Discord
- **Infrastructure Cutover:** Begins T+2; core infrastructure (RPC, Stellar network) pre-checked at T-6 hours

**Call to Action:**

Liquidity providers and freelancers are invited to:
1. Review the mainnet parameter set at [`/contract/network-params.json`](https://github.com/Invoice-Liquidity-Network/ILN-Smart-Contract)
2. Run the integration test suite from the frontend repo to confirm local setup
3. Join the Discord war room for cutover support; oncall maintainers are available 24/7 through T+7

### Cross-Repo Coordination Checklist

- [ ] **Smart Contracts repo:** Mainnet-parameter announcement + contract ABI frozen message
- [ ] **Frontend repo:** Deployment readiness + testnet-to-mainnet toggle instructions
- [ ] **This repo (main):** API completeness announcement + hardening summary
- [ ] **Social media**: Unified messaging across Twitter, LinkedIn (ILN account)
- [ ] **Discord**: Announcement pinned in #general-support with thread for Q&A
- [ ] **Telegram**: Forwarded message with link to long-form announcement

### Post-Announcement Ops

1. **SLO Monitoring:** Oncall dashboard active; error budgets reset at cutover
2. **Daily Sync:** 12:00 UTC standup for first 7 days to review metrics and support tickets
3. **Incident Response:** Escalation path documented; security issues routed to `security@invoiceliquidity.network`

---

## 5. Maintainer Launch Window Availability Plan

During the **Launch Window (Launch Day T-0 through T+7)**, core maintainers operate under a dedicated high-availability rota distinct from steady-state operations.

### Launch Rota Schedule (24/7 Coverage)

| Shift (UTC) | Primary Maintainer | Secondary Maintainer | Domain Focus |
|---|---|---|---|
| **00:00 - 08:00 UTC** | Protocol Lead | Infrastructure Lead | Soroban contracts, RPC stability, Indexer lag |
| **08:00 - 16:00 UTC** | QA / Security Lead | SDK Lead | Transaction signing, SDK integrations, API triage |
| **16:00 - 24:00 UTC** | Governance Lead | Community Lead | Multi-sig operations, Community support, Communications |

### Maintainer Availability Responsibilities
1. **Immediate Pager Triage**: Maintainers must respond to critical PagerDuty/Slack monitoring alerts within **15 minutes**.
2. **Contract Health Verification**: Run periodic health checks on contract state transitions and token balances.
3. **Daily Sync**: Standup every day at 12:00 UTC during the first 7 days to review error budgets, transaction volumes, and support tickets.
4. **Handoff Log**: Shift handoffs must document open issues, RPC status, and any pending pull requests.
