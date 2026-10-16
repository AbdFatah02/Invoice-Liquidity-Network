/**
 * Re-exported shared types from the @iln/shared package.
 * These represent core domain objects used throughout the SDK.
 */
import type { ContractStats, GovernanceProposal, Invoice, ReputationScore } from '@iln/shared';
import type { CacheConfig } from './cache';
import type { BackoffOptions } from './backoff';

// Note: GovernanceProposal and ProposalStatus are intentionally NOT
// re-exported here — the SDK's public API surfaces the SDK-specific
// versions from ./governance-types (see governance.ts), which
// deliberately differ from @iln/shared's raw contract-shaped types.
export type {
  ContractEvent,
  ContractStats,
  Invoice,
  InvoiceState,
  LPStats,
  ReputationScore,
  Token,
} from '@iln/shared';

export type {
  InvoiceCreatedEvent,
  InvoiceFundedEvent,
  InvoiceRepaidEvent,
  InvoiceDefaultedEvent,
  GovernanceProposalCreatedEvent,
  GovernanceProposalVotedEvent,
  GovernanceProposalExecutedEvent,
  TokenListedEvent,
  TokenDelistedEvent,
  ReputationUpdatedEvent,
  ContractStatsUpdatedEvent,
  LPStatsUpdatedEvent,
} from '@iln/shared';

/**
 * Parameters for submitting a new invoice to the ILN contract.
 *
 * @property freelancer - Stellar address of the freelancer submitting the invoice.
 * @property payer - Stellar address of the payer responsible for the invoice.
 * @property amount - Invoice amount in the smallest token unit (e.g. stroops for XLM).
 * @property dueDate - Unix timestamp in seconds when the invoice payment is due.
 * @property discountRate - Discount rate in basis points (e.g. 500 = 5%).
 */
export interface SubmitInvoiceParams {
  freelancer: string;
  payer: string;
  amount: bigint;
  dueDate: number;
  discountRate: number;
}

/**
 * Parameters for funding an existing invoice.
 *
 * @property funder - Stellar address of the liquidity provider funding the invoice.
 * @property invoiceId - The on-chain ID of the invoice to fund.
 */
export interface FundInvoiceParams {
  funder: string;
  invoiceId: bigint;
}

/**
 * Parameters for claiming a default on an unpaid invoice.
 *
 * @property funder - Stellar address of the liquidity provider claiming the default.
 * @property invoiceId - The on-chain ID of the invoice to claim default on.
 */
export interface ClaimDefaultParams {
  funder: string;
  invoiceId: bigint;
}

/**
 * Parameters for marking an invoice as paid.
 *
 * @property invoiceId - The on-chain ID of the invoice to mark as paid.
 */
export interface MarkPaidParams {
  invoiceId: bigint;
}

/**
 * Protocol-level configuration retrieved from the ILN smart contract.
 *
 * @property minInvoiceAmount - Minimum invoice amount allowed by the protocol.
 * @property maxDiscountRate - Maximum discount rate in basis points.
 * @property protocolFeeBps - Protocol fee in basis points.
 * @property minPayerReputation - Minimum reputation score required for payers.
 * @property decayRateBps - Reputation decay rate in basis points.
 * @property maxInvoiceDuration - Optional maximum invoice duration in seconds.
 * @property minInvoiceDuration - Optional minimum invoice duration in seconds.
 * @property gracePeriodSeconds - Optional grace period in seconds after due date.
 */
export interface ProtocolConfig {
  minInvoiceAmount: bigint;
  maxDiscountRate: number;
  protocolFeeBps: number;
  minPayerReputation: number;
  decayRateBps: number;
  maxInvoiceDuration?: number;
  minInvoiceDuration?: number;
  gracePeriodSeconds?: number;
}

/**
 * Options passed to a transaction signer when signing.
 *
 * @property address - Optional Stellar address to sign as (for multi-sig wallets).
 * @property networkPassphrase - The Stellar network passphrase for the target network.
 */
export interface SignTransactionOptions {
  address?: string;
  networkPassphrase: string;
}

/**
 * Interface for transaction signing implementations.
 * Implement this to integrate with hardware wallets, browser extensions, or custom signers.
 *
 * @example
 * ```ts
 * const signer: TransactionSigner = {
 *   async getPublicKey() { return "GABC..."; },
 *   async signTransaction(xdr, opts) { return signedXdr; },
 * };
 * ```
 */
export interface TransactionSigner {
  /** Returns the public key of the signing account. */
  getPublicKey(): Promise<string>;
  /**
   * Sign a serialized transaction.
   * @param transactionXdr - Base64-encoded XDR transaction envelope.
   * @param options - Signing options including network passphrase.
   * @returns The signed transaction as a base64-encoded XDR string.
   */
  signTransaction(transactionXdr: string, options: SignTransactionOptions): Promise<string>;
}

/**
 * Abstraction over a Stellar RPC server for dependency injection and testing.
 * Compatible with @stellar/stellar-sdk's `rpc.Server`.
 */
export interface RpcServerLike {
  getAccount(address: string): Promise<unknown>;
  simulateTransaction(transaction: unknown): Promise<unknown>;
  prepareTransaction(transaction: unknown): Promise<{ toXDR(): string }>;
  sendTransaction(transaction: unknown): Promise<unknown>;
  pollTransaction(hash: string, options?: { attempts?: number }): Promise<unknown>;
  getLatestLedger?(): Promise<unknown>;
}

/**
 * Configuration for initializing the ILN SDK client.
 *
 * @property contractId - The Soroban contract ID for the ILN contract.
 * @property rpcUrl - URL of the Stellar Soroban RPC server.
 * @property networkPassphrase - The Stellar network passphrase (e.g. `Networks.TESTNET`).
 * @property signer - Optional transaction signer for state-changing operations.
 * @property server - Optional custom RPC server implementation.
 * @property timeoutMs - Fallback timeout for all network requests in ms (default: 30000).
 * @property timeouts - Per-operation timeout overrides in milliseconds.
 *
 * @example
 * ```ts
 * import { ILNSdk, ILN_TESTNET } from "@iln/sdk";
 *
 * const sdk = new ILNSdk({
 *   ...ILN_TESTNET,
 *   signer: createKeypairSigner(secretKey),
 * });
 * ```
 */
export interface ILNSdkConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  signer?: TransactionSigner;
  server?: RpcServerLike;
  timeoutMs?: number;
  timeouts?: {
    readMs?: number;
    writeMs?: number;
    simulationMs?: number;
  };
  /**
   * Whether to verify the contractId against known official ILN deployment IDs on initialization.
   * Defaults to true. If set to true (or omitted) and the contractId does not match a known official deployment,
   * a loud warning will be logged to alert integrators of possible misconfiguration.
   */
  verifyContractId?: boolean;
  /**
   * Enable the offline transaction queue.
   * When provided, write methods (`submitInvoice`, `fundInvoice`, `markPaid`,
   * `claimDefault`) will automatically queue operations while the client is
   * offline and submit them when connectivity is restored.
   * Set to `{}` to use all defaults.
   */
  offline?: import('./offline').OfflineConfig;
  /**
   * Backoff/retry configuration for transient RPC failures.
   * Set to `false` to disable automatic retries. When not provided,
   * defaults to 3 retries with exponential backoff and jitter.
   */
  backoff?: BackoffOptions | false;
  /**
   * Cache configuration for read operations.
   * Set to `{ enabled: false }` to disable caching.
   * Defaults to `{ ttl: 60000, storage: 'memory', enabled: true }`.
   */
  cache?: CacheConfig;
  /**
   * Opt-in request batching and deduplication configuration for near-simultaneous reads.
   * Set to `true` or `{ enabled: true, windowMs: 10 }` to coalesce near-simultaneous identical read requests.
   * Defaults to `false` (disabled).
   */
  batching?: import('./batcher').RequestBatchingOptions | boolean;
}

export type { RequestBatchingOptions, BatchingMetrics } from './batcher';

/**
 * Pre-configured network settings for connecting to a Stellar network.
 * Use the built-in `ILN_TESTNET` constant for testnet connections.
 */
export interface NetworkConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
}

/**
 * Result of an SDK-to-contract compatibility check.
 *
 * @property compatible - Whether the SDK and contract versions are compatible.
 * @property contractVersion - The deployed contract's semver version string.
 * @property sdkVersion - The SDK's semver version string.
 * @property issues - List of compatibility issues found (empty if compatible).
 */
export interface CompatibilityResult {
  compatible: boolean;
  contractVersion: string;
  sdkVersion: string;
  issues: string[];
}

/**
 * Result of executing a batch of operations.
 *
 * @property success - Whether the entire batch succeeded.
 * @property transactionHash - The on-chain transaction hash (if submitted).
 * @property results - Per-operation results with individual success/failure.
 * @property totalFee - Total network fee paid for the batch in stroops.
 */
export interface BatchResult {
  success: boolean;
  transactionHash?: string;
  results: BatchOperationResult[];
  totalFee: bigint;
}

/**
 * Result of a single operation within a batch.
 *
 * @property index - The index of the operation in the batch.
 * @property success - Whether this specific operation succeeded.
 * @property error - Error message if the operation failed.
 * @property invoiceId - The invoice ID if the operation created one.
 */
export interface BatchOperationResult {
  index: number;
  success: boolean;
  error?: string;
  invoiceId?: bigint;
}

/**
 * Parameters for batch-submitting multiple invoices in a single transaction.
 *
 * @property invoices - Array of invoice parameters to submit.
 */
export interface BatchSubmitParams {
  invoices: Array<{
    freelancer: string;
    payer: string;
    amount: bigint;
    dueDate: number;
    discountRate: number;
  }>;
}

/**
 * Parameters for batch-funding multiple invoices in a single transaction.
 *
 * @property funder - Stellar address of the funding account.
 * @property invoiceIds - Array of invoice IDs to fund.
 */
export interface BatchFundParams {
  funder: string;
  invoiceIds: bigint[];
}

/**
 * Parameters for batch-marking multiple invoices as paid in a single transaction.
 *
 * @property invoiceIds - Array of invoice IDs to mark as paid.
 */
export interface BatchPayParams {
  invoiceIds: bigint[];
}

export interface GovernanceParamTypes {
  minInvoiceAmount: bigint;
  maxDiscountRate: number;
  protocolFeeBps: number;
  minPayerReputation: number;
}

export interface ILNClient {
  getInvoice(id: number | bigint): Promise<Invoice>;
  getInvoicesByIssuer(issuer: string): Promise<Invoice[]>;
  getInvoicesByStatus(status: string): Promise<Invoice[]>;
  getReputationScore(address: string): Promise<ReputationScore>;
  getLPPortfolio(address: string): Promise<LPPortfolio>;
  getContractStats(): Promise<ContractStats>;
  getProposal(id: number | bigint): Promise<GovernanceProposal>;
  getTokenBalances(address: string): Promise<TokenBalance[]>;
  submitInvoice(params: Record<string, unknown>): Promise<unknown>;
  fundInvoice(params: Record<string, unknown>): Promise<void>;
  markPaid(params: Record<string, unknown>): Promise<void>;
  createProposal(params: Record<string, unknown>): Promise<unknown>;
  vote(params: Record<string, unknown>): Promise<void>;
  connectWallet(): Promise<string>;
  getLPCoverage?(address: string): Promise<import('./insurance-types').LPCoverage | null>;
  getPoolBalance?(): Promise<import('./insurance-types').PoolBalance>;
  getClaim?(claimId: bigint): Promise<import('./insurance-types').InsuranceClaim>;
  listClaims?(
    statusFilter?: import('./insurance-types').ClaimStatus,
    page?: number,
    pageSize?: number
  ): Promise<import('./insurance-types').InsuranceClaim[]>;
  enroll?(params: import('./insurance-types').EnrollParams): Promise<void>;
  depositPremium?(params: import('./insurance-types').DepositPremiumParams): Promise<void>;
  submitClaim?(params: import('./insurance-types').SubmitClaimParams): Promise<bigint>;
  reviewClaim?(params: import('./insurance-types').ReviewClaimParams): Promise<void>;
}

export interface TokenBalance {
  token: string;
  contractId: string;
  balance: bigint;
}

export interface LPPortfolio {
  address: string;
  totalInvested: bigint;
  totalYield: bigint;
  activePositions: number;
  completedPositions: number;
  defaultedPositions: number;
  avgReturn: number;
}

export interface Proposal {
  id: number;
  proposer: string;
  parameter: string;
  newValue: number;
  votesFor: bigint;
  votesAgainst: bigint;
  deadline: number;
  executed: boolean;
}
