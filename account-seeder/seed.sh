#!/usr/bin/env bash
set -e

# Scenario controls make the same seeder useful for smoke, load, and E2E runs.
# Defaults retain the original three-role development setup.
FREELANCER_COUNT=${FREELANCER_COUNT:-1}
PAYER_COUNT=${PAYER_COUNT:-1}
FUNDER_COUNT=${FUNDER_COUNT:-1}
INVOICES_PER_FREELANCER=${INVOICES_PER_FREELANCER:-3}
FUNDED_INVOICE_COUNT=${FUNDED_INVOICE_COUNT:-0}
FIRST_INVOICE_ID=${FIRST_INVOICE_ID:-1}
INVOICE_AMOUNT_BASE=${INVOICE_AMOUNT_BASE:-5000000}
INVOICE_AMOUNT_STEP=${INVOICE_AMOUNT_STEP:-5000000}
INVOICE_DISCOUNT_RATE=${INVOICE_DISCOUNT_RATE:-500}
INVOICE_DUE_DAYS=${INVOICE_DUE_DAYS:-30}

for setting in FREELANCER_COUNT PAYER_COUNT FUNDER_COUNT INVOICES_PER_FREELANCER FUNDED_INVOICE_COUNT FIRST_INVOICE_ID INVOICE_AMOUNT_BASE INVOICE_AMOUNT_STEP INVOICE_DISCOUNT_RATE INVOICE_DUE_DAYS; do
    value=${!setting}
    if ! [[ "$value" =~ ^[0-9]+$ ]]; then
        echo "$setting must be a non-negative integer (got '$value')." >&2
        exit 2
    fi
done
if [ "$FREELANCER_COUNT" -lt 1 ] || [ "$PAYER_COUNT" -lt 1 ] || [ "$FUNDER_COUNT" -lt 1 ]; then
    echo "At least one freelancer, payer, and funder are required." >&2
    exit 2
fi
total_expected=$((FREELANCER_COUNT * INVOICES_PER_FREELANCER))
if [ "$FUNDED_INVOICE_COUNT" -gt "$total_expected" ]; then
    echo "FUNDED_INVOICE_COUNT cannot exceed the $total_expected invoices configured." >&2
    exit 2
fi

echo "Starting account seeder..."
mkdir -p .docker-output

# The stellar CLI needs the network definition
stellar network add local --rpc-url http://stellar-node:8000/rpc --network-passphrase "Standalone Network ; February 2017" || true

echo "Generating and funding multi-actor test scenario..."
declare -a FREELANCER_NAMES=() PAYER_NAMES=() FUNDER_NAMES=()
declare -A ACTOR_JSON=()
seed_actor() {
    role=$1
    number=$2
    name=$role
    if [ "$number" -gt 1 ]; then name="${role}-${number}"; fi
    stellar keys generate "$name" --network local 2>/dev/null || true
    stellar keys fund "$name" --network local || true
    pub=$(stellar keys address "$name")
    sec=$(stellar keys show "$name")
    ACTOR_JSON["$name"]=$(printf '{"publicKey":"%s","secretKey":"%s"}' "$pub" "$sec")
    case "$role" in
        freelancer) FREELANCER_NAMES+=("$name") ;;
        payer) PAYER_NAMES+=("$name") ;;
        funder) FUNDER_NAMES+=("$name") ;;
    esac
}
for ((i=1; i<=FREELANCER_COUNT; i++)); do seed_actor freelancer "$i"; done
for ((i=1; i<=PAYER_COUNT; i++)); do seed_actor payer "$i"; done
for ((i=1; i<=FUNDER_COUNT; i++)); do seed_actor funder "$i"; done

echo "Deploying Mock USDC..."
stellar contract asset deploy --asset native --source admin --network local > .docker-output/usdc-id.txt || echo "native" > .docker-output/usdc-id.txt
USDC_ID=$(cat .docker-output/usdc-id.txt)

echo "Deploying Mock EURC..."
stellar contract asset deploy --asset native --source admin --network local > .docker-output/eurc-id.txt || echo "native" > .docker-output/eurc-id.txt
EURC_ID=$(cat .docker-output/eurc-id.txt)

CONTRACT_ID="not-found"
if [ -f ".docker-output/contract-id.txt" ]; then
    CONTRACT_ID=$(cat .docker-output/contract-id.txt)
fi

echo "Writing accounts output..."
PRIMARY_FREELANCER=${FREELANCER_NAMES[0]}
PRIMARY_PAYER=${PAYER_NAMES[0]}
PRIMARY_FUNDER=${FUNDER_NAMES[0]}
{
    echo '{'
    printf '  "freelancer": %s,\n' "${ACTOR_JSON[$PRIMARY_FREELANCER]}"
    printf '  "payer": %s,\n' "${ACTOR_JSON[$PRIMARY_PAYER]}"
    printf '  "funder": %s,\n' "${ACTOR_JSON[$PRIMARY_FUNDER]}"
    printf '  "freelancers": {'
    separator=''
    for name in "${FREELANCER_NAMES[@]}"; do printf '%s\n    "%s": %s' "$separator" "$name" "${ACTOR_JSON[$name]}"; separator=','; done
    printf '\n  },\n'
    printf '  "payers": {'
    separator=''
    for name in "${PAYER_NAMES[@]}"; do printf '%s\n    "%s": %s' "$separator" "$name" "${ACTOR_JSON[$name]}"; separator=','; done
    printf '\n  },\n'
    printf '  "funders": {'
    separator=''
    for name in "${FUNDER_NAMES[@]}"; do printf '%s\n    "%s": %s' "$separator" "$name" "${ACTOR_JSON[$name]}"; separator=','; done
    printf '\n  },\n'
    printf '  "tokens": {"usdc":"%s","eurc":"%s"},\n' "$USDC_ID" "$EURC_ID"
    printf '  "contractId": "%s",\n' "$CONTRACT_ID"
    printf '  "scenario": {"invoicesPerFreelancer":%s,"fundedInvoiceCount":%s,"firstInvoiceId":%s,"amountBase":%s,"amountStep":%s,"discountRate":%s,"dueDays":%s}\n' \
        "$INVOICES_PER_FREELANCER" "$FUNDED_INVOICE_COUNT" "$FIRST_INVOICE_ID" "$INVOICE_AMOUNT_BASE" "$INVOICE_AMOUNT_STEP" "$INVOICE_DISCOUNT_RATE" "$INVOICE_DUE_DAYS"
    echo '}'
} > .docker-output/accounts.json

# Initialize contract if we have a real one
if [ "$CONTRACT_ID" != "dummy-contract-id-for-local-dev" ] && [ "$CONTRACT_ID" != "not-found" ]; then
    echo "Initializing contract..."
    stellar contract invoke \
        --id $CONTRACT_ID \
        --source admin \
        --network local \
        -- \
        initialize \
        --token "$USDC_ID" || echo "Contract already initialized."

    due_date=$(($(date +%s) + 86400 * INVOICE_DUE_DAYS))
    invoice_number=0
    for freelancer in "${FREELANCER_NAMES[@]}"; do
        for ((i=0; i<INVOICES_PER_FREELANCER; i++)); do
            payer=${PAYER_NAMES[$((invoice_number % PAYER_COUNT))]}
            freelancer_pub=$(stellar keys address "$freelancer")
            payer_pub=$(stellar keys address "$payer")
            amount=$((INVOICE_AMOUNT_BASE + invoice_number * INVOICE_AMOUNT_STEP))
            echo "Submitting scenario invoice $((invoice_number + 1)) from $freelancer to $payer ($amount stroops)..."
            stellar contract invoke --id "$CONTRACT_ID" --source "$freelancer" --network local -- \
                submit_invoice --freelancer "$freelancer_pub" --payer "$payer_pub" --amount "$amount" \
                --due_date "$due_date" --discount_rate "$INVOICE_DISCOUNT_RATE"
            invoice_number=$((invoice_number + 1))
        done
    done

    for ((i=0; i<FUNDED_INVOICE_COUNT; i++)); do
        funder=${FUNDER_NAMES[$((i % FUNDER_COUNT))]}
        funder_pub=$(stellar keys address "$funder")
        amount=$((INVOICE_AMOUNT_BASE + i * INVOICE_AMOUNT_STEP))
        invoice_id=$((FIRST_INVOICE_ID + i))
        echo "Funding scenario invoice $invoice_id from $funder ($amount token units)..."
        stellar contract invoke --id "$CONTRACT_ID" --source "$funder" --network local -- \
            fund_invoice --funder "$funder_pub" --invoice_id "$invoice_id" --fund_amount "$amount"
    done
fi

echo "Seeding completed successfully!"
