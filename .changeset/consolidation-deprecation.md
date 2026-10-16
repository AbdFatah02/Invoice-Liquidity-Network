---
"@invoice-liquidity/cli": minor
"@iln/sdk": minor
---

We are consolidating our duplicate packages to provide a single, authoritative CLI and SDK for all integrators.

- `@iln/cli` is officially deprecated. Its unique commands (watch, export, stats, reputation, network switch) have been merged into the top-level `@invoice-liquidity/cli` package.
- `@iln/sdk` (`sdk/`) is the canonical, production SDK. `@iln/sdk-next` (`packages/sdk/`) is the experimental browser-first rewrite. The previously documented name `@invoice-liquidity/sdk` is retired; install `@iln/sdk` instead (see docs/sdk-migration-guide.md). <!-- sdk-name-check: allow-legacy -->
- A new package selection guide has been added to the root README to help new integrators discover the correct packages.
