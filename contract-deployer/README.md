# Contract deployer

`deploy.sh` is used by Docker Compose for the local standalone network. The
default network, RPC URL, passphrase, and source are the local development
settings. Operators can override these with `NETWORK`, `RPC_URL`,
`NETWORK_PASSPHRASE`, and `SOURCE`. For a remote network, configure its alias in
Stellar CLI before running this script; the helper only registers the local
Docker network and will not alter a remote alias.

## Dry run

Set `DRY_RUN=true` to print the selected network, source, WASM path, and action
without registering a network, generating or funding a key, deploying a
contract, or changing `.docker-output/contract-id.txt`:

```sh
DRY_RUN=true NETWORK=testnet SOURCE=deployer ./contract-deployer/deploy.sh
```

## Safe re-runs

Deploying a WASM creates a new contract instance. The script cannot infer that
an instance created during a previous interrupted run is the intended one.
After recording the returned ID, set `EXISTING_CONTRACT_ID` to reuse that
instance on a later run; the script writes the known ID instead of deploying
again. This makes a retry after the deploy succeeded but output handling failed
safe from accidental duplicate deployment. Keep the ID associated with the
network it belongs to, and verify that association before reusing it.

For example:

```sh
NETWORK=testnet \
RPC_URL=https://your-testnet-rpc \
NETWORK_PASSPHRASE="Test SDF Network ; September 2015" \
SOURCE=deployer \
EXISTING_CONTRACT_ID=CA... \
./contract-deployer/deploy.sh
```

The script only funds a generated source key when `NETWORK=local`. Configure a
signing identity and network credentials before using a non-local network; do
not put secrets in this repository or in command history.
