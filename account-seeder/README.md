# Account seeder scenarios

The Docker Compose `account-seeder` accepts environment variables to create a
repeatable, varied local workload. It generates and funds named actor keys,
then submits the configured number of invoices for every freelancer and
rotates the payer across those invoices. Amounts grow by the configured step,
so the resulting history has more variety than a set of identical accounts.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `FREELANCER_COUNT` | `1` | Freelancer actors to create. |
| `PAYER_COUNT` | `1` | Payer actors to create and rotate through. |
| `FUNDER_COUNT` | `1` | Funder actors to create for downstream test transactions. |
| `INVOICES_PER_FREELANCER` | `3` | Invoice submissions for each freelancer. |
| `FUNDED_INVOICE_COUNT` | `0` | Number of seeded invoices to fully fund, creating local liquidity positions. |
| `FIRST_INVOICE_ID` | `1` | ID assigned to the first invoice on a fresh local contract; set the next ID when reusing a contract. |
| `INVOICE_AMOUNT_BASE` | `5000000` | First invoice amount, in contract token units. |
| `INVOICE_AMOUNT_STEP` | `5000000` | Increase in amount for each subsequent invoice. |
| `INVOICE_DISCOUNT_RATE` | `500` | Discount rate passed to `submit_invoice`. |
| `INVOICE_DUE_DAYS` | `30` | Days from seeding until invoice due date. |

Example local load-test setup:

```sh
FREELANCER_COUNT=20 PAYER_COUNT=10 FUNDER_COUNT=5 \
INVOICES_PER_FREELANCER=25 INVOICE_AMOUNT_BASE=1000000 \
INVOICE_AMOUNT_STEP=250000 FUNDED_INVOICE_COUNT=50 INVOICE_DUE_DAYS=45 \
docker compose up --build stellar-node contract-deployer account-seeder
```

The resulting actor groups, token IDs, contract ID, and scenario settings are
written to `.docker-output/accounts.json`. `FUNDED_INVOICE_COUNT` creates full
funding positions for the first configured invoice IDs, distributing
transactions across funders. It defaults to zero. `FIRST_INVOICE_ID=1` is for a
fresh local contract; when reusing a populated contract, set it to the first
newly seeded ID so funding does not target older invoices. Account keys are
local test credentials and must never be reused on a public network.
