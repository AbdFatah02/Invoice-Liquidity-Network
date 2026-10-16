# Documentation Versioning

## Policy: single track, always latest

The documentation site is **not versioned**. There is one track — `latest` — and it
always describes the newest development version of the protocol: the build currently
deployed to Stellar testnet. Pages are updated in place; there are no per-release
snapshots and no version switcher.

This is a deliberate scoping decision. Until the protocol ships to mainnet the
contract surface is still moving, and maintaining parallel documentation trees would
cost more than it returns. Versioned docs are a much larger undertaking and would be
tracked separately if maintainers decide the trade-off has flipped.

The cost of the trade-off is real: a page can describe a method, event, or field that
only exists in a release you have not deployed. The version banner shown at the top of
every page exists to make that visible rather than surprising.

## What the banner declares

| | Value |
|---|---|
| Documentation track | `latest` |
| Network | Stellar testnet |
| Contract (`invoice_liquidity`) | `0.1.0` |
| Contract ID | `CCPASLHKRFBMVV5PZG3LKDGKFEDXZMB5U7DK42CVLUVWCMUCSRPVBIMO` |
| SDK (`@iln/sdk`) | `0.1.0` |

These values are declared once, in [`docs/version-manifest.json`](version-manifest.json),
and mirrored into `packages/docs/lib/docs-version.ts` (the deployed Nextra 3 site) and
`docs/theme.config.jsx` (this legacy Nextra 2 site).

## How the banner and the compatibility matrix are kept in agreement

A banner that claims a contract version is only useful if that claim is checked.
[`scripts/check-compatibility.ts`](../scripts/check-compatibility.ts) — the same script
that validates the cross-repo matrix — enforces three things on every run:

1. `packages/docs/lib/docs-version.ts` matches `docs/version-manifest.json`.
2. The versioning pages on both sites quote the same contract version and contract ID
   as the manifest.
3. The manifest's `(contract, sdk)` pair appears in at least one row of the
   [compatibility matrix](cross-repo-dependencies.md#compatibility-matrix).

So the banner cannot claim a combination that the matrix does not list, and bumping a
version in one place fails CI until it is bumped everywhere.

Run it locally with:

```bash
pnpm check-compatibility
```

See [Cross-Repo Dependencies](cross-repo-dependencies.md) for the matrix itself and for
the process to follow when any component version changes.

## Verifying the version you are actually running

The contract exposes a `get_version()` view. Do not trust the banner over the contract:

```bash
stellar contract invoke \
  --id CCPASLHKRFBMVV5PZG3LKDGKFEDXZMB5U7DK42CVLUVWCMUCSRPVBIMO \
  --network testnet \
  -- get_version
```

The SDK wraps the same call in `checkCompatibility()`, which additionally reports
whether the deployed contract is inside the range your SDK build supports. See the
[SDK API Reference](sdk-api-reference.md) for details.

If the deployed version differs from the banner, treat the affected pages as ahead of —
or behind — your deployment, and consult the compatibility matrix to find the SDK
release that pairs with what you have.

## Mainnet

ILN is testnet-only until the audit completes. Mainnet contract IDs will be added to the
compatibility matrix and reflected in the banner once they exist. See the
[Mainnet Launch Checklist](mainnet-launch-checklist.md) for the gating criteria.
