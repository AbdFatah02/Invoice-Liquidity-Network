# Third-Party Data-Processor Inventory and DPA Review

**Review status:** engineering inventory; contract and legal status not
verified. No production processor should be marked as having an adequate DPA
without an executed agreement and current subprocessor schedule reviewed by the
authorized owner.

This inventory covers integrations present in the repository. Deployment
owners must complete the `Owner evidence` column from their actual account and
contract records before production launch. An SDK or configuration option is
not evidence that a vendor is enabled or that a DPA exists.

| Service / processor | Data sent or exposed | Purpose / path | Data location / subprocessors | DPA status and evidence | Required action |
|---|---|---|---|---|---|
| Stellar RPC / Horizon providers (operator-configured) | Public wallet addresses, invoice/transaction identifiers, signed transaction envelopes and network queries | SDK, indexer, oracle, notifications query public ledger endpoints | Provider and its hosting/subprocessors; configured endpoint determines provider | **Unverified**; deployment owner must identify endpoint, account, terms, and transfer basis | Inventory configured endpoints; assess metadata/log retention and region; document contract evidence |
| Email delivery (Resend adapter) | Recipient email, notification content, event/invoice context, delivery metadata | `notifications/src/delivery.ts` | Provider and its subprocessors; account configuration governs region | **Unverified**; no executed agreement evidence in repository | Confirm enabled status, DPA, subprocessors, retention, region, and deletion process |
| SMS delivery (Twilio adapter) | E.164 phone number, notification content, event/invoice context, delivery metadata | `notifications/src/delivery.ts` | Provider, carrier network, and subprocessors | **Unverified**; no executed agreement evidence in repository | Confirm enabled status, DPA, subprocessors, retention, region, and deletion process |
| Customer webhook destinations | User-configured URL and notification payload; destination operator receives payload | `notifications/src/delivery.ts` | Customer-selected endpoint; onward handling is outside ILN control | **Not applicable as an ILN vendor DPA by default; relationship-specific terms unverified** | Disclose fields sent, require destination authorization, and review customer contract/transfer terms |
| KYB provider adapter (not supplied here) | Business identity/UBO payload and reduced verification request; provider response may contain personal data | Injected oracle adapter; no production adapter is included in this repository | Provider and its subprocessors, if configured | **Unverified / no provider selected in code** | Before enablement, select vendor, minimize payload, execute DPA, review subprocessors/region/retention, and test deletion/export obligations |
| Price-data source (operator-configured) | Asset/pair queries and request metadata; typically no direct contact data | Oracle price-source adapter | Selected source and its subprocessors; deployment-specific | **Unverified**; identify source and account from deployment config | Confirm actual data exchanged, DPA applicability, terms, region, and logging retention |
| Hosting and database operator (deployment-selected) | Service databases, logs, secrets, request metadata, backups | Indexer, notifications, oracle deployments | Hosting provider and subprocessors; region is not pinned by code | **Unverified**; repository does not identify the production account/region | Record provider/account/region, execute DPA, inspect subprocessors, access controls, backup lifecycle, and incident terms |
| GitHub Actions / artifact storage | Source code, CI logs, workflow metadata; backup artifacts may contain indexed data | CI and documented backup workflows | GitHub and configured artifact/storage services | **Unverified for data-bearing artifacts**; verify organization terms and workflow contents | Ensure artifacts exclude personal data or have approved access, region, and retention controls |

## Gap handling

Current verified agreement evidence in this repository: **none**. This is an
evidence gap, not a claim that no agreements exist outside the repository.
Each deployment owner must attach a dated internal evidence reference (never
credentials or private contract contents) before marking a row reviewed. A
processor with no adequate agreement, unclear subprocessors, or unresolved
cross-border transfer terms is a launch blocker for the affected data flow;
disable that integration or use a reviewed alternative until the gap is
resolved. Do not send production personal data to a newly configured vendor
while status is unverified.

## Keeping the inventory current

The service owner updates this table whenever an outbound adapter, hosting
provider, backup target, or recipient data category changes. Review it at each
production vendor renewal and at least quarterly. Record reviewer, date,
deployment(s), agreement evidence reference, approved data categories,
region, subprocessor review, and open actions in the deployment's controlled
vendor register. Reconcile this table against environment configuration and
vendor billing/account records; source-code search alone cannot establish
which integrations are active. See [Privacy and Data Retention](privacy.md)
for data categories, retention, and residency constraints.
