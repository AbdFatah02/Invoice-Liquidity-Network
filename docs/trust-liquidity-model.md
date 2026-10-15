# Trust & Liquidity Model (Version 1.0)
**Date:** August 30, 2026

This document represents the finalized Trust & Liquidity Model for the Invoice Liquidity Network, explicitly addressing the reviewer feedback from the initial internal design phase. It serves as a permanent, versioned public record of our architectural decisions.

## Reviewer Feedback & Final Decisions

### 1. Target Market Focus
- **Reviewer Question**: The initial draft was too broad regarding the target market. Who are the initial borrowers and what is the specific geographic focus?
- **Final Decision**: We are exclusively targeting SME suppliers based in emerging markets (primarily LATAM and Southeast Asia) interacting with US-based enterprise buyers. This minimizes currency volatility risk on the buyer side while maximizing the impact of early liquidity for suppliers.

### 2. KYB Provider Integration
- **Reviewer Question**: How will business identity and corporate risk be assessed at scale without bottlenecking liquidity?
- **Final Decision**: We will integrate with an established, regulated external KYB provider. Their API provides the necessary corporate structure unrolling and ultimate beneficial owner (UBO) verification required by our initial Liquidity Providers, without storing sensitive PII natively on our infrastructure (see [Privacy Policy](./privacy.md)).

#### 2.1 Provider Unavailability

KYB is a required onboarding control for business borrowers; provider unavailability never counts as a pass. The oracle uses a **temporary hard block with caller-driven retry**: if the required KYB adapter is missing or throws/times out, the verification response is not approved and carries the `rejected-kyb-unavailable` outcome. The borrower remains unapproved and cannot proceed to liquidity onboarding until a successful provider result is available. Provider rejection remains a distinct negative verification result.

The service does not silently fall back to heuristic-only approval, and there is no manual-review override in this contract. Callers should retry after provider health recovers, using bounded backoff. Production oracle wiring requires a live KYB result for approval and bypasses cached verdicts while this check is required; local/test deployments can explicitly opt into non-required KYB for fixtures only. A manual review route, if introduced later, must preserve the same KYB requirement and be separately approved and audited.

### 3. LP Cold-Start Posture
- **Reviewer Question**: How do we guarantee initial liquidity before a proven track record is established?
- **Final Decision**: We will deploy a "First-Loss Provision" managed via a dedicated treasury multi-sig during the cold-start phase. This provides a buffer for external LPs, ensuring that the first 5% of any default is absorbed by the protocol's treasury, drastically lowering the risk threshold for onboarding initial institutional capital.

### 4. Settlement Anchor Partner
- **Reviewer Question**: Which fiat-on/off ramp will handle the final mile settlement, and what are their SLA guarantees?
- **Final Decision**: We have selected regulated stablecoin issuers (like Circle for USDC) combined with Stellar Anchor Network members for local currency disbursement. This dual-anchor strategy guarantees near-instant USD-equivalent settlement while providing localized rails for SMEs who prefer native fiat.

#### 4.1 Sanctions screening integration point (pre-mainnet gate)

Screening is an off-chain compliance gate owned jointly by ILN's compliance
operator and the selected settlement-anchor partner. Before an account can
request an anchor deposit or payout, the onboarding service submits the
minimum partner-required identity data plus the Stellar public address,
transaction direction, asset, amount, and jurisdiction to the partner's
sanctions-screening interface. ILN does not select a screening vendor or claim
that screening is currently integrated; the partner contract and API schema
must define the exact identity fields, lawful basis, retention, and permitted
use before production credentials are enabled.

The screening adapter returns a case reference and one of `clear`, `potential_match`,
or `unavailable`. Only `clear` may proceed. A potential match places the
settlement request on compliance hold: no fiat instruction is sent and no
on-chain settlement action is initiated by the integration. An unavailable,
timed-out, malformed, or indeterminate response also fails closed and remains
on hold; bounded retries use an idempotency key derived from the ILN request
ID. Repeated failures page the operator and leave the request pending rather
than treating the outage as approval.

The operator reviews potential matches through the partner's documented
case-resolution channel. A false-positive release requires a recorded,
authorized partner decision and case reference; ILN operators cannot override
the screening result. The user receives a generic pending-review status that
does not disclose list data. Appeals follow the partner's published process.
Record the decision, timestamp, reviewer/partner case reference, and outcome,
but do not copy raw watchlist results into ILN logs. KYB and sanctions checks
share the same compliance-hold state and fail-closed user experience, while
remaining separate decisions. Mainnet launch is blocked until the partner
interface, ownership, escalation SLA, retention terms, and end-to-end tests
are approved and documented.

---

## 5. Settlement-Anchor Partner Failure & Insolvency Analysis

This section analyzes protocol exposure, failure modes, and recovery paths in the event that a settlement-anchor partner experiences either a temporary operational outage or a permanent insolvency event.

### 5.1 Scenario Classification & Risk Exposure

| Failure Scenario | Root Cause | Impacted Phase | User Fund Exposure | Protocol Response / Fallback |
|---|---|---|---|---|
| **Temporary Outage** | API downtime, SEP-24/SEP-31 endpoint failure, banking window delays | In-flight payout or deposit | Zero capital loss; temporary delay in fiat payout | Automatic transaction timeout revert; retry via secondary Stellar anchor |
| **Anchor Insolvency** | Anchor bankruptcy, regulatory seizure, loss of fiat reserve backing | Fiat off-ramp holding reserves | On-chain Soroban funds remain safe; unredeemed fiat vouchers at risk | Multi-anchor diversification, on-chain circuit breakers, treasury insurance buffer |

### 5.2 Recourse & Fallback Mechanics

1. **Smart Contract Escrow Safety**:
   - Soroban smart contract escrow funds are non-custodial and locked against on-chain conditions. Anchor downtime does not allow unauthorized withdrawal of on-chain collateral or LP funds.
2. **Timelocked Auto-Revert**:
   - If an anchor fails to confirm fiat delivery within the designated SEP-24 completion window (default: 24 hours), the smart contract state machine allows the borrower or funder to trigger an automated timelocked cancellation, releasing locked assets back to the original caller.
3. **Multi-Anchor Fallback Routing**:
   - The protocol client maintains a registry of active SEP-compliant Stellar anchors per geographic jurisdiction. When an anchor endpoint fails health checks or exceeds error thresholds, client routing automatically shifts new off-ramp volume to alternative secondary anchors.

### 5.3 Protocol Mitigations & Risk Controls

- **Anchor Diversification**: The protocol requires at least two independent Stellar Anchor Network partners per supported currency corridor (e.g., LATAM BRL/MXN, SEA IDR/PHP).
- **Automated Circuit Breakers**: If an anchor's error rate exceeds 5% over a 15-minute sliding window, the protocol automatically pauses new settlement assignments to that anchor.
- **Treasury First-Loss Protection**: In the event of a catastrophic anchor insolvency impacting in-transit user funds, the protocol's First-Loss Provision treasury buffer absorbs verified losses up to the defined cap before LP principal is impacted.

---
*These decisions mark the conclusion of the Trust & Liquidity Model design phase and govern the v1 mainnet deployment.*

## 6. Simultaneous LP Withdrawal Stress Analysis

### 6.1 Scope and current design boundary

The invoice contract reference describes LP capital as funding individual invoices, supports partial funding, and describes an LP priority queue. It does not define a pooled-share redemption API, withdrawal notice period, withdrawal queue, or guarantee that an LP can redeem capital committed to an unpaid invoice. This analysis therefore stress-tests a **hypothetical pooled deployment**, not a claim that the current contract implements pool withdrawals. Capital committed to an invoice is treated as locked until repayment or another contract-defined terminal outcome; only uncommitted cash is immediately liquid.

The 5% treasury first-loss provision covers a defined slice of credit losses on defaults. It is not a liquidity reserve and does not make locked invoice capital available during a withdrawal run.

### 6.2 Normalized simultaneous-withdrawal model

Assume a pool has 100 units of LP capital immediately before a panic. 60 units are committed to invoices and cannot be redeemed immediately; 40 units are idle cash. There are no repayments, asset sales, or new deposits during the withdrawal window. LPs submit withdrawal requests simultaneously, sized as a share of total pool capital.

| Requested withdrawals | Request size | Immediately payable from 40 idle units | Remaining queued/unpaid | Immediate fulfillment |
|---|---:|---:|---:|---:|
| 25% severity | 25 | 25 | 0 | 100% |
| 50% severity | 50 | 40 | 10 | 80% |
| 75% severity | 75 | 40 | 35 | 53.3% |
| 90% severity | 90 | 40 | 50 | 44.4% |

The figures are a deterministic liquidity-accounting example, not a forecast. They exclude defaults, fees, token depegs, and secondary-market sales. If requests are fulfilled first-come-first-served rather than pro rata, early callers can receive all 40 liquid units and late callers can receive nothing, even when request sizes are equal.

### 6.3 Failure mode and proposed controls

There is no documented orderly redemption path in the current design boundary. A pooled implementation that promises synchronous, full redemption would hit a **liquidity cliff** once aggregate requests exceed idle cash (40% in this example). Partial or delayed withdrawals can degrade orderly only if queueing, priority, and repayment allocation are specified in advance. This does not imply that an invoice defaults: it means the LP cannot exit on demand while capital remains committed.

Before introducing pooled LP shares, the contract design should specify:

1. **Epoch-based withdrawal queue:** batch requests at a published cutoff and satisfy them pro rata from available cash and realized repayments. Carry unpaid amounts forward without giving transaction-order priority; disclose that locked capital is not immediately redeemable.
2. **Funding circuit breaker:** pause new invoice deployment when liquid assets fall below an explicitly governed threshold or queued withdrawals exceed available cash. A pause protects remaining liquidity from additional commitments; it does not create cash or cancel existing obligations.
3. **Liquidity-aware pricing:** consider an utilization premium for *new* funding only if simulations show it attracts replacement liquidity without making borrower pricing pathological. Fees cannot solve an immediate run and should not be described as a redemption guarantee.
4. **Run disclosures and monitoring:** publish liquid/committed/queued balances, queue age, and repayment assumptions, and test recovery as invoices repay under base and stressed default assumptions.

These are design recommendations, not deployed protections. The applicable Soroban implementation is maintained in the separate [smart-contract repository](https://github.com/Invoice-Liquidity-Network/ILN-Smart-Contract); no withdrawal logic is claimed here until that implementation defines and tests it.
