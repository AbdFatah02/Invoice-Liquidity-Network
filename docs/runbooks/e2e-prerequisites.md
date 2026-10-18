# Runbook: E2E prerequisites (fail-closed lifecycle verification)

**Control owner:** release engineering (primary), E2E suite maintainers (secondary)
**Scope:** cross-package E2E suite in `tests/e2e/` and its CI workflow `.github/workflows/e2e.yml`
**Related issues:** #1241–#1248 (wave-9)

---

## What this control guarantees

The E2E suite is the only place where the contract, SDK, indexer, oracle and
notifications are exercised together. Before this control it could report a green
run while testing nothing:

| Audit finding | Fix |
|---|---|
| `if (!isNodeRunning) return ctx.skip()` in every integration test (42 skipped tests per run) | Prerequisites are enforced with `tests/e2e/support/e2e-prerequisites.ts`; an unavailable dependency is an actionable failure |
| Contract IDs defaulted to placeholders (`C_DEPLOYED_CONTRACT_ID`, `C_*_REPLACE_ME`) and `contract-deployer/deploy.sh` wrote `dummy-contract-id-for-local-dev` | Placeholders are rejected; `scripts/provision-e2e-contract.mjs` provisions/verifies a real deployed contract; the deployer fails closed |
| Release CI grepped for `"<n> skipped"`, which the vitest reporter never emits, and swallowed the suite exit code with `\|\| true` | `scripts/check-e2e-coverage.mjs` reads the machine-readable vitest JSON report and fails on **any** skipped test, any required suite that did not run, and on `E2E_ALLOW_SKIP` being set |

### Invariants

- **I1 — Fail-closed dependencies.** An E2E suite passes only when its external
  dependencies are reachable. An unreachable Soroban RPC fails the suite with the
  RPC URL, the transport error and the recovery command.
- **I2 — Real contracts only.** Placeholder-shaped contract IDs are rejected
  before any SDK call. A contract ID must exist as a ledger entry on the
  configured RPC.
- **I3 — Opt-in skips.** Skipping requires `E2E_ALLOW_SKIP=1`, which is forbidden
  on CI and is itself a release-gate failure.
- **I4 — Deterministic readiness.** The RPC must return two consecutive valid
  `getHealth` and `getLatestLedger` JSON-RPC responses with a positive,
  non-regressing ledger sequence before any E2E test starts.
- **I5 — Protected-branch budgets.** Every branch listed in
  `e2e-skip-budgets.json` must have an explicit budget. `main` and `dev` both
  have a zero-skip budget; an omitted protected branch fails closed.

---

## Where it is enforced

| Layer | Artefact | What it proves |
|---|---|---|
| Test setup | `tests/e2e/support/e2e-prerequisites.ts` | the invariant implementation (single source, no per-file copies) |
| Unit/regression | `tests/e2e/prerequisites.test.ts` (runs on every `pnpm test:e2e`, no node needed) | success, failure, placeholder rejection, unreachable RPC, skip hatch |
| Replay/restart | `tests/e2e/disaster-recovery.test.ts` | backup → restore → replay resumes from a real on-chain ledger cursor; a cursor ahead of the chain head is rejected |
| Token boundary | `tests/e2e/multi-token.test.ts` | per-token decimals and "no placeholder token ID" boundary |
| Provisioning | `scripts/provision-e2e-contract.mjs` + `scripts/__tests__/provision-e2e-contract.test.mjs` | a real contract is deployed or verified; placeholders and unknown IDs fail |
| CI gate | `scripts/check-e2e-coverage.mjs` + `scripts/__tests__/check-e2e-coverage.test.mjs` | zero skipped tests, every required suite executed, no escape hatch |
| RPC readiness | `scripts/wait-for-stellar-rpc.mjs` | semantic health plus two non-regressing ledger observations; writes `rpc-readiness.json` |
| DR node provisioning | `scripts/provision-e2e-node.mjs` | idempotent startup/restart and post-operation readiness; writes `e2e-node-provisioning.json` |
| Deployer | `contract-deployer/deploy.sh` + `scripts/__tests__/contract-deployer.test.mjs` | no placeholder contract ID is ever published to `.docker-output/` |
| CI evidence | `.github/workflows/e2e.yml` uploads `.artifacts/` (artifact `e2e-coverage-evidence-<run_id>`) | raw results, readiness/provisioning state, skip reasons, branch policy, owner and recovery path |

---

## Run it locally

```bash
# 1. Provision the node and prove RPC readiness
node scripts/provision-e2e-node.mjs

# 2. Build the contract and provision a REAL contract ID (#1241)
cargo build --target wasm32v1-none --release
node scripts/provision-e2e-contract.mjs      # prints CONTRACT_ID=<id>

# 3. Run the suite against it
export CONTRACT_ID=<id from step 2>
pnpm test:e2e

# 4. Prove the suite executed, exactly as CI does (#1243)
mkdir -p .artifacts
pnpm exec vitest run tests/e2e --reporter=json --outputFile.json=.artifacts/e2e-results.json
node scripts/check-e2e-coverage.mjs --report=.artifacts/e2e-results.json \
  --budgets=e2e-skip-budgets.json --branch=main \
  --evidence=.artifacts/e2e-control-evidence.json
```

Expected result: every scenario runs, `Tests … | 0 skipped`, and the gate prints
`✓ E2E coverage gate passed`.

## Emergency escape hatch (local only)

```bash
E2E_ALLOW_SKIP=1 pnpm test:e2e
```

This downgrades a prerequisite failure into a skip **only** for
`E2EPrerequisiteError`s, and only on a local machine. It is rejected by
`scripts/check-e2e-coverage.mjs` (`skip-escape-hatch` violation) and must never be
set in `.github/workflows/e2e.yml`.

---

## Failure triage

| Symptom (verbatim error) | Cause | Recovery |
|---|---|---|
| `E2E prerequisite "stellar rpc" is not satisfied … unreachable (ECONNREFUSED)` | node not running / wrong port | `docker compose -f tests/e2e/docker-compose.yml up -d stellar-quickstart`, then re-run |
| `… "stellar rpc health" … reported status` | node up but not healthy (still catching up) | wait for `getLatestLedger` to answer, check `docker compose logs` |
| `E2E prerequisite "CONTRACT_ID contract id" is not satisfied … Placeholder contract IDs are rejected` | placeholder or unset contract ID | `node scripts/provision-e2e-contract.mjs` (#1241) |
| `✗ CONTRACT_ID=… is not a deployed contract on … (reason: not_found)` | contract ID does not exist on this network | unset `CONTRACT_ID` to deploy the WASM, or point it at a contract on this network |
| `✗ No compiled contract WASM found` | contract not built | `cargo build --target wasm32v1-none --release` |
| `✗ E2E coverage gate FAILED … [skipped-tests]` | the skip regression returned, or the escape hatch was used | inspect `e2e-coverage-evidence-*` artifact, fix the dependency, re-run without `E2E_ALLOW_SKIP` |
| `✗ E2E coverage gate FAILED … [missing-file]` | a required E2E file stopped running | confirm the file exists and is matched by `pnpm test:e2e` glob |
| `[rpc-ready] … invalid … response` | HTTP answered but RPC is not semantically ready | inspect `rpc-readiness.json` and node logs; re-run `node scripts/provision-e2e-node.mjs` |
| `protected branch … has no explicit skip budget` | branch protection and the versioned policy drifted | add the branch with an explicit reviewed budget to `e2e-skip-budgets.json` |
| `[missing-skip-reason]` | a permitted local skip supplied no reason | use the prerequisite helper or reporter metadata so the artifact contains cause and recovery |
| `ERROR: no built WASM found, so no real contract can be deployed.` (deployer) | compose deployer started before the build | build the WASM or pass `EXISTING_CONTRACT_ID` |

## Signals / monitoring

- **Signal:** skipped-test count in the E2E artifact. Healthy value: `0`.
- **Signal:** `e2e-coverage-evidence-*` artifact missing on a release run → the
  gate did not execute; treat as a control failure.
- **Metric equivalent:** the gate summary (`files/tests/passed/skipped/failed`)
  is emitted as JSON with `--json` and is the value to graph over time.

## Audit baseline and result (#1245–#1248)

The audited workflow used a single successful curl as readiness, had no
branch-owned budget file, did not persist skip causes, and provisioned the node
with an unverified `docker compose up`. The baseline was therefore **1
transport-only readiness observation, 0 versioned branch budgets, 0 structured
skip-reason records, and 0 post-provision readiness assertions**. After this
change the required values are **2 consecutive semantic RPC observations,
explicit zero budgets for 2/2 protected branches (`main`, `dev`), one structured
reason/recovery record per prerequisite skip, and one deterministic readiness
result after every ensure/restart operation**.

Restart/replay rehearsal:

```bash
node scripts/provision-e2e-node.mjs --restart \
  --evidence=.artifacts/e2e-node-restart.json
```

## Cross-repository notes

- Adjacent repos that consume `.docker-output/contract-id.txt` (the compose
  seeder, the frontend E2E job) now receive a *real* contract ID or the deployer
  fails; they must not assume a placeholder is present. No API changed.
- `sdk/src/e2e/local-node.test.ts` still guards with `ctx.skip()`; migrating it to
  the shared prerequisites helper is follow-up work outside the audited files of
  #1241–#1244 and does not affect this control's scope.

## References

- [E2E test scope](../e2e-test-scope.md)
- [CI/CD pipeline](../ci-cd.md)
- [Release runbook](../release-runbook.md)
- [Flaky test quarantine](../flaky-test-quarantine.md)
