import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';

import type { NetworkConfig, SignTransactionOptions, TransactionSigner } from './types';

const TESTNET_CONTRACT_ID = 'CD3TE3IAHM737P236XZL2OYU275ZKD6MN7YH7PYYAXYIGEH55OPEWYJC';
const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';

/**
 * Pre-configured network settings for the ILN testnet contract.
 * Use this to quickly configure the SDK for testnet development.
 *
 * @example
 * ```ts
 * const sdk = new ILNSdk({
 *   ...ILN_TESTNET,
 *   signer: createKeypairSigner(secretKey),
 * });
 * ```
 */
export const ILN_TESTNET: NetworkConfig = {
  contractId: TESTNET_CONTRACT_ID,
  rpcUrl: TESTNET_RPC_URL,
  networkPassphrase: Networks.TESTNET,
};

/**
 * Create a transaction signer from a Stellar secret key.
 * Uses the Stellar SDK's Keypair for signing.
 *
 * @param secretKey - The Stellar secret key (starts with "S").
 * @returns A TransactionSigner implementation.
 *
 * @example
 * ```ts
 * import { createKeypairSigner } from "@iln/sdk";
 *
 * const signer = createKeypairSigner("S...");
 * const sdk = new ILNSdk({
 *   ...ILN_TESTNET,
 *   signer,
 * });
 * ```
 */
export function createKeypairSigner(secretKey: string): TransactionSigner {
  const keypair = Keypair.fromSecret(secretKey);

  return {
    async getPublicKey() {
      return keypair.publicKey();
    },
    async signTransaction(transactionXdr: string, options: SignTransactionOptions) {
      const transaction = TransactionBuilder.fromXDR(transactionXdr, options.networkPassphrase);

      transaction.sign(keypair);
      return transaction.toXDR();
    },
  };
}

/**
 * Create a transaction signer using the Freighter browser extension.
 * Only available in browser environments.
 *
 * @param address - Optional Stellar address to use. If not provided, Freighter will
 *                  prompt the user to select or connect an account.
 * @returns A TransactionSigner implementation backed by Freighter.
 * @throws {Error} If called outside a browser environment.
 * @throws {Error} If the Freighter extension is not installed or connected.
 *
 * @example
 * ```ts
 * import { createFreighterSigner } from "@iln/sdk";
 *
 * const signer = createFreighterSigner();
 * const sdk = new ILNSdk({
 *   ...ILN_TESTNET,
 *   signer,
 * });
 * ```
 */
export function createFreighterSigner(address?: string): TransactionSigner {
  return {
    async getPublicKey() {
      const freighter = await loadFreighter();
      return address ?? (await resolveFreighterAddress(freighter));
    },
    async signTransaction(transactionXdr: string, options: SignTransactionOptions) {
      const freighter = await loadFreighter();
      const selected = options.address ?? address ?? (await resolveFreighterAddress(freighter));

      await assertFreighterNetwork(freighter, options.networkPassphrase);

      const result = await freighter.signTransaction(transactionXdr, {
        address: selected,
        networkPassphrase: options.networkPassphrase,
      });

      if (result.error || !result.signedTxXdr) {
        throw new Error(
          result.error ? String(result.error) : 'Freighter did not return a signed transaction.'
        );
      }

      return result.signedTxXdr;
    },
  };
}

type FreighterModule = {
  getAddress: () => Promise<{ address?: string; error?: unknown }>;
  getNetworkDetails?: () => Promise<{
    networkPassphrase?: string;
    error?: unknown;
  }>;
  isConnected?: () => Promise<{ isConnected?: boolean; error?: unknown }>;
  requestAccess: () => Promise<{ address?: string; error?: unknown }>;
  signTransaction: (
    transactionXdr: string,
    options: { address?: string; networkPassphrase: string }
  ) => Promise<{ error?: unknown; signedTxXdr?: string }>;
};

async function loadFreighter(): Promise<FreighterModule> {
  if (typeof window === 'undefined') {
    throw new Error('Freighter signing is only available in browser environments.');
  }

  const freighter = await import('@stellar/freighter-api');
  const connected = freighter.isConnected ? await freighter.isConnected() : undefined;

  if (connected?.error) {
    throw new Error(String(connected.error));
  }

  if (connected && !connected.isConnected) {
    throw new Error('Freighter extension is not installed or not available.');
  }

  return freighter as FreighterModule;
}

async function resolveFreighterAddress(freighter: FreighterModule): Promise<string> {
  const current = await freighter.getAddress();
  if (current.error) {
    throw new Error(String(current.error));
  }
  if (current.address) {
    return current.address;
  }

  const requested = await freighter.requestAccess();
  if (requested.error || !requested.address) {
    throw new Error(
      requested.error ? String(requested.error) : 'Freighter did not provide an account address.'
    );
  }

  return requested.address;
}

async function assertFreighterNetwork(
  freighter: FreighterModule,
  expectedPassphrase: string = Networks.TESTNET
): Promise<void> {
  if (!freighter.getNetworkDetails) {
    return;
  }

  const network = await freighter.getNetworkDetails();
  if (!network) {
    return;
  }
  if (network.error) {
    throw new Error(String(network.error));
  }

  if (
    network.networkPassphrase &&
    expectedPassphrase &&
    network.networkPassphrase !== expectedPassphrase
  ) {
    throw new Error('Freighter is connected to a different Stellar network.');
  }
}
