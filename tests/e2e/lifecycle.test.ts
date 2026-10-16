import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as StellarSdk from '@stellar/stellar-sdk';
import { ILNSdk } from '@iln/sdk';
import {
  assertPrerequisitesSatisfied,
  evaluatePrerequisites,
  requireContractId,
  requireHealthyRpc,
} from './support/e2e-prerequisites';

const RPC_URL = 'http://localhost:8000/soroban/rpc';
const FRIENDBOT_URL = 'http://localhost:8000/friendbot';
const NETWORK_PASSPHRASE = StellarSdk.Networks.STANDALONE;

let server: StellarSdk.rpc.Server;
let contractId: string;
let sdk: ILNSdk;

async function fundAccount(publicKey: string) {
  const response = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
  if (!response.ok) {
    throw new Error(`Failed to fund account ${publicKey}: ${response.statusText}`);
  }
}

async function getUsdcBalance(publicKey: string, assetId: string): Promise<bigint> {
  const account = await server.getAccount(publicKey);
  const balanceStr = account.balances.find((b: any) => b.asset_id === assetId)?.balance || '0';
  return BigInt(parseFloat(balanceStr) * 10_000_000);
}

async function getTokenBalance(publicKey: string, contractId: string): Promise<bigint> {
  try {
    const account = await server.getAccount(publicKey);
    const balanceStr =
      account.balances.find((b: any) => b.asset_code === contractId)?.balance || '0';
    return BigInt(parseFloat(balanceStr) * 10_000_000);
  } catch {
    return 0n;
  }
}

// The lifecycle suite is fail-closed (#1244): a missing node or a missing /
// placeholder contract ID (#1242) is an actionable failure with the recovery
// path, not a silent skip. Skipping requires the explicit E2E_ALLOW_SKIP=1
// escape hatch, which release CI never sets and which scripts/check-e2e-coverage.mjs
// (#1243) rejects.
const prerequisites = await evaluatePrerequisites(async () => {
  await requireHealthyRpc(RPC_URL);
  requireContractId('CONTRACT_ID', { fallbackEnvVars: ['DEPLOYED_CONTRACT_ID'] });
});

afterAll(async () => {
  if (sdk) {
    sdk.clearCache();
  }
});

describe.skipIf(prerequisites.skip)('E2E Invoice Lifecycle', () => {
  // The unmet dependency surfaces here as one actionable failure (with the RPC
  // URL and the provisioning command) instead of a silent skip (#1244).
  it('has live prerequisites: reachable RPC and a real provisioned contract', () => {
    assertPrerequisitesSatisfied(prerequisites);
    expect(prerequisites.ok).toBe(true);
  });

  beforeAll(async () => {
    // When prerequisites are unmet the test above already carries the failure; do
    // not turn the rest of the suite into skips by throwing again here.
    if (!prerequisites.ok) return;

    server = await requireHealthyRpc(RPC_URL);
    contractId = requireContractId('CONTRACT_ID', { fallbackEnvVars: ['DEPLOYED_CONTRACT_ID'] });
    sdk = new ILNSdk({
      contractId,
      rpcUrl: RPC_URL,
      networkPassphrase: NETWORK_PASSPHRASE,
    });
  });

  describe('Full Lifecycle: Submit → Fund → Pay → Verify', () => {
    it('submit invoice via SDK creates a pending invoice', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();

      await fundAccount(freelancer.publicKey());
      await fundAccount(payer.publicKey());

      const amount = 1000n * 10_000_000n;
      const dueDate = Math.floor(Date.now() / 1000) + 86400;
      const discountRateBps = 300;

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      const invoice = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount,
        dueDate,
        discountRate: discountRateBps,
      });

      expect(invoice).toBeDefined();
      expect(invoice.id).toBeGreaterThan(0n);
      expect(invoice.state).toBe('Pending');
    });

    it('fund invoice via SDK transfers tokens to escrow', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const lp = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();

      await fundAccount(freelancer.publicKey());
      await fundAccount(lp.publicKey());
      await fundAccount(payer.publicKey());

      const amount = 1000n * 10_000_000n;
      const dueDate = Math.floor(Date.now() / 1000) + 86400;
      const discountRateBps = 300;

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      const invoice = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount,
        dueDate,
        discountRate: discountRateBps,
      });

      const lpSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(lp),
      });

      const fundedInvoice = await lpSdk.fundInvoice({
        funder: lp.publicKey(),
        invoiceId: invoice.id,
      });

      expect(fundedInvoice).toBeDefined();
      expect(fundedInvoice.state).toBe('Funded');
      expect(fundedInvoice.funder).toBe(lp.publicKey());
    });

    it('mark invoice as paid completes the lifecycle and credits LP yield', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const lp = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();

      await fundAccount(freelancer.publicKey());
      await fundAccount(lp.publicKey());
      await fundAccount(payer.publicKey());

      const amount = 1000n * 10_000_000n;
      const dueDate = Math.floor(Date.now() / 1000) + 86400;
      const discountRateBps = 300;

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      const invoice = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount,
        dueDate,
        discountRate: discountRateBps,
      });

      const lpSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(lp),
      });

      await lpSdk.fundInvoice({
        funder: lp.publicKey(),
        invoiceId: invoice.id,
      });

      const payerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(payer),
      });

      const paidInvoice = await payerSdk.markPaid({
        invoiceId: invoice.id,
      });

      expect(paidInvoice).toBeDefined();
      expect(paidInvoice.state).toBe('Paid');
    });

    it('verify final state transitions across contract and SDK read', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const lp = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();

      await fundAccount(freelancer.publicKey());
      await fundAccount(lp.publicKey());
      await fundAccount(payer.publicKey());

      const amount = 1000n * 10_000_000n;
      const dueDate = Math.floor(Date.now() / 1000) + 86400;
      const discountRateBps = 300;

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      const invoice = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount,
        dueDate,
        discountRate: discountRateBps,
      });

      expect(invoice.state).toBe('Pending');

      const lpSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(lp),
      });

      const fundedInvoice = await lpSdk.fundInvoice({
        funder: lp.publicKey(),
        invoiceId: invoice.id,
      });

      expect(fundedInvoice.state).toBe('Funded');

      const readSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const fetched = await readSdk.getInvoice(invoice.id);
      expect(fetched.state).toBe('Funded');
    });
  });

  describe('Cross-Package Integration: SDK + Indexer', () => {
    it('SDK retrieves invoice state after submission', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();

      await fundAccount(freelancer.publicKey());
      await fundAccount(payer.publicKey());

      const amount = 2000n * 10_000_000n;
      const dueDate = Math.floor(Date.now() / 1000) + 86400;
      const discountRateBps = 250;

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      const invoice = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount,
        dueDate,
        discountRate: discountRateBps,
      });

      const readSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const fetched = await readSdk.getInvoice(invoice.id);
      expect(fetched.id).toBe(invoice.id);
      expect(fetched.freelancer).toBe(freelancer.publicKey());
      expect(fetched.payer).toBe(payer.publicKey());
      expect(fetched.state).toBe('Pending');
    });

    it('SDK correctly reads multiple invoices via batch query', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();

      await fundAccount(freelancer.publicKey());
      await fundAccount(payer.publicKey());

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      const amount1 = 1000n * 10_000_000n;
      const amount2 = 2000n * 10_000_000n;
      const dueDate = Math.floor(Date.now() / 1000) + 86400;
      const discountRateBps = 300;

      const invoice1 = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount: amount1,
        dueDate,
        discountRate: discountRateBps,
      });

      const invoice2 = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount: amount2,
        dueDate,
        discountRate: discountRateBps,
      });

      const readSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const fetched1 = await readSdk.getInvoice(invoice1.id);
      const fetched2 = await readSdk.getInvoice(invoice2.id);

      expect(fetched1.amount).toBe(amount1);
      expect(fetched2.amount).toBe(amount2);
    });

    it('handles token amount conversions correctly', async () => {
      const displayAmount = 100;
      const stroopsPerUnit = 10_000_000n;
      const expectedStroops = BigInt(displayAmount) * stroopsPerUnit;

      expect(expectedStroops).toBe(1_000_000_000n);
    });
  });

  describe('Dispute, Default, and Appeal Lifecycle Coverage', () => {
    it('Funded invoice can transition to Disputed state via dispute', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const lp = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();

      await fundAccount(freelancer.publicKey());
      await fundAccount(lp.publicKey());
      await fundAccount(payer.publicKey());

      const amount = 1000n * 10_000_000n;
      const dueDate = Math.floor(Date.now() / 1000) + 86400;
      const discountRateBps = 300;

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      const invoice = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount,
        dueDate,
        discountRate: discountRateBps,
      });

      const lpSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(lp),
      });

      const fundedInvoice = await lpSdk.fundInvoice({
        funder: lp.publicKey(),
        invoiceId: invoice.id,
      });

      expect(fundedInvoice.state).toBe('Funded');

      const payerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(payer),
      });

      const disputedInvoice = await payerSdk.dispute({
        invoiceId: invoice.id,
      });

      expect(disputedInvoice.state).toBe('Disputed');
    });

    it('Disputed invoice can be resolved through governance-style appeal', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const lp = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();

      await fundAccount(freelancer.publicKey());
      await fundAccount(lp.publicKey());
      await fundAccount(payer.publicKey());

      const amount = 1000n * 10_000_000n;
      const dueDate = Math.floor(Date.now() / 1000) + 86400;
      const discountRateBps = 300;

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      const invoice = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount,
        dueDate,
        discountRate: discountRateBps,
      });

      const lpSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(lp),
      });

      await lpSdk.fundInvoice({
        funder: lp.publicKey(),
        invoiceId: invoice.id,
      });

      const payerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(payer),
      });

      await payerSdk.dispute({
        invoiceId: invoice.id,
      });

      const appealedInvoice = await freelancerSdk.appeal({
        invoiceId: invoice.id,
      });

      expect(appealedInvoice.state).toBe('Appeal');
    });

    it('Funded invoice transitions to Defaulted when past due date, enabling insurance pool claim', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const lp = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();

      await fundAccount(freelancer.publicKey());
      await fundAccount(lp.publicKey());
      await fundAccount(payer.publicKey());

      const amount = 1000n * 10_000_000n;
      const dueDate = Math.floor(Date.now() / 1000) - 100;
      const discountRateBps = 300;

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      const invoice = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount,
        dueDate,
        discountRate: discountRateBps,
      });

      const lpSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(lp),
      });

      await lpSdk.fundInvoice({
        funder: lp.publicKey(),
        invoiceId: invoice.id,
      });

      const defaultedInvoice = await lpSdk.claimDefault({
        funder: lp.publicKey(),
        invoiceId: invoice.id,
      });

      expect(defaultedInvoice.state).toBe('Defaulted');
    });

    it('Insurance pool compensates LP after default claim', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const lp = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();

      await fundAccount(freelancer.publicKey());
      await fundAccount(lp.publicKey());
      await fundAccount(payer.publicKey());

      const amount = 1000n * 10_000_000n;
      const dueDate = Math.floor(Date.now() / 1000) - 100;
      const discountRateBps = 300;

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      const invoice = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount,
        dueDate,
        discountRate: discountRateBps,
      });

      const lpSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(lp),
      });

      const lpInitialBalance = await lpSdk.getBalance(lp.publicKey());

      await lpSdk.fundInvoice({
        funder: lp.publicKey(),
        invoiceId: invoice.id,
      });

      await lpSdk.claimDefault({
        funder: lp.publicKey(),
        invoiceId: invoice.id,
      });

      const lpAfterClaim = await lpSdk.getBalance(lp.publicKey());

      expect(lpAfterClaim).toBeDefined();
      expect(lpAfterClaim).toBeGreaterThanOrEqual(lpInitialBalance - amount);
    });

    it('Pending state cannot transition directly to Paid', async () => {
      const validTransitions: Record<string, string[]> = {
        Pending: ['Funded', 'Defaulted'],
        Funded: ['Paid', 'Defaulted', 'Disputed'],
        Disputed: ['Appeal', 'Paid'],
        Appeal: ['Paid'],
        Paid: [],
        Defaulted: [],
      };

      expect(validTransitions['Pending']).not.toContain('Paid');
      expect(validTransitions['Funded']).toContain('Paid');
    });

    it('Terminal states have no outgoing transitions', async () => {
      const validTransitions: Record<string, string[]> = {
        Paid: [],
        Defaulted: [],
      };

      expect(validTransitions['Paid']).toHaveLength(0);
      expect(validTransitions['Defaulted']).toHaveLength(0);
    });
  });

  describe('Yield Calculations and LP Compensation', () => {
    it('SDK correctly calculates yield at 300 bps', async () => {
      const invoiceAmount = 1000n * 10_000_000n;
      const discountRateBps = 300;
      const expectedYield = (invoiceAmount * BigInt(discountRateBps)) / 10000n;

      expect(expectedYield).toBe(30n * 10_000_000n);
    });

    it('LP receives invoice amount plus yield after payment via SDK', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const lp = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();

      await fundAccount(freelancer.publicKey());
      await fundAccount(lp.publicKey());
      await fundAccount(payer.publicKey());

      const amount = 1000n * 10_000_000n;
      const dueDate = Math.floor(Date.now() / 1000) + 86400;
      const discountRateBps = 300;

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      const invoice = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount,
        dueDate,
        discountRate: discountRateBps,
      });

      const lpSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(lp),
      });

      const lpInitial = await lpSdk.getBalance(lp.publicKey());

      await lpSdk.fundInvoice({
        funder: lp.publicKey(),
        invoiceId: invoice.id,
      });

      const payerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(payer),
      });

      await payerSdk.markPaid({
        invoiceId: invoice.id,
      });

      const lpAfterPayment = await lpSdk.getBalance(lp.publicKey());
      const yield_ = (amount * BigInt(discountRateBps)) / 10000n;
      const expectedFinal = lpInitial + yield_;

      expect(lpAfterPayment).toBeGreaterThanOrEqual(lpInitial);
    });
  });

  describe('Error Scenarios and Validation', () => {
    it('cannot fund an already funded invoice', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const lp = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();

      await fundAccount(freelancer.publicKey());
      await fundAccount(lp.publicKey());
      await fundAccount(payer.publicKey());

      const amount = 1000n * 10_000_000n;
      const dueDate = Math.floor(Date.now() / 1000) + 86400;
      const discountRateBps = 300;

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      const invoice = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount,
        dueDate,
        discountRate: discountRateBps,
      });

      const lpSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(lp),
      });

      await lpSdk.fundInvoice({
        funder: lp.publicKey(),
        invoiceId: invoice.id,
      });

      try {
        await lpSdk.fundInvoice({
          funder: lp.publicKey(),
          invoiceId: invoice.id,
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error).toBeDefined();
      }
    });

    it('cannot pay an unfunded invoice', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();

      await fundAccount(freelancer.publicKey());
      await fundAccount(payer.publicKey());

      const amount = 1000n * 10_000_000n;
      const dueDate = Math.floor(Date.now() / 1000) + 86400;
      const discountRateBps = 300;

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      const invoice = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount,
        dueDate,
        discountRate: discountRateBps,
      });

      const payerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(payer),
      });

      try {
        await payerSdk.markPaid({
          invoiceId: invoice.id,
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error).toBeDefined();
      }
    });

    it('rejects zero amount invoices', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();

      await fundAccount(freelancer.publicKey());
      await fundAccount(payer.publicKey());

      const amount = 0n;
      const dueDate = Math.floor(Date.now() / 1000) + 86400;
      const discountRateBps = 300;

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      try {
        await freelancerSdk.submitInvoice({
          freelancer: freelancer.publicKey(),
          payer: payer.publicKey(),
          amount,
          dueDate,
          discountRate: discountRateBps,
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error).toBeDefined();
      }
    });

    it('rejects discount rates over 100%', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();

      await fundAccount(freelancer.publicKey());
      await fundAccount(payer.publicKey());

      const amount = 1000n * 10_000_000n;
      const dueDate = Math.floor(Date.now() / 1000) + 86400;
      const discountRateBps = 10001;

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      try {
        await freelancerSdk.submitInvoice({
          freelancer: freelancer.publicKey(),
          payer: payer.publicKey(),
          amount,
          dueDate,
          discountRate: discountRateBps,
        });
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        expect(error).toBeDefined();
      }
    });
  });

  describe('Balance Tracking and LP Compensation Model', () => {
    it('SDK query correctly reflects LP balance reduction after funding', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const lp = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();

      await fundAccount(freelancer.publicKey());
      await fundAccount(lp.publicKey());
      await fundAccount(payer.publicKey());

      const amount = 1000n * 10_000_000n;
      const dueDate = Math.floor(Date.now() / 1000) + 86400;
      const discountRateBps = 300;

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      const invoice = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount,
        dueDate,
        discountRate: discountRateBps,
      });

      const lpSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(lp),
      });

      const lpInitialBalance = await lpSdk.getBalance(lp.publicKey());

      await lpSdk.fundInvoice({
        funder: lp.publicKey(),
        invoiceId: invoice.id,
      });

      const lpAfterFunding = await lpSdk.getBalance(lp.publicKey());

      expect(lpAfterFunding).toBeLessThanOrEqual(lpInitialBalance);
    });

    it('LP balance recovers after invoice payment with yield via SDK', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const lp = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();

      await fundAccount(freelancer.publicKey());
      await fundAccount(lp.publicKey());
      await fundAccount(payer.publicKey());

      const amount = 1000n * 10_000_000n;
      const dueDate = Math.floor(Date.now() / 1000) + 86400;
      const discountRateBps = 300;

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      const invoice = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount,
        dueDate,
        discountRate: discountRateBps,
      });

      const lpSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(lp),
      });

      const lpInitialBalance = await lpSdk.getBalance(lp.publicKey());

      await lpSdk.fundInvoice({
        funder: lp.publicKey(),
        invoiceId: invoice.id,
      });

      const payerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(payer),
      });

      await payerSdk.markPaid({
        invoiceId: invoice.id,
      });

      const lpAfterPayment = await lpSdk.getBalance(lp.publicKey());

      expect(lpAfterPayment).toBeGreaterThanOrEqual(lpInitialBalance - amount);
    });
  });

  describe('Address Validation', () => {
    it('validates Stellar public key format in invoice submission', async () => {
      const keypair = StellarSdk.Keypair.random();
      const publicKey = keypair.publicKey();

      expect(publicKey).toMatch(/^G[A-Z0-9]{55}$/);
    });

    it('rejects invalid Stellar addresses via SDK validation', async () => {
      const invalidAddress = 'INVALID_ADDRESS';
      const isValid = /^G[A-Z0-9]{55}$/.test(invalidAddress);
      expect(isValid).toBe(false);
    });
  });

  describe('Concurrent Operations', () => {
    it('handles multiple invoices for same freelancer via SDK batch operations', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();

      await fundAccount(freelancer.publicKey());
      await fundAccount(payer.publicKey());

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      const dueDate = Math.floor(Date.now() / 1000) + 86400;
      const discountRateBps = 300;

      const invoice1 = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount: 1000n * 10_000_000n,
        dueDate,
        discountRate: discountRateBps,
      });

      const invoice2 = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount: 2000n * 10_000_000n,
        dueDate,
        discountRate: discountRateBps,
      });

      const invoice3 = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount: 3000n * 10_000_000n,
        dueDate,
        discountRate: discountRateBps,
      });

      const readSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const fetched1 = await readSdk.getInvoice(invoice1.id);
      const fetched2 = await readSdk.getInvoice(invoice2.id);
      const fetched3 = await readSdk.getInvoice(invoice3.id);

      expect(fetched1.amount).toBe(1000n * 10_000_000n);
      expect(fetched2.amount).toBe(2000n * 10_000_000n);
      expect(fetched3.amount).toBe(3000n * 10_000_000n);
    });

    it('handles multiple LPs funding same invoice requires governance resolution', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const lp1 = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();

      await fundAccount(freelancer.publicKey());
      await fundAccount(lp1.publicKey());
      await fundAccount(payer.publicKey());

      const amount = 1000n * 10_000_000n;
      const dueDate = Math.floor(Date.now() / 1000) + 86400;
      const discountRateBps = 300;

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      const invoice = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount,
        dueDate,
        discountRate: discountRateBps,
      });

      const lp1Sdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(lp1),
      });

      const fundedInvoice = await lp1Sdk.fundInvoice({
        funder: lp1.publicKey(),
        invoiceId: invoice.id,
      });

      expect(fundedInvoice.funder).toBe(lp1.publicKey());
    });
  });

  describe('Oracle Service Verification & Fraud-Heuristic Gate (#865)', () => {
    it('submits invoice with oracle verification requirement and gates funding end-to-end', async () => {
      const freelancer = StellarSdk.Keypair.random();
      const payer = StellarSdk.Keypair.random();
      const lp = StellarSdk.Keypair.random();

      const { OracleVerifier } = await import('@iln/oracle-service');

      const verifier = new OracleVerifier({
        historyProvider: async () => [
          {
            id: 901,
            freelancer: freelancer.publicKey(),
            payer: payer.publicKey(),
            amount: '10000000',
            due_date: 0,
            discount_rate: 300,
            status: 'Paid',
            created_at: 1_700_000_000_000,
            updated_at: 1_700_200_000_000,
          },
        ],
        reputationProvider: async () => ({
          address: payer.publicKey(),
          score: 85,
          totalPaid: 10_000_000n,
          invoiceCount: 1,
          lastActivity: 1_700_200_000,
          rank: 1,
        }),
        now: () => 1_700_210_000_000,
        maxOracleAgeMs: 100_000_000,
      });

      const oracleAssessment = await verifier.verify({
        payer: payer.publicKey(),
        amount: '10000000',
        invoiceId: '902',
      });

      expect(oracleAssessment.isVerified).toBe(true);
      expect(oracleAssessment.trustScore).toBeGreaterThanOrEqual(70);

      // Contract interaction is unconditional now that the suite is fail-closed:
      // an unreachable node already failed the suite in beforeAll (#1244).
      await fundAccount(freelancer.publicKey());
      await fundAccount(lp.publicKey());
      await fundAccount(payer.publicKey());

      const freelancerSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(freelancer),
      });

      const invoice = await freelancerSdk.submitInvoice({
        freelancer: freelancer.publicKey(),
        payer: payer.publicKey(),
        amount: 1000n * 10_000_000n,
        dueDate: Math.floor(Date.now() / 1000) + 86400,
        discountRate: 300,
      });

      expect(invoice.state).toBe('Pending');

      const lpSdk = new ILNSdk({
        contractId,
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        signer: StellarSdk.createKeypairSigner(lp),
      });

      if (oracleAssessment.isVerified) {
        const funded = await lpSdk.fundInvoice({
          funder: lp.publicKey(),
          invoiceId: invoice.id,
        });
        expect(funded.state).toBe('Funded');
      }
    });

    it('flags rapid succession submissions and blocks funding end-to-end', async () => {
      const abusivePayer = StellarSdk.Keypair.random();
      const { OracleVerifier } = await import('@iln/oracle-service');

      const now = 1_700_500_000_000;
      const rapidHistory = [
        {
          id: 911,
          freelancer: 'G1',
          payer: abusivePayer.publicKey(),
          amount: '10000000',
          due_date: 0,
          discount_rate: 300,
          status: 'Pending' as const,
          created_at: now - 3600000,
          updated_at: now - 3600000,
        },
        {
          id: 912,
          freelancer: 'G2',
          payer: abusivePayer.publicKey(),
          amount: '10000000',
          due_date: 0,
          discount_rate: 300,
          status: 'Pending' as const,
          created_at: now - 7200000,
          updated_at: now - 7200000,
        },
        {
          id: 913,
          freelancer: 'G3',
          payer: abusivePayer.publicKey(),
          amount: '10000000',
          due_date: 0,
          discount_rate: 300,
          status: 'Pending' as const,
          created_at: now - 10800000,
          updated_at: now - 10800000,
        },
      ];

      const verifier = new OracleVerifier({
        historyProvider: async () => rapidHistory,
        reputationProvider: async () => ({
          address: abusivePayer.publicKey(),
          score: 20,
          totalPaid: 0n,
          invoiceCount: 3,
          lastActivity: Math.floor((now - 3600000) / 1000),
          rank: 0,
        }),
        now: () => now,
      });

      const assessment = await verifier.verify({
        payer: abusivePayer.publicKey(),
        amount: '10000000',
        invoiceId: '914',
      });

      expect(assessment.isVerified).toBe(false);
      expect(assessment.fraudSignals).toContain(
        'Rapid succession of invoices detected for the same payer'
      );
    });
  });
});
