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
