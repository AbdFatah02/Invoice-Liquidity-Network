**SDK End-to-end tests (local Stellar node)**

- **Start local Stellar node:**

```bash
docker compose -f tests/e2e/docker-compose.yml up -d
```

- **Run tests for the SDK package only:**

```bash
pnpm --filter @iln/sdk test:e2e-local
```

- **Stop local Stellar node:**

```bash
docker compose -f tests/e2e/docker-compose.yml down
```

Notes:
- Tests are idempotent: they create fresh keypairs and fund them via the local friendbot.
- The CI workflow `.github/workflows/sdk-e2e-local-node.yml` runs these tests in a separate job.

## Cross-package E2E (`tests/e2e/`)

The root cross-package suite is fail-closed: it needs a live Soroban RPC **and** a
real deployed contract. Provision one and run the suite plus the release gate:

```bash
docker compose -f tests/e2e/docker-compose.yml up -d stellar-quickstart
cargo build --target wasm32v1-none --release
node scripts/provision-e2e-contract.mjs   # prints CONTRACT_ID=<id>
export CONTRACT_ID=<id>
pnpm test:e2e

mkdir -p .artifacts
pnpm exec vitest run tests/e2e --reporter=json --outputFile.json=.artifacts/e2e-results.json
node scripts/check-e2e-coverage.mjs --report=.artifacts/e2e-results.json --scan-sources
```

An unreachable node or a placeholder contract ID fails the run with the recovery
path; it never skips. See [E2E prerequisites runbook](./runbooks/e2e-prerequisites.md).
