# SLSA Provenance Generation & Verification (Issue #1077)

Invoice Liquidity Network implements **SLSA Level 3 Provenance** across all official release workflows. This guarantees that published packages and CLI distribution tarballs are verifiable, tamper-resistant, and cryptographically traceable back to their exact source commit and GitHub Actions builder.

---

## What is SLSA Level 3 Provenance?

[SLSA](https://slsa.dev/) (Supply-chain Levels for Software Artifacts) is a security framework designed to prevent tampering, improve software integrity, and secure supply chains.

At SLSA Level 3:
1. **Isolated Build Environment**: Builds execute on ephemeral, isolated virtual environments with pinned dependencies.
2. **Cryptographically Signed Provenance**: The build generates an [in-toto](https://in-toto.io/) statement signed using GitHub Actions' OpenID Connect (OIDC) identity (`id-token: write`).
3. **Non-Falsifiable Builder Identity**: The attestation proves the artifact was built by `slsa-framework/slsa-github-generator` running on GitHub Actions from the official `Invoice-Liquidity-Network/Invoice-Liquidity-Network` repository.

---

## Release Pipeline Architecture

Provenance generation is integrated into both primary release pipelines:
- `.github/workflows/release.yml` — Automated changesets release workflow for monorepo packages.
- `.github/workflows/sdk-release.yml` — Version-tag release workflow for SDK and CLI packages.

### Gated Three-Stage Workflow

```
┌────────────────────────┐      ┌───────────────────────────────┐
│       1. pack          │      │        2. provenance          │
│ Build SDK/CLI packages ├─────►│ slsa-github-generator         │
│ Compute SHA256 hashes  │      │ Signed Level 3 in-toto record │
└────────────────────────┘      └──────────────┬────────────────┘
                                               │
                                               ▼
                                ┌───────────────────────────────┐
                                │          3. release           │
                                │ Verify provenance covers files│
                                │ Fail closed if unattested     │
                                │ Publish to npm & GitHub       │
                                └───────────────────────────────┘
```

1. **Pack**: Compiles `@iln/sdk` and `@invoice-liquidity/cli`, creates release tarballs (`.tgz`), and computes cryptographic SHA256 subjects.
2. **Provenance**: Triggers `slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v2.1.0` to sign the subject hashes into a `release.intoto.jsonl` file.
3. **Release Gate**: `needs: [pack, provenance]`. Before publishing to npm or GitHub Releases, the workflow extracts the attestation payload and asserts that every tarball digest is explicitly attested. **If provenance is missing or mismatched, the release halts immediately.**

---

## Verifying Provenance as an Integrator

### Method 1: Verification with `slsa-verifier`

The official [`slsa-verifier`](https://github.com/slsa-framework/slsa-verifier) CLI validates that the artifact matches the cryptographic provenance and originated from the designated repository and tag:

```bash
# Download the release artifact and its attestation
gh release download v0.1.0 --repo Invoice-Liquidity-Network/Invoice-Liquidity-Network

# Verify the artifact against the SLSA provenance file
slsa-verifier verify-artifact \
  ./iln-sdk-0.1.0.tgz \
  --provenance-path ./release.intoto.jsonl \
  --source-uri github.com/Invoice-Liquidity-Network/Invoice-Liquidity-Network \
  --source-tag v0.1.0
```

Expected output:
```
PASSED: Verified SLSA provenance
```

### Method 2: Verification with GitHub CLI (`gh attestation`)

For artifacts signed with GitHub Artifact Attestations:

```bash
gh attestation verify ./iln-sdk-0.1.0.tgz \
  --repo Invoice-Liquidity-Network/Invoice-Liquidity-Network
```

### Method 3: Inspecting the in-toto Statement

The `release.intoto.jsonl` file contains a DSSE (Dead Simple Signing Envelope) payload. You can inspect the decoded metadata with standard tools:

```bash
jq -r '.dsseEnvelope.payload' release.intoto.jsonl | base64 -d | jq .
```

The payload details:
- `subject`: List of release artifacts with their SHA256 digests.
- `predicateType`: `https://slsa.dev/provenance/v1`.
- `builder.id`: Pinned GitHub Actions generator workflow URI.
- `invocation.configSource`: Exact repository, commit SHA, and workflow entry point.

---

## Supply-Chain Synergy

SLSA Provenance (#1077) works hand-in-hand with **Reproducible Builds (#1078)**:
- Reproducible builds guarantee that given the source commit, anyone produces the exact same binary bits.
- SLSA provenance cryptographically proves that the published bits were produced by the official CI pipeline directly from that source commit.
