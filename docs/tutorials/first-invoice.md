# Submit Your First Invoice

This hands-on walkthrough shows how to submit an invoice on the Invoice Liquidity Network using Stellar testnet, the ILN frontend, and the SDK's `getInvoice()` read API.

## What you will do

- Install the Freighter wallet and choose Stellar testnet
- Fund your wallet using Friendbot
- Clone and run the ILN frontend locally
- Connect your Freighter wallet to the dApp
- Fill the invoice form and submit it on-chain
- Confirm the contract transaction in Freighter
- View the resulting invoice in the Stellar explorer and by calling `getInvoice()`

> This tutorial is meant for the testnet environment only.

---

## 1. Install Freighter and switch to Testnet

1. Install the Freighter browser extension from https://freighter.app.
2. Open Freighter and choose **Testnet** from the network selector.
3. Create a new wallet or import an existing testnet keypair.

**Expected result:** Freighter is installed, unlocked, and set to `Testnet`.

```text
Freighter
Network: Testnet
Account: G... (your public key)
```

### What just happened?

Freighter is a Stellar wallet extension that can sign transactions for you in the browser. Switching to testnet means you will use Stellar's free test environment rather than real funds.

---

## 2. Fund your testnet wallet with Friendbot

Use Friendbot to add XLM to your new testnet account.

```bash
curl "https://friendbot.stellar.org?addr=YOUR_PUBLIC_KEY"
```

Replace `YOUR_PUBLIC_KEY` with the public key from Freighter.

**Expected output:**

```json
{
  "hash": "5f...",
  "ledger": 123456,
  "created_at": "2026-06-02T00:00:00Z",
  "envelope_xdr": "AAAA...",
  "result_xdr": "AAAAAAAAAA..."
}
```

### What just happened?

Friendbot created and funded your new Stellar testnet account with XLM. This is the free test currency required to submit transactions and pay network fees.

---

## 3. Install the ILN frontend locally

Clone the ILN frontend repo and start it.

```bash
git clone https://github.com/Invoice-Liquidity-Network/ILN-Frontend.git
cd ILN-Frontend
pnpm install
pnpm dev
```

Then open the local app in your browser at:

```text
http://localhost:3000
```

**Expected result:** The ILN frontend loads and shows a landing page with a `Connect Wallet` button or a login card.

### What just happened?

You installed and launched the ILN web application locally. The frontend is now ready to connect to your Freighter wallet and talk to the testnet contract.

---

## 4. Connect your wallet in the frontend

In the browser app:

1. Click `Connect Wallet`.
2. Choose the Freighter account you funded.
3. Allow Freighter to connect.

**Expected UI state:**

```text
Connected as G... (your public key)
Wallet: Freighter
Network: Testnet
```

### What just happened?

The dApp gained permission to read your public account and to request transaction signatures. It does not have access to your secret key.

---

## 5. Fill and submit the invoice form

In the ILN frontend, locate the invoice submission form and enter:

- **Amount:** `100` (or another valid XLM amount)
- **Payer:** the payer's Stellar public key
- **Due date:** a date at least a few days in the future
- **Discount rate:** `300` (for 3% discount)

Then click `Submit Invoice`.

**Expected result:** The app shows a transaction confirmation screen and may display a temporary message like `Review transaction in Freighter`.

### What just happened?

The frontend prepared a `submit_invoice` contract call and sent it to Freighter for signing. This is the invoice creation step in the ILN protocol.

---

## 6. Approve the invoice submission in Freighter

When Freighter opens:

1. Review the transaction details.
2. Confirm the invoice submission request.

**Expected result:** Freighter shows a successful transaction confirmation and the dApp returns to show invoice submission status.

```text
Transaction successful
Hash: 3a...c0
Ledger: 1234567
```

### What just happened?

Freighter signed and broadcast the `submit_invoice` transaction to Stellar testnet. The contract recorded the new invoice on-chain.

---

## 7. View the invoice on the Stellar explorer

Open the transaction hash in a Stellar explorer such as Stellar Expert:

```text
https://stellar.expert/explorer/testnet/tx/YOUR_TRANSACTION_HASH
```

If the frontend provides an invoice ID, copy it and use it in the next step.

### What just happened?

The explorer shows the actual Stellar transaction and confirms the contract call was included in a testnet ledger.

---

## 8. Verify the invoice with `getInvoice()`

Install the SDK and call `getInvoice()` to read the newly created invoice from the contract.

```bash
npm install @iln/sdk
```

Create a simple Node.js script named `check-invoice.js`:

```js
import { ILNSdk, ILN_TESTNET, createFreighterSigner } from "@iln/sdk";

const sdk = new ILNSdk({
  ...ILN_TESTNET,
  signer: createFreighterSigner(),
});

const invoiceId = 1n; // replace with your invoice ID

const invoice = await sdk.getInvoice(invoiceId);
console.log(invoice);
```

Run it with:

```bash
node --input-type=module check-invoice.js
```

**Expected output:**

```json
{
  "id": 1n,
  "freelancer": "G...",
  "payer": "G...",
  "amount": 100000000n,
  "dueDate": 1710000000,
  "discountRate": 300,
  "status": "Pending",
  "funder": null,
  "fundedAt": null
}
```

### What just happened?

`getInvoice()` reads the invoice record directly from the ILN contract. This verifies the invoice exists on-chain and shows the stored invoice metadata.

---

## 9. Optional: use the CLI to inspect the invoice

If you want to use the Command Line Interface instead, install and configure the CLI:

```bash
npm install -g @invoice-liquidity/cli
```

Create a `.iln.json` file with testnet settings and your contract ID, then run:

```bash
iln status --id 1
```

**Expected output:**

```text
Invoice     1
Status      Pending
Amount      100 XLM
Funded      0 XLM
Remaining   100 XLM
Rate        300 bps
Due         2026-06-09
Freelancer  G...
Payer       G...
Funder      -
Token       XLM
Funded At   -
```

### What just happened?

The CLI read the same contract invoice data and displayed the current invoice state in the terminal.

---

## Next steps

- Invite a funder to `Fund` the invoice
- Ask the payer to `Mark Paid` once the invoice is settled
- Explore the frontend dashboard to view invoice history and liquidity analytics

If you want to extend this tutorial, try submitting a second invoice with a different due date or discount rate.
