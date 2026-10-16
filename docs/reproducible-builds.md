# Reproducible Builds (Issue #1078)

Invoice Liquidity Network guarantees **reproducible builds** for all release artifacts, including the TypeScript SDK (`@iln/sdk`) and the CLI tool (`@invoice-liquidity/cli`).

A build is reproducible if given the exact same source code, build environment, and build instructions, any party can independently rebuild the software and obtain bit-for-bit identical binaries and distribution packages.

---

## Why Reproducibility Matters

In modern decentralized finance and payment network tooling, supply-chain attacks are a major threat vector. Compromising a build runner, a maintainer machine, or an intermediate dependency could inject malicious bytecode or malicious endpoints into an official package.

Reproducible builds provide:

1. **Independent Verification**: Third-party auditors, integrators, and community members can rebuild tarballs from source and verify that published artifacts on npm or GitHub Releases match the repository state without trusting the publisher's environment.
2. **Tamper Detection**: Any discrepancy between the published hash and the locally reproduced hash immediately alerts the ecosystem to compromised build infrastructure or tampered dependencies.
3. **Synergy with SLSA Provenance (#1077)**: SLSA provenance proves *where* and *how* an artifact was produced; reproducible builds prove that the artifact *could only have come from that exact source*.

---

## Technical Architecture

Determinism across independent builds is achieved through:

### 1. `SOURCE_DATE_EPOCH` Timestamp Normalization

All packaging utilities and archive creators respect the standard [`SOURCE_DATE_EPOCH`](https://reproducible-builds.org/docs/source-date-epoch/) specification. In ILN release and verification pipelines:

```bash
export SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct)
```

This guarantees file metadata timestamps inside `.tar.gz` (`.tgz`) archives are deterministic and correspond to the commit timestamp rather than runtime clock time.

### 2. Deterministic Bundling and Sorting

- **Bundling with `tsup` / `esbuild`**: Source modules are parsed, transpiled, and minified using deterministic AST ordering.
- **Sorted File Manifests**: Packaging (`pnpm pack`) orders files lexicographically, eliminating filesystem-dependent iteration differences.
- **Explicit `files` Inclusions**: Both `sdk/package.json` and `cli/package.json` define strict `files` allowlists (`["dist", "README.md"]`), excluding local artifacts, environment files, and temporary logs.

---

## Verifying Reproducibility

### Automated Verification Script

The repository includes an automated verification script at `scripts/verify-reproducible-builds.mjs`:

```bash
pnpm test:reproducible-builds
```

This script:
1. Derives `SOURCE_DATE_EPOCH` from the latest commit.
2. Performs two complete, isolated builds of `@iln/sdk` and `@invoice-liquidity/cli` into separate clean directories (`build-a` and `build-b`).
3. Computes the SHA256 checksum of each generated `.tgz` archive.
4. Asserts that `hash(build-a) === hash(build-b)`.

### Manual Step-by-Step Verification

Auditors can manually verify package reproducibility using standard terminal tools:

```bash
# 1. Checkout the specific release tag or commit
git checkout v0.1.0

# 2. Extract commit timestamp
export SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct)

# 3. Build and pack SDK (Run 1)
mkdir -p /tmp/run-a /tmp/run-b
pnpm --filter @iln/sdk build
(cd sdk && pnpm pack --pack-destination /tmp/run-a)

# 4. Clean and rebuild SDK (Run 2)
pnpm --filter @iln/sdk build
(cd sdk && pnpm pack --pack-destination /tmp/run-b)

# 5. Verify checksums match
sha256sum /tmp/run-a/*.tgz /tmp/run-b/*.tgz
```

Expected output:
```
cb5ceb711739818ea7c5b610c36bfe6136fa89c02ff2fae8be48bf7ae7d7c669  /tmp/run-a/iln-sdk-0.1.0.tgz
cb5ceb711739818ea7c5b610c36bfe6136fa89c02ff2fae8be48bf7ae7d7c669  /tmp/run-b/iln-sdk-0.1.0.tgz
```

---

## Continuous Integration Enforcement

The `.github/workflows/reproducible-builds.yml` workflow executes on every push to `main` and `dev`, as well as all pull requests touching SDK and CLI packages.

If any change introduces non-deterministic timestamps, unpinned random identifiers, or filesystem-dependent ordering, the reproducible builds CI gate fails and prevents merging into release branches.
