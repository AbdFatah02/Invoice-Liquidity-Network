# Governance Monitor

> **Status:** Verified reference implementation — all contract calls are genuine Soroban RPC simulations against the live testnet governance contract.

A Node.js monitoring script that continuously polls the ILN Governance contract for new proposals and sends real-time notifications via Discord webhook.

Designed for DAO governance participants who want to stay updated on new proposals without using the frontend dashboard. This example also serves as a known-working reference for integrators building governance-related tooling.

**Cross-references:**
- [Governance Guide](../../docs/governance-guide.md) — governance process overview
- [Governance Contract Reference](../../docs/contracts/governance-contract.md) — full contract API
- [ILN Frontend](https://github.com/Invoice-Liquidity-Network/ILN-Frontend) — frontend governance integration

## Features

- ✅ Polls governance contract every 5 minutes (configurable)
- ✅ Filters for Active proposals only
- ✅ Discord webhook notifications with rich embeds
- ✅ Duplicate prevention via local state file
- ✅ Proposal details: ID, action type, proposed value, voting deadline
- ✅ Direct link to frontend proposal page in notification
- ✅ Verbose logging for debugging
- ✅ Handles all proposal action types:
  - Update Fee Rate
  - Add Token
  - Remove Token
  - Update Max Discount Rate

## Prerequisites

- Node.js 18+
- A Discord server with webhook configured
- Stellar testnet or mainnet RPC endpoint access

## Installation

```bash
cd examples/governance-monitor
npm install
```

## Setup

### 1. Create Discord Webhook

1. Open your Discord server
2. Go to **Server Settings** → **Integrations** → **Webhooks**
3. Click **New Webhook**
4. Name it (e.g., "ILN Governance Monitor")
5. Copy the **Webhook URL**

### 2. Configure Environment

Create a `.env` file (or export variables):

```bash
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN"
```

Optional environment variables:

```bash
# Use testnet by default, override for mainnet:
export GOVERNANCE_CONTRACT_ID="CD7GOIU3GNK7EZHG7XWBC7VI4NRVGMRCU7X2FOCAPQN6EGTSW46BY4EB"
export RPC_URL="https://rpc-mainnet.stellar.org:443"
export NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"

# Customize frontend link in notifications:
export FRONTEND_BASE_URL="https://iln.vercel.app"

# Customize polling interval (in milliseconds, default: 300000 = 5 minutes):
export POLL_INTERVAL_MS="600000"  # 10 minutes
```

## Usage

### Start Monitoring (Testnet, Default)

```bash
npm start
```

Output:

```
[2025-03-15T10:30:45.123Z] 🚀 Governance Monitor started
[2025-03-15T10:30:45.456Z] 📋 Configuration: contract=CD7GOIU3GN..., interval=300000ms
[2025-03-15T10:30:45.789Z] 💬 Discord webhook configured: https://discord.com/api/webhooks/...
[2025-03-15T10:30:47.200Z] ✓ Monitor running. Will check for new proposals every 300s
```

### Verbose Mode (Debug Logging)

```bash
npm run dev
```

Shows detailed logs for each poll cycle:

```
[2025-03-15T10:30:47.200Z] ⏰ Polling for new proposals...
[2025-03-15T10:30:47.300Z] Fetching Active proposals from contract...
[2025-03-15T10:30:48.500Z] Fetched 2 Active proposal(s)
[2025-03-15T10:30:48.600Z] New proposal detected: #42 (Update Fee Rate)
[2025-03-15T10:30:48.900Z] ✓ Sent Discord notification for proposal #42
```

### With CLI Options

```bash
# Override RPC endpoint
DISCORD_WEBHOOK_URL="..." ts-node index.ts --rpc https://rpc-mainnet.stellar.org:443

# Mainnet governance contract
DISCORD_WEBHOOK_URL="..." \
  GOVERNANCE_CONTRACT_ID="CD7GOIU3GNK7EZHG7XWBC7VI4NRVGMRCU7X2FOCAPQN6EGTSW46BY4EB" \
  ts-node index.ts --verbose

# Custom polling interval (10 minutes)
DISCORD_WEBHOOK_URL="..." ts-node index.ts --interval 600000
```

## Discord Notification Example

When a new proposal is detected, you'll receive a Discord embed containing:

```
🔔 New Governance Proposal: Update Fee Rate

A new proposal has been submitted to the ILN DAO governance.

Proposal ID: #42
Action Type: Update Fee Rate
Proposed Value: 30000
Details: New fee rate: 3% (in basis points: 30000)
Voting Deadline: Sat, 15 Mar 2025 14:30:00 GMT
Status: Active

[View Proposal] button links to: https://iln-testnet.vercel.app/governance/proposal/42
```

## State Management

The monitor maintains a local state file (`.governance-state.json`) to track:

- Last poll timestamp
- Seen proposal IDs (prevents duplicate notifications)

Example state file:

```json
{
  "lastPollTime": 1710489047200,
  "seenProposalIds": ["1", "2", "5", "42"]
}
```

**To reset notifications** (e.g., test with past proposals):

```bash
rm .governance-state.json
npm start
```

## Network Configuration

### Testnet (Default)

```
Contract ID: CD7GOIU3GNK7EZHG7XWBC7VI4NRVGMRCU7X2FOCAPQN6EGTSW46BY4EB
RPC URL: https://soroban-testnet.stellar.org
Network: Test SDF Network ; September 2015
Frontend: https://iln-testnet.vercel.app
```

### Mainnet (After Audit)

```bash
export GOVERNANCE_CONTRACT_ID="<mainnet-contract-id>"
export RPC_URL="https://rpc-mainnet.stellar.org:443"
export NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
export FRONTEND_BASE_URL="https://iln.vercel.app"
npm start
```

## Troubleshooting

### "DISCORD_WEBHOOK_URL environment variable is required"

Ensure you've exported or set the webhook URL:

```bash
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
npm start
```

### "Contract simulation error"

This typically means the RPC endpoint is unreachable or the contract ID is incorrect. Verify:

```bash
# Check testnet connectivity:
curl -X POST https://soroban-testnet.stellar.org/ \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"sorobanServer","params":[]}'

# Verify contract exists (testnet):
# https://stellar.expert/explorer/testnet/contract/CD7GOIU3GNK7EZHG7XWBC7VI4NRVGMRCU7X2FOCAPQN6EGTSW46BY4EB
```

### "No simulation results returned"

The contract may not have any Active proposals currently, or pagination settings may need adjustment. Check with verbose mode:

```bash
npm run dev
```

### Discord webhook not receiving messages

1. Verify the webhook URL is correct (test with `curl`):

```bash
curl -X POST "$DISCORD_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{"content":"Test message"}'
```

2. Check Discord server permissions: The webhook bot needs permission to send messages in the target channel.

3. Review Discord webhook URL format:
   - Should look like: `https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN`

## Development

### Test with a Testnet Proposal

To verify the monitor works before real proposals:

1. Create a test proposal on testnet using the SDK:

```ts
import { GovernanceClient, GOVERNANCE_TESTNET, createKeypairSigner } from "@iln/sdk";

const client = new GovernanceClient(GOVERNANCE_TESTNET);
// ... create proposal
```

2. Start the monitor:

```bash
npm run dev
```

3. Verify Discord notification arrives within 5 minutes.

## Production Deployment

### Using PM2 (Recommended)

```bash
npm install -g pm2
pm2 start index.ts --name "governance-monitor" --env DISCORD_WEBHOOK_URL="..." --interpreter ts-node
pm2 save
pm2 startup
```

### Using Docker

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY . .
RUN npm install

ENV DISCORD_WEBHOOK_URL=""
ENV GOVERNANCE_CONTRACT_ID=""
ENV RPC_URL=""

CMD ["npm", "start"]
```

Build and run:

```bash
docker build -t iln-governance-monitor .
docker run -e DISCORD_WEBHOOK_URL="..." iln-governance-monitor
```

### Using Systemd Service

Create `/etc/systemd/system/iln-governance-monitor.service`:

```ini
[Unit]
Description=ILN Governance Monitor
After=network.target

[Service]
Type=simple
User=iln
WorkingDirectory=/home/iln/governance-monitor
Environment="DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/..."
ExecStart=/usr/bin/node /home/iln/governance-monitor/index.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable iln-governance-monitor
sudo systemctl start iln-governance-monitor
sudo systemctl status iln-governance-monitor
```

## Contributing

Found a bug or want to improve the monitor? Check out [CONTRIBUTING.md](../../CONTRIBUTING.md).

## License

MIT — see [LICENSE](../../LICENSE)

## Verification

This example has been verified against live testnet contract calls. To confirm genuine contract interaction:

```bash
npm run verify
```

This runs the same RPC simulation calls without requiring a Discord webhook, confirming that:
1. The RPC endpoint is reachable
2. The governance contract exists and responds
3. `list_proposals`, `get_min_quorum_bps`, `get_min_proposal_balance`, `get_execution_delay`, and `is_veto_power_enabled` all succeed

## See Also

- [ILN SDK Documentation](../../sdk/README.md)
- [Governance Guide](../../docs/governance-guide.md)
- [Governance Contract Reference](../../docs/contracts/governance-contract.md)
- [ILN Frontend](https://github.com/Invoice-Liquidity-Network/ILN-Frontend)
- [Smart Contracts](https://github.com/Invoice-Liquidity-Network/ILN-Smart-Contract)
