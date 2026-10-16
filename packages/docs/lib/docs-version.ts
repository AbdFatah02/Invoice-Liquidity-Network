/**
 * Version metadata rendered by the docs version banner.
 *
 * The docs site is **single-track**: it always documents the latest development
 * version of the protocol, which is the build currently deployed to Stellar
 * testnet. There are no per-version doc snapshots, so readers need an explicit
 * statement of what the prose is written against — that is what these constants
 * (and the banner they feed) provide.
 *
 * Canonical source: `docs/version-manifest.json`. These constants mirror it so
 * the Next.js app never has to import a file from outside its own package root.
 * `scripts/check-compatibility.ts` fails CI if they drift from the manifest, or
 * if the declared contract/SDK pair is missing from the compatibility matrix in
 * `docs/cross-repo-dependencies.md`.
 *
 * Keep each `export const` on a single line with a plain string literal — the
 * compatibility checker parses this file textually.
 */

/** Stellar network the documented deployment lives on. */
export const NETWORK = 'testnet';

/** Version of the `invoice_liquidity` contract these docs describe. */
export const CONTRACT_VERSION = '0.1.0';

/** Contract ID of the documented deployment on the network above. */
export const CONTRACT_ID = 'CCPASLHKRFBMVV5PZG3LKDGKFEDXZMB5U7DK42CVLUVWCMUCSRPVBIMO';

/** Contract view that returns the deployed version, for reader-side verification. */
export const CONTRACT_VERSION_METHOD = 'get_version';

/** Version of `@iln/sdk` these docs describe. */
export const SDK_VERSION = '0.1.0';

/**
 * Abbreviate a Stellar contract ID for display, keeping enough of both ends to
 * be recognisable in a one-line banner.
 */
export function shortContractId(contractId: string = CONTRACT_ID): string {
  if (contractId.length <= 14) return contractId;
  return `${contractId.slice(0, 6)}…${contractId.slice(-6)}`;
}
