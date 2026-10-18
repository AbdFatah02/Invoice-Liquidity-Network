# Runbook: E2E release evidence bundle

**Control owner:** release engineering
**Scope:** the `.github/workflows/e2e.yml` job and the `.artifacts/` it produces
**Related issues:** #1243 (coverage gate), #1253 (bounded RPC retry), #1254 (environment ownership), #1255 (this bundle)

---

## What this control guarantees

The E2E coverage gate (`scripts/check-e2e-coverage.mjs`, #1243) fails the build
when the suite is skipped or a required file did not run, but a passing job on its
own is not *evidence*: it does not tell a release reviewer which commit, which
run, which environment ownership state, or which RPC-retry behaviour the pass
corresponds to.

The release evidence bundle closes that gap. `scripts/build-e2e-evidence-bundle.mjs`
assembles a single, reproducible JSON document from the artefacts the run already
produces, and the workflow uploads it as `e2e-coverage-evidence-<run_id>`.

| Field | Source | Why a reviewer needs it |
|---|---|---|
| `metadata.commit` / `ref` / `run_id` / `actor` | git + GitHub environment | ties the pass to an exact commit and run |
| `results` | `.artifacts/e2e-results.json` (vitest JSON) | per-suite pass/fail/skip counts |
| `coverage_gate` | `scripts/check-e2e-coverage.mjs` outcome | proves the zero-skip gate actually ran |
| `environment_ownership` | `tests/e2e/environment-ownership.json` | who owned the environment and its rotation state (#1254) |
| `rpc_wait` | `.artifacts/rpc-wait.json` | how many bounded RPC retries were needed before the suite ran (#1253) |
| `provenance` | SHA-256 of every input artefact | inputs cannot be swapped after the fact |
| `verdict` | computed | the bundle itself states whether the run is releasable |

---

## The releasable-run invariant

A bundle is **complete** (`verdict.ok === true`) only when all of the following
hold. Any deviation is recorded as a violation with a stable `code`:

- `missing-results` — no valid vitest JSON report was found.
- `no-tests` — the suite ran zero tests.
- `failed-tests` — one or more tests failed.
- `skipped-tests` — one or more tests were skipped (the fail-closed prerequisite
  control was bypassed).
- `unsuccessful-report` — vitest marked the run unsuccessful.
- `coverage-gate-not-run` — `scripts/check-e2e-coverage.mjs` did not run.
- `coverage-gate-failed` — the gate exited non-zero.
- `environment-ownership-failed` — the rotation gate failed (#1254).
- `rpc-not-ready` — the Stellar RPC never became healthy.

The builder **always** writes the bundle (even on failure) so the violations are
visible in the artifact; it exits non-zero when the verdict is not ok.

---

## Build it locally

```bash
# Assuming a prior `pnpm test:e2e` run wrote .artifacts/e2e-results.json
node scripts/build-e2e-evidence-bundle.mjs \
  --root=. \
  --results=.artifacts/e2e-results.json \
  --ownership=tests/e2e/environment-ownership.json \
  --rpc-wait=.artifacts/rpc-wait.json \
  --coverage-exit=0 \
  --out=.artifacts/e2e-evidence-bundle.json
# ✓ E2E release evidence bundle is complete
```

Inspect the result:

```bash
node -e "const b=require('./.artifacts/e2e-evidence-bundle.json'); console.log(b.verdict, b.results);"
```

---

## Failure modes and recovery

| Symptom | Cause | Recovery |
|---|---|---|
| `[skipped-tests]` | a prerequisite was skipped, e.g. `E2E_ALLOW_SKIP=1` leaked into CI | remove the escape hatch; see `docs/runbooks/e2e-prerequisites.md` |
| `[coverage-gate-not-run]` | the coverage/evidence step ordering broke | confirm `scripts/check-e2e-coverage.mjs` ran before the builder in `.github/workflows/e2e.yml` |
| `[environment-ownership-failed]` | a credential rotation is overdue | follow `docs/runbooks/e2e-environment-ownership.md` |
| `[rpc-not-ready]` | the Stellar quickstart node never answered | inspect the "Wait for Stellar RPC" step log and the node container logs |
| `[missing-results]` | vitest crashed before writing the JSON report | re-run; if it persists, inspect `.artifacts/e2e-output.txt` |

---

## Signals / monitoring

- **Signal:** `verdict.ok` in `e2e-evidence-bundle.json`. Healthy value: `true`.
- **Signal:** `results.skipped`. Healthy value: `0`.
- **Signal:** `rpc_wait.attempts`. A sustained rise above `1` indicates a slow or
  flaky node image; investigate before it exhausts the retry budget.
- **Artifact retention:** 14 days, matching the coverage evidence artifact.

---

## References

- [E2E prerequisites runbook](./e2e-prerequisites.md)
- [E2E environment ownership and rotation](./e2e-environment-ownership.md)
- [E2E test scope](../e2e-test-scope.md)
- [CI/CD pipeline](../ci-cd.md)
