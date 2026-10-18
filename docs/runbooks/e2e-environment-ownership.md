# Runbook: E2E environment ownership and credential rotation

**Control owner:** release engineering (primary), security on-call (escalation)
**Scope:** the cross-package E2E environment in `tests/e2e/` and its CI workflow `.github/workflows/e2e.yml`
**Machine-readable manifest:** [`tests/e2e/environment-ownership.json`](../../tests/e2e/environment-ownership.json)
**Enforcement:** `scripts/check-e2e-environment-rotation.mjs` (CI + local)
**Related issues:** #1241–#1244 (E2E fail-closed prerequisites), #1254 (this runbook)

---

## What this control guarantees

The cross-package E2E suite is the only place where the contract, SDK, indexer,
oracle and notifications are exercised together. It runs against a locally
provisioned Stellar node and deploys a *real* contract with real signing keys.

Who owns that environment — and when the identities it uses are rotated — must be
unambiguous and verifiable, otherwise a leaked key or a stale owner silently
becomes a release-integrity risk. This control makes ownership and rotation
**machine-checkable** rather than a paragraph in a document:

| Guarantee | Enforced by |
|---|---|
| A named primary owner (and escalation path) for the E2E environment | `tests/e2e/environment-ownership.json` → `owners`, validated by `scripts/check-e2e-environment-rotation.mjs` |
| Every E2E credential has a rotation interval and a `next_rotation_due` date | manifest `rotation.credentials[]`, validated for internal consistency (`last_rotated + rotation_days == next_rotation_due`) |
| The control fails the build when a credential is past its rotation due date | `scripts/check-e2e-environment-rotation.mjs` exits non-zero on `rotation-overdue` |
| Operators get an early warning before a credential lapses | `rotation.min_remaining_days` emits a `rotation-due-soon` warning in CI |
| Evidence is attached to every release | `.github/workflows/e2e.yml` runs the check and uploads its report inside the E2E evidence bundle (see `docs/runbooks/e2e-release-evidence.md`) |

---

## Ownership model

| Role | Responsibility | Escalation |
|---|---|---|
| **Primary owner** (`release-engineering`) | Owns the manifest, approves rotation PRs, is paged on a failed rotation gate | — |
| **Secondary owner** (`e2e-suite-maintainers`) | Keeps the suite and its fixtures up to date; acts when the primary is unavailable | security on-call |
| **Escalation** (`security-oncall`) | Handles a suspected credential compromise | incident response (`docs/runbooks/incident-response.md`) |

The machine-readable truth lives in `tests/e2e/environment-ownership.json`:

```json
{
  "owners": { "primary": "release-engineering", "secondary": "...", "escalation": "..." },
  "rotation": {
    "interval_days": 90,
    "min_remaining_days": 14,
    "credentials": [
      {
        "name": "E2E contract deployer identity",
        "location": "GitHub Actions secret E2E_DEPLOYER_SECRET_KEY",
        "rotation_days": 90,
        "last_rotated": "2026-10-01",
        "next_rotation_due": "2026-12-30"
      }
    ]
  }
}
```

Any change to ownership or a credential rotation is made by editing this manifest
in the same PR that performs the rotation, so the audit trail is the git history.

---

## Rotation procedure

Rotation cadence: **every 90 days** (`rotation.interval_days`), with a warning
window of 14 days (`rotation.min_remaining_days`).

1. **Open a rotation PR.** Generate a fresh keypair for each credential whose
   `next_rotation_due` is within the warning window:
   ```bash
   stellar keys generate e2e-deployer-$(date +%Y%m)
   stellar keys address e2e-deployer-$(date +%Y%m)
   ```
2. **Update the secret.** Store the new key in the corresponding GitHub Actions
   secret (the `location` field of the credential) and fund the new account on
   testnet. Never commit a secret value — only its `location`.
3. **Update the manifest.** Set `last_rotated` to the rotation date and
   `next_rotation_due` to `last_rotated + rotation_days`.
4. **Verify the control passes locally:**
   ```bash
   node scripts/check-e2e-environment-rotation.mjs --manifest=tests/e2e/environment-ownership.json
   # ✓ E2E environment ownership & rotation OK
   ```
5. **Merge.** CI runs the same check; a green run plus the uploaded
   `e2e-evidence-bundle-*` artifact is the rotation's proof of completion.

### Verifying the gate locally

```bash
# Real manifest, as of today
node scripts/check-e2e-environment-rotation.mjs

# Simulate a date to see the overdue behaviour
node scripts/check-e2e-environment-rotation.mjs --as-of=2027-01-15
# ✗ E2E environment rotation FAILED (1 violation)
#   [rotation-overdue] E2E contract deployer identity ... 
```

---

## Failure modes and recovery

| Symptom | Cause | Recovery |
|---|---|---|
| `✗ ... [rotation-overdue] ...` | a credential's `next_rotation_due` is in the past | rotate the credential (procedure above) and update the manifest in the same PR |
| `⚠ ... [rotation-due-soon] ...` | a credential lapses within `min_remaining_days` | schedule the rotation before the due date; the warning does not fail the build |
| `[invalid-manifest]` | the manifest is missing or malformed | restore `tests/e2e/environment-ownership.json` from git; it is required, not optional |
| `[inconsistent-dates]` | `next_rotation_due != last_rotated + rotation_days` | correct the manifest so the arithmetic is self-consistent |
| `[missing-runbook]` | the referenced runbook `runbook` path does not exist | restore this file or fix the `runbook` field |
| E2E workflow fails at the ownership step | the gate is working as intended | follow the rotation procedure; do **not** bypass the step |

---

## Signals / monitoring

- **Signal:** exit code of `scripts/check-e2e-environment-rotation.mjs` in
  `.github/workflows/e2e.yml`. Healthy value: `0` with zero violations.
- **Signal:** `rotation-due-soon` warning count. Healthy value: `0`.
- **Artifact:** the check's JSON report is included in the uploaded
  `e2e-coverage-evidence-<run_id>` artifact, so the ownership state at release
  time is reproducible.

---

## References

- [E2E prerequisites runbook](./e2e-prerequisites.md)
- [E2E release evidence bundle](./e2e-release-evidence.md)
- [Incident response](./incident-response.md)
- [E2E test scope](../e2e-test-scope.md)
