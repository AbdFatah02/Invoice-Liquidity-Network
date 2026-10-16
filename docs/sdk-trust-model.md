# SDK Trust Model

This document explains the trust assumptions, key management guidelines, security assumptions, threat model, and best practices for `@iln/sdk`. It is intended for integrators who need to understand what the SDK checks, what it delegates, and what must be protected outside the SDK.

For the protocol-wide attack surface, see [threat-model.md](./threat-model.md). For smart contract authorization logic, see [contracts/invoice-contract.md](./contracts/invoice-contract.md). For package provenance and supply-chain verification, see [security.md](./security.md).

---

## Trust Model Overview

`@iln/sdk` is a thin client. It builds Stellar/Soroban transactions, validates address format, enforces signer identity, and delegates everything else — business-rule enforcement, cryptographic verification, and key custody — to the chain and to the signer implementation you provide.

### Trust chain

```
User (holds private key in Freighter or backend)
  │  signs via createFreighterSigner or createKeypairSigner
  ▼
SDK (builds XDR, validates address format, enforces signer identity match)
  │  submits over TLS
  ▼
Soroban RPC Node (simulates, prepares, and forwards the transaction)
  │
  ├───────────────▶ Oracle Service (only on the fund_invoice() path when
  │                 require_oracle_verification: true — off-chain payer
  │                 verification; gates whether funding proceeds)
  │
  ▼
Stellar Network / Soroban Contract (cryptographically verifies signature, enforces rules)
  │  emits contract events
  ▼
Indexer (read-only event mirror, eventually consistent)
  │  read by dashboards, oracle-service history lookups, and…
  ▼
Notifications (read-only event consumer — email / webhook / SMS / WebSocket)
```

The oracle-service hop is conditional: it only enters the trust chain for
`fund_invoice()` calls made with `require_oracle_verification: true`. For every
other flow (`submit_invoice`, `mark_paid`, `claim_default`, all reads) the chain
is exactly the one documented above. Notifications is never on a write path — it
observes the same contract events the indexer does and cannot influence them.

**What breaks at each hop if that hop is compromised:**

| Compromised hop | Impact |
|---|---|
| User's key (stolen or phished) | Attacker can submit, fund, pay, or claim default on behalf of the user |
| SDK configuration (`rpcUrl`, `contractId`, `networkPassphrase`) | SDK may target a malicious contract or a different network |
| Soroban RPC node | Simulation results can be forged; prepared XDR may differ from simulated XDR |
| Oracle service (`oracle-service/`, `fund_invoice()` with `require_oracle_verification: true` only) | A compromised oracle can **falsely verify a fraudulent payer** — letting an LP fund an invoice the fraud heuristics should have blocked — or **falsely block a legitimate payer**, denying funding. It cannot move funds itself, forge a signature, or alter contract state; its only power is the pass/fail verdict the caller uses as a funding gate. A stale or offline oracle fails safe toward rejection (see [oracle-service.md](./oracle-service.md) §"Cache staleness" and the `unknown` vs `unverified` distinction). |
| Network / contract | Protocol-level invariants are violated; out of scope for the SDK |
| Indexer | Dashboards show stale or incorrect state; canonical state on-chain is unaffected |
| Notifications (`notifications/`) | A compromised notification service can **send misleading, missing, or spoofed notifications** (e.g. a fake "invoice paid" email, or suppression of a real default alert). It **cannot move funds, change invoice state, or influence the contract, RPC node, or oracle** — this is the key distinction from the RPC and contract hops, which sit on the write path. Its blast radius is limited to what a recipient believes has happened; canonical state remains on-chain and independently verifiable via the SDK's read methods or a second indexer. Webhook payloads are HMAC-SHA256 signed with a per-subscription secret so a downstream receiver can still detect tampering — see [notifications.md](./notifications.md). |

---

## Security Assumptions

The SDK provides its stated security properties only when all of the following are true. If any assumption is violated, the protection it supports is lost.

| Assumption | If violated |
|---|---|
| The Soroban RPC node is honest and TLS-terminated | Simulation results may be forged and bad XDR may be prepared for signing |
| `contractId` in config matches the genuine ILN deployment | SDK targets an attacker-controlled contract that can steal assets |
| `networkPassphrase` in config is correct for the target network | Signed transactions may be replayed on a different network |
| The signer holds the correct keypair and protects it from disclosure | Unauthorized transactions can be submitted using the stolen identity |
| The calling application does not mutate SDK internals or inject hostile callbacks | Prototype pollution or callback injection can corrupt transaction construction |
| Private keys never leave the signer boundary | Key theft enables full account takeover without any further SDK involvement |
| Batch operations all originate from the same source account | Mixing accounts in a batch produces unpredictable authorization failures |
| `OfflineManager` storage is not accessible to untrusted code | Queued pre-signed payloads can be replayed or tampered with |

---

## What the SDK validates

- **Stellar address format**
  - The SDK converts addresses using `Address.fromString(address)` before contract invocation.
  - Invalid Stellar account IDs are rejected at the SDK boundary before transaction simulation.

- **Input serialization**
  - Numeric fields such as `amount`, `dueDate`, and `discountRate` are converted to Soroban SCVals.
  - The SDK enforces TypeScript types for common payload shapes, but type safety is only compile-time.

- **Signer identity checks**
  - State-changing operations verify the signer public key matches the expected `freelancer`, `funder`, or payer address when required.
  - This prevents SDK calls from being signed by the wrong account.

---

## What the SDK does not validate

- **Payer solvency or off-chain funds**
  - The SDK does not verify whether a payer has sufficient balance outside of contract state.
  - It does not validate external financial agreements, creditworthiness, or off-chain payment commitments.

- **Oracle or external data**
  - Any off-chain evidence, price feeds, or external validation required by business logic is outside the SDK.
  - The SDK only packages the transaction and relies on the contract, off-chain oracle service (`oracle-service/`), and network to evaluate observable state.
  - For detailed trust boundaries and honest scoping regarding what the oracle verifies (on-chain payment behavior, default frequency, rapid succession fraud signals) versus what it does not verify (real-world corporate entity existence, legal KYB), refer to [docs/oracle-service.md](./oracle-service.md).
  - The oracle-service hardening work — asymmetric cache TTL, explicit cache invalidation on new indexed activity, `unknown` vs `unverified` handling so a provider outage cannot silently degrade verdicts, rate limiting, and the Prometheus alert set (`OracleFraudFlagRateHigh`, `OracleAllVerificationsRejected`, `OracleNoVerifications`, …) — is documented in [docs/oracle-service.md](./oracle-service.md). Integrators relying on `require_oracle_verification: true` should read its "Cache staleness" and "Monitoring" sections, because the oracle's failure modes become part of your funding path's trust surface.

- **Contract policy rules and token allowlists**
  - The SDK does not independently maintain the contract token allowlist or business rule enforcement.
  - Token authorization, amount ranges, discount rate limits, and approval logic are enforced by the contract and the RPC node during simulation/submission.

- **Complete semantic validation**
  - The SDK validates low-level input shape and address format, but it is not a complete policy engine.
  - It does not validate whether a transaction is semantically correct for your application beyond the contract invocation.

---

## What the SDK trusts

- **Soroban RPC node**
  - The SDK depends on `server.simulateTransaction(...)`, `server.prepareTransaction(...)`, `server.sendTransaction(...)`, and `server.pollTransaction(...)`.
  - All contract simulation, transaction preparation, and submission status are trusted to the RPC node.

- **Horizon/RPC account state**
  - Source account lookup uses `server.getAccount(address)` and trusts the node's account snapshot.
  - If the node is compromised, the SDK may build transactions from stale or invalid account state.

- **Transaction signer**
  - The SDK trusts the signer implementation returned by `createKeypairSigner`, `createFreighterSigner`, or any custom `TransactionSigner`.
  - Signing is delegated to the secure private key holder; the SDK does not inspect or validate secret keys.

- **Network configuration and contract ID**
  - The SDK trusts the `contractId`, `rpcUrl`, and `networkPassphrase` provided in configuration.
  - It does not verify that the contract address belongs to the genuine Invoice Liquidity Network deployment.

---

## Trust levels by component

- **SDK input validation**: Low-to-moderate trust
  - Addresses are checked for format, but contract rules and business semantics are not fully validated.

- **Soroban RPC node**: High trust
  - The SDK relies on the node for correct simulation results, XDR transaction preparation, and final transaction status.

- **Horizon RPC/account service**: High trust
  - Account state and transaction submission rely on a trusted Stellar network endpoint.

- **Signer implementation**: High trust
  - Private key handling and XDR signing must be secure and trusted.

- **Contract logic**: High trust
  - Business rules, token allowlists, and amount constraints are enforced by the deployed contract.

---

## Key Management Guidelines

The `TransactionSigner` interface is the highest-trust boundary in the SDK. Choose the right implementation for your environment and follow the guidance below.

### Browser / frontend (Freighter)

Use `createFreighterSigner` for any integration that runs in a user's browser. Freighter stores private keys in the extension's secure enclave and never exposes them to page JavaScript.

```typescript
import { createFreighterSigner, ILNSdk } from "@iln/sdk";

const signer = createFreighterSigner();
const sdk = new ILNSdk({
  contractId: process.env.CONTRACT_ID,
  rpcUrl: process.env.RPC_URL,
  networkPassphrase: process.env.NETWORK_PASSPHRASE,
  signer,
});
```

Rules for browser signing:

- Never bundle a `secretKey` in client-side code or environment variables that are embedded in the bundle.
- `createFreighterSigner` internally calls `assertFreighterNetwork` to verify the extension is connected to the expected `networkPassphrase`. If the user's wallet is on the wrong network, the SDK throws before signing.
- Always display the invoice ID, counterparty address, and amount to the user before they approve the signing prompt. The signing dialog itself is controlled by the extension; your UI context is what the user sees first.

### Backend / Node.js (keypair signer)

Use `createKeypairSigner` only in isolated, server-side processes where the secret key is never exposed to the network or browser.

```typescript
import { createKeypairSigner, ILNSdk } from "@iln/sdk";

const signer = createKeypairSigner(process.env.SECRET_KEY);
const sdk = new ILNSdk({
  contractId: process.env.CONTRACT_ID,
  rpcUrl: process.env.RPC_URL,
  networkPassphrase: process.env.NETWORK_PASSPHRASE,
  signer,
});
```

Rules for backend signing:

- Load `SECRET_KEY` from environment variables or a secrets manager (e.g., AWS Secrets Manager, Vault). Never hardcode it.
- Never log `secretKey`, the `Keypair` object, or signed XDR strings.
- Run the signing process in a network-isolated environment with no inbound public access.
- Rotate keys on a defined schedule. Stellar supports adding and removing signers from an account without disrupting the account's on-chain history.
- Restrict filesystem and process access in the signing service so that a compromised dependency cannot read environment variables.

### Production backend (HSM or external KMS)

For production deployments that require hardware-level key isolation, implement a custom `TransactionSigner` that delegates to an HSM, AWS KMS, or Hashicorp Vault. The private key never leaves the hardware boundary.

```typescript
import type { SignTransactionOptions, TransactionSigner } from "@iln/sdk";

function createVaultSigner(publicKey: string): TransactionSigner {
  return {
    async getPublicKey() {
      return publicKey;
    },
    async signTransaction(transactionXdr: string, options: SignTransactionOptions) {
      // Send XDR to Vault Transit engine (or HSM API) for signing.
      // The secret key never leaves the Vault boundary.
      const response = await vault.transit.sign({
        name: "iln-signer",
        input: transactionXdr,
        hash_algorithm: "sha2-256",
      });
      // Rehydrate the transaction and inject the signature.
      return attachSignature(transactionXdr, response.signature, options.networkPassphrase);
    },
  };
}
```

The `TransactionSigner` contract guarantees that:
- `getPublicKey()` returns the Stellar public key (G... address) corresponding to the key material.
- `signTransaction(xdr, options)` returns a fully signed XDR string using the same key material.

If your custom signer returns a public key from one keypair but signs with another, the on-chain signature verification will fail, and you will receive a `TransactionFailedError`.

### Key isolation rules (all environments)

- **One keypair per role.** Freelancers, funders, and payers should each use distinct Stellar accounts. Sharing a keypair across roles can cause identity confusion in signer identity checks.
- **Separate testnet and mainnet keys.** Never use the same `secretKey` on both networks. `ILN_TESTNET` is exported from `sdk/src/signers.ts` as a convenience config for testnet.
- **Do not use protocol keys for admin or treasury operations.** If the contract has admin or upgrade authorities, use a dedicated keypair managed separately from signing keys used by SDK operations.

---

## Verifying SDK Provenance

Supply chain attacks targeting npm account takeovers or compromised credentials pose a major threat to DeFi integrators. Even if a publisher account is compromised on npm, cryptographic build provenance guarantees that the package was generated directly from this repository's audited source code via GitHub Actions OIDC and Sigstore, rather than uploaded from an unauthorized developer machine.

Follow these verification steps when installing or upgrading `@iln/sdk` (or `@iln/sdk-next`).

### 1. Verify npm Registry Attestation

Inspect the provenance attestation recorded on the npm registry:

```bash
# Inspect the provenance metadata for the target release:
npm view @iln/sdk@<version> --json | jq '.provenance'

# Or query the npm attestations endpoint directly:
curl -s https://registry.npmjs.org/-/npm/v1/attestations/@iln/sdk@<version> | jq
```

Verify that the output contains the following fields:
- **Repository:** `Invoice-Liquidity-Network/Invoice-Liquidity-Network` (or `https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network`)
- **Workflow:** `.github/workflows/sdk-release.yml` or `.github/workflows/release.yml`
- **Commit SHA:** Matches the official release tag on GitHub.

### 2. Cryptographic Attestation Verification via GitHub CLI

Use GitHub CLI's `gh attestation verify` to cryptographically validate the Sigstore bundle and SLSA Level 3 build provenance:

```bash
gh attestation verify \
  "$(npm pack @iln/sdk@<version> --silent)" \
  --repo Invoice-Liquidity-Network/Invoice-Liquidity-Network
```

**Expected verification output:**
- Signer: `https://token.actions.githubusercontent.com`
- Source repository: `Invoice-Liquidity-Network/Invoice-Liquidity-Network`
- Status: `Loaded digest ... from ... Verified against expected repository`

If verification fails or the repository does not match, **do not install or execute the package**, and immediately notify the security team at `security@iln.finance`.

### 3. Verify Tarball Checksum Against GitHub Releases

Every official release publishes a canonical `checksums.txt` file on GitHub Releases. Compare your locally downloaded archive hash against the published digest:

```bash
# Generate the SHA-256 hash of the packed npm archive:
npm pack @iln/sdk@<version> --silent | xargs sha256sum

# Compare the hash against the checksums on:
# https://github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network/releases/tag/v<version>
```

### 4. Continuous Verification in CI Pipelines

Integrators should automate provenance and signature verification in their CI/CD deployment pipelines:

- **Enforce Immutable Lockfiles:** Always use `pnpm install --frozen-lockfile` or `npm ci` in production builds.
- **Audit Registry Signatures:** Run `npm audit signatures` as part of your CI dependency check stage.
- **Dependency Review Action:** In GitHub Actions, add the `actions/dependency-review-action` to flag unverified package additions in pull requests.

---

## SDK-Specific Threat Model

The following threats are specific to SDK integration. For the full protocol threat model — including frontend, API, indexer, and governance surface — see [threat-model.md](./threat-model.md).

### Dependency compromise

**Threat:** A malicious npm package in the dependency tree overrides globals (`fetch`, `URL`, crypto helpers) or injects payload-shaping callbacks that mutate transaction parameters after SDK validation.

**SDK mitigation:** The SDK uses typed helpers, validates payload shapes before SCVal encoding, and keeps the transaction construction surface small and explicit.

**Integrator action:**
- Verify the SDK's package attestation on every install using the steps in [Verifying SDK Provenance](#verifying-sdk-provenance).
- Pin `@iln/sdk` to an exact version in your `package-lock.json` or `yarn.lock`.
- Review transitive dependency updates before merging automated dependency PRs.

### XDR interception and replay

**Threat:** An attacker mutates the XDR between simulation and signing, or replays a signed transaction envelope on a different network or at a future time.

**SDK mitigation:** The SDK builds, prepares, and signs in one validated pipeline using the same transaction object. The `networkPassphrase` is embedded in every signed transaction, binding it cryptographically to the target network.

**Integrator action:**
- Never accept raw XDR payloads from user input, third-party APIs, or untrusted sources and pass them directly to a signer.
- If you cache or queue XDR between stages, store it in a tamper-evident location and re-validate before signing.

### Signer impersonation

**Threat:** A custom `TransactionSigner` implementation returns a different public key from `getPublicKey()` than the one actually used to sign in `signTransaction()`.

**SDK mitigation:** Before building a write transaction, the SDK calls `signer.getPublicKey()` and compares the result against the expected role address (`params.freelancer`, `params.funder`, or `params.payer`). A mismatch throws before any transaction is built.

**Integrator action:**
- Prefer `createKeypairSigner` or `createFreighterSigner` over custom implementations.
- If you write a custom signer, ensure `getPublicKey()` and `signTransaction()` derive the address from the same underlying key material.
- Test your custom signer against a full SDK integration (not just the interface) before deploying.

### Configuration poisoning

**Threat:** An attacker controls `contractId`, `rpcUrl`, or `networkPassphrase` — for example, by injecting environment variables at runtime or by intercepting a dynamic config fetch, leading the SDK to target an attacker-controlled contract.

**SDK mitigation:** The SDK performs an automatic sanity check on initialization by comparing the configured `contractId` against a known-good registry (`KNOWN_OFFICIAL_CONTRACT_IDS`). If the ID is unrecognized, it emits a loud, un-missable warning (`[ILNSdk WARNING] Configured contractId ... does not match any known official ILN deployment`). This check is non-blocking to support self-hosted/custom deployments while alerting developers to misconfiguration.

**Integrator action:**
- Pay attention to `[ILNSdk WARNING]` logs on startup during development and deployment.
- Hardcode or pin `contractId` and `networkPassphrase` in server-side environment config, not in user-supplied input or a dynamically fetched remote file.
- Load config from environment variables at startup; do not accept config overrides from API request parameters or query strings.
- Maintain a separate, trusted reference for the canonical `contractId` (for example, pinned in a checked-in constants file), and validate against it at startup.

### Offline queue exposure

**Threat:** The `OfflineManager` queues operations when the network is unavailable and persists them to storage (e.g., `localStorage` in a browser). Unsigned XDR stored in the queue can be read, modified, or replayed by any code with access to that storage.

**SDK behavior:** Operations are enqueued before signing. The signer is invoked at submission time, not at enqueue time, so the queue contains pre-signing parameters rather than signed payloads. However, the parameters are enough for an attacker to construct and submit equivalent transactions if they can also access a signer.

**Integrator action:**
- In sensitive deployments, use encrypted or access-controlled storage for the offline queue.
- Scope the `OfflineManager`'s storage key so that different users or roles cannot read each other's queues.
- Monitor for unexpected queue submissions after reconnect.

---

## Recommended best practices

- **Use a dedicated Soroban RPC / Horizon node for production workloads.**
  Dedicated nodes reduce risk of shared or misconfigured infrastructure leaking stale or incorrect state.

- **Verify transaction simulation before signing and sending.**
  The SDK uses simulation to expose contract errors before signing, but client code should inspect simulation results and handle failures explicitly.

- **Never expose secret keys to frontend code.**
  Use browser-safe signing providers such as Freighter and keep `createKeypairSigner` secrets on backend services only.

- **Validate application-level business data before passing it to the SDK.**
  Check invoice amounts, due dates, and counterparty addresses in your own code to avoid invalid user input.

- **Confirm `contractId` and `networkPassphrase` are correct for your deployment.**
  A wrong contract ID or network configuration can cause the SDK to target the wrong Soroban contract. Validate these values at startup against a pinned reference — not from the same source as your secret key.

- **Audit custom `TransactionSigner` implementations.**
  Any code you write that implements `TransactionSigner` sits in the highest-trust position in the SDK stack. Have it reviewed separately from the rest of your integration.

- **Use testnet for all development and staging.**
  Export `ILN_TESTNET` from `sdk/src/signers.ts` as your base config. Never use mainnet keys in a development or CI environment.

- **Inspect simulation results for fee and auth anomalies.**
  Before accepting a `simulateTransaction` result, check for unexpected fee values, authorization requirements, or contract errors. Abort if the result does not match your expectations.

- **Monitor for unexpected transactions.**
  Subscribe to address-level events via the indexer to detect unauthorized fund movements against your accounts. An unexpected `InvoiceFundedEvent` or `InvoiceDefaultedEvent` for your address is a signal of key compromise or misconfiguration.

---

## Security notes on XDR serialization

- The SDK serializes transactions to XDR for signing and submission.
  Raw XDR is treated as the canonical transaction format between the SDK and signer.

- Do not trust XDR payloads received from untrusted sources.
  Only sign XDR generated by your own SDK instance or a trusted client-side provider.

- `TransactionBuilder.fromXDR(...)` is used internally to rehydrate signed transactions.
  This call assumes the transaction belongs to the configured network passphrase.

- Avoid exposing signed XDR in insecure logs, browser storage, or third-party channels.
  Signed transactions can be submitted or replayed if intercepted before network submission.

---

## Multi-Endpoint Soroban RPC Provider Failover Model (#1107)

As validated in the system-level RPC failure drill (`docs/game-days/2026-09-rpc-node-outage-drill.md`), `@iln/sdk` supports fallback endpoint configuration (`rpcUrls: string[]`).

- **Primary Outage Failover**: When the primary RPC node becomes unreachable (HTTP 503 / network timeout >200ms), the SDK automatically attempts execution on secondary fallback endpoints.
- **Failover Latency**: Verified at **420ms total failover time** under complete primary RPC unavailability.
- **Degraded Recovery**: Indexer enters exponential backoff resync and oracle-service enters cached read-mode to maintain protocol stability without transaction loss.

**Related documents:**

- [threat-model.md](./threat-model.md) — Protocol-wide attack surface (frontend, API, indexer, governance)
- [contracts/invoice-contract.md](./contracts/invoice-contract.md) — On-chain authorization and state machine
- [security.md](./security.md) — Package provenance and SLSA Level 3 verification
- [oracle-service.md](./oracle-service.md) — Oracle hop trust boundaries, cache-staleness hardening, and fraud-signal monitoring for the `require_oracle_verification` path
- [notifications.md](./notifications.md) — Webhook HMAC signing and WebSocket subscription security
- [game-days/2026-09-rpc-node-outage-drill.md](./game-days/2026-09-rpc-node-outage-drill.md) — System drill report for primary RPC provider outage

