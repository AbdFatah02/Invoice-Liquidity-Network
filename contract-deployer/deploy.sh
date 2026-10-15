#!/usr/bin/env bash
set -e

# Environment overrides allow an operator to target an explicitly configured
# network. LOCAL remains the Docker Compose default.
NETWORK=${NETWORK:-local}
RPC_URL=${RPC_URL:-http://stellar-node:8000/rpc}
NETWORK_PASSPHRASE=${NETWORK_PASSPHRASE:-Standalone Network ; February 2017}
SOURCE=${SOURCE:-admin}
DRY_RUN=${DRY_RUN:-false}
EXISTING_CONTRACT_ID=${EXISTING_CONTRACT_ID:-}

case "$DRY_RUN" in true|false) ;; *) echo 'DRY_RUN must be true or false.' >&2; exit 2 ;; esac

echo "Starting contract deployment..."
if [ "$DRY_RUN" = false ]; then mkdir -p .docker-output; fi

# The local Docker network is registered here. Remote aliases must be configured
# by the operator in Stellar CLI so this script cannot silently retarget them.
if [ "$DRY_RUN" = false ] && [ "$NETWORK" = local ]; then
    stellar network add "$NETWORK" --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE" 2>/dev/null || true
fi

# Compose's standalone network needs a local funded identity. Remote networks
# must use a source identity configured by the operator and are never funded by
# this helper.
if [ "$DRY_RUN" = false ] && [ "$NETWORK" = local ]; then
    stellar keys generate "$SOURCE" --network "$NETWORK" 2>/dev/null || true
    stellar keys fund "$SOURCE" --network "$NETWORK" || true
fi

if [ "$DRY_RUN" = true ]; then
    echo "DRY RUN: network=$NETWORK source=$SOURCE existing_contract=${EXISTING_CONTRACT_ID:-none}"
fi

# Look for the compiled WASM in standard locations
WASM_FILE=""
if [ -f "invoice-liquidity-network/target/wasm32v1-none/release/invoice_liquidity.wasm" ]; then
    WASM_FILE="invoice-liquidity-network/target/wasm32v1-none/release/invoice_liquidity.wasm"
elif [ -f "backend/target/wasm32-unknown-unknown/release/invoice_liquidity.wasm" ]; then
    WASM_FILE="backend/target/wasm32-unknown-unknown/release/invoice_liquidity.wasm"
elif [ -f "target/wasm32v1-none/release/invoice_liquidity.wasm" ]; then
    WASM_FILE="target/wasm32v1-none/release/invoice_liquidity.wasm"
fi

if [ -n "$WASM_FILE" ]; then
    if [ -n "$EXISTING_CONTRACT_ID" ]; then
        echo "Reusing configured contract ID: $EXISTING_CONTRACT_ID"
        if [ "$DRY_RUN" = false ]; then
            printf '%s\n' "$EXISTING_CONTRACT_ID" > .docker-output/contract-id.txt
        fi
    elif [ "$DRY_RUN" = true ]; then
        echo "DRY RUN: would deploy WASM $WASM_FILE using source $SOURCE on $NETWORK."
    else
        echo "Deploying contract from $WASM_FILE to $NETWORK..."
        stellar contract deploy --wasm "$WASM_FILE" --source "$SOURCE" --network "$NETWORK" > .docker-output/contract-id.txt
        test -s .docker-output/contract-id.txt || { echo 'Deployment returned an empty contract ID.' >&2; exit 1; }
        echo "Contract deployed: $(cat .docker-output/contract-id.txt)"
    fi
else
    if [ -n "$EXISTING_CONTRACT_ID" ]; then
        echo "Reusing configured contract ID: $EXISTING_CONTRACT_ID"
        if [ "$DRY_RUN" = false ]; then printf '%s\n' "$EXISTING_CONTRACT_ID" > .docker-output/contract-id.txt; fi
    elif [ "$DRY_RUN" = true ]; then
        echo "DRY RUN: no built WASM found; no dummy ID will be written."
    else
        echo "WARNING: Built WASM file not found. Writing a dummy Contract ID."
        echo "dummy-contract-id-for-local-dev" > .docker-output/contract-id.txt
    fi
fi

echo "Deployment finished."
