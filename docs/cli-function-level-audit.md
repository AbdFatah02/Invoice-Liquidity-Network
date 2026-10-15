# CLI function-level comparison audit

> **Scope (Issue #850).** Build a function-by-function comparison of the two
> CLIs (`cli/src/*.ts` vs `packages/cli/src/*.ts`) to feed the consolidation
> decision, flagging any *behavioral* drift between similarly-named commands.
>
> **Status: consolidation already complete — this document is the closing
> audit.** `packages/cli` was removed and its five unique commands were ported
> into `cli/` with parity tests (see
> [cli-vs-cli-next.md](cli-vs-cli-next.md) and the `packages/cli` vs `cli/`
> row in [monorepo-map.md](monorepo-map.md)). Because there is no longer a
> second CLI package to compare *against*, this audit instead verifies the
> resolution at function level: every formerly-overlapping command now maps to
> **exactly one** canonical implementation in `cli/`, with no duplicated or
> orphaned function left behind by the port.

## How commands are wired in `cli/`

All commands register on a single `commander` program in
[`cli/src/cli.ts`](../cli/src/cli.ts). Each top-level command's `.action(...)`
callback delegates to (a) an `ILNClient` read/write call in
[`cli/src/client.ts`](../cli/src/client.ts), and (b) a formatter in
[`cli/src/format.ts`](../cli/src/format.ts). Persistent commands (`alias`,
`config`, `network switch`) read/write local config via
[`cli/src/config.ts`](../cli/src/config.ts). This is a single, consistent
function-call pattern — the precondition for "no silent behavioral drift".

## Function-level mapping of the ported commands

The five commands `packages/cli` contributed that `cli/` lacked, and the
helper functions each one exercises:

| Ported command | Action callback | Backing call(s) | Formatter(s) | Config I/O |
|---|---|---|---|---|
| `iln watch` | `cli.ts:719` | `client.getInvoice(id)` poll loop (`client.ts:98`); emits via `ui`/`stdout` | — (inline status printing) | — |
| `iln export` | `cli.ts:806` | `fetchInvoicesForExport(client, address)` (`cli.ts:1722`), which uses `client.getInvoiceCount` / `client.getInvoice` / `client.listInvoicesByAddress` | inline CSV serialization | — |
| `iln stats` | `cli.ts:857` | `AnalyticsSDK.getProtocolStats()` from `@iln/sdk` | `formatProtocolStats` (`format.ts:262`), `formatProtocolStatsJson` (`format.ts:272`) | — |
| `iln reputation get` | `cli.ts:900` | `client.getReputation(address)` (`client.ts:135`) | `formatReputation` (`format.ts:247`), `formatReputationJson` (`format.ts:251`) | — |
| `iln network switch` | `cli.ts:955` | (no chain call) | — | `readRawConfig` (`config.ts:268`) → `writeRawConfig` (`config.ts:275`) |

Each of these reuses the **same** helper functions already used by `cli/`'s
pre-existing commands, so there is no parallel/divergent implementation of
"fetch invoice", "fetch reputation", or "persist config". That directly
addresses the drift concern: a single `getReputation` (`client.ts:135`)
backs both `iln reputation get` and any future reputation query, rather than
two packages each owning their own copy.

## Behavioral-equivalence confirmation (overlapping-sounding commands)

The original risk was silent behavioral drift between similarly-named
commands across the two packages (e.g. "does `cli/`'s `status` do the same
thing as `packages/cli`'s `invoice get`?"). With one CLI, those pairs now
resolve to one command each:

| Pre-consolidation pair | Post-consolidation canonical command | Notes |
|---|---|---|
| `cli/` `status` ↔ `packages/cli` `invoice get` | `iln status` (`cli.ts:493`) | Single implementation; fetches & renders one invoice by id. No second `get`-style invoice command remains. |
| `cli/` `list` ↔ `packages/cli` `invoice list` | `iln list` (`cli.ts:551`) | Single implementation backed by `client.getInvoicesForAddress`. |
| `cli/` `submit`/`fund`/`pay` ↔ `packages/cli` `invoice submit`/`fund`/`pay` | `iln submit`/`fund`/`pay` | Pre-existing canonical implementations; `packages/cli` variants removed. |

## Intra-CLI overlapping-sounding commands (still worth watching)

Even with one package, a few command names *sound* alike and could confuse
users. They are intentionally distinct and implemented by distinct functions;
documented here so future edits don't accidentally merge their behavior:

| Command A | Command B | Why they differ | Implementing functions |
|---|---|---|---|
| `iln status` (invoice status) | `iln reputation get` | one invoice vs one address's reputation score | `cli.ts:493` vs `cli.ts:900` |
| `iln status` (invoice) | `iln list` (invoice list) | single record vs collection | `cli.ts:493` vs `cli.ts:551` |
| `iln history` | `iln list` | event timeline vs current invoices | `cli.ts:615` vs `cli.ts:551` |
| `iln config show` | `iln network switch` | read-only render vs mutating write of `.ilnrc.json` | `cli.ts:1096` (read) vs `cli.ts:955` (write) |
| `iln dev status` | `iln status` | local dev-environment status vs on-chain invoice status | `cli.ts:1285` vs `cli.ts:493` |

## Residual-duplication scan

To confirm the port left no orphaned duplicate function behind, the following
symbols were grepped across `cli/src/**`:

- `getReputation` — **1 definition** (`client.ts:135`), referenced by `cli.ts:914`.
- `formatReputation` / `formatReputationJson` — **1 definition each**
  (`format.ts:247` / `format.ts:251`).
- `formatProtocolStats` / `formatProtocolStatsJson` — **1 definition each**
  (`format.ts:262` / `format.ts:272`).
- `readRawConfig` / `writeRawConfig` — **1 definition each**
  (`config.ts:268` / `config.ts:275`), used by `alias`, `config`, and
  `network switch` alike.

No second (legacy) copy of any of these exists, so the port did not introduce
duplicated logic. (Live dead-code verification is covered separately by
`pnpm dead-code:check` / Issue #852.)

## Conclusion

The function-level audit required by Issue #850 is satisfied: there is a
single canonical CLI, every formerly-overlapping command maps to exactly one
implementation backed by shared client/format/config helpers, and the
overlapping-sounding commands are intentionally distinct. No outstanding
consolidation work remains from a code-duplication standpoint; this document
closes the audit.

## Follow-up completeness reconciliation (Issue #1120)

The current repository has no `cli-next` package. The migration target described
by Issue #1120 is therefore not present; this audit is consistent with
[cli-vs-cli-next.md](cli-vs-cli-next.md), which records the actual
`packages/cli` → `cli/` consolidation and removal. The canonical CLI command
tree and formerly unique command tests are listed there. Its completeness
statement is limited to the removed package's command surface and does not
claim an individual runtime test for every option in the canonical CLI.

## Highest-risk gap closure (Issue #1145)

The highest-risk output-path gap was in `iln export`: CSV fields were joined
without quoting, so commas/newlines could shift columns, and spreadsheet
formula prefixes in ledger-derived values were emitted unchanged. The export
now quotes CSV-special values and prefixes formula-leading cells with an
apostrophe before serialization. A CLI regression test covers both cases.
This closes the export serialization risk without changing the documented
column order or CSV header. A focused CLI regression test covers quoting and
formula neutralization; its execution status is reported separately in the PR
verification summary.

Other limitations remain explicit: the watch command polls until terminal
state, and the unfiltered export remains proportional to the total on-chain
invoice count. Those behaviors are not altered by this focused fix; a future
bounded-pagination design should address large exports without silently
truncating results.
