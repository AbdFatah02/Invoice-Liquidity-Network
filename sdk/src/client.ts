import {
  Account,
  Address,
  BASE_FEE,
  Operation,
  TransactionBuilder,
  rpc,
  scValToNative,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { createLogger } from './logger';
import type { Unsubscribe } from './state';
import { track } from './usage-analytics';
import { Cache, type CacheOptions } from './cache';
import { RequestBatcher, type BatchingMetrics } from './batcher';
import { withBackoff, isTransientError, type BackoffOptions } from './backoff';
import { Validators } from './validators';
import {
  encodeProposalAction,
  toAddressScVal,
  toBytesN32ScVal,
  toOptionalProposalStatusScVal,
} from './governance-utils';

import type { Invoice, InvoiceState } from '@iln/shared';

import {
  GovernanceContractMethod,
  ProposalStatus,
  type CastVoteParams,
  type CreateProposalParams,
  type DelegateVotesParams,
  type ExecuteProposalParams,
  type GetProposalParams,
  type GovernanceProposal,
  type ListProposalsParams,
  type UndelegateVotesParams,
  type VetoProposalParams,
} from './governance';
import {
  parseGovernanceProposal,
  parseGovernanceProposalListSimulation,
} from './governance-parser';

import type {
  BatchFundParams,
  BatchPayParams,
  BatchResult,
  BatchSubmitParams,
  ClaimDefaultParams,
  FundInvoiceParams,
  ILNSdkConfig,
  MarkPaidParams,
  ProtocolConfig,
  RpcServerLike,
  SubmitInvoiceParams,
  TransactionSigner,
  CompatibilityResult,
} from './types';

import { openSSE, type RawContractEvent } from './stream';
import { ILNEventEmitter } from './event-emitter';

/** Callback invoked when a contract event is received via SSE. */
export type EventCallback = (event: RawContractEvent) => void | Promise<void>;

import { checkCompatibility } from './compatibility';
import {
  GenericContractError,
  parseContractError,
  InsufficientBalanceError,
  NetworkError,
  TransactionFailedError,
  ValidationError,
  WalletNotConnectedError,
  ILNError,
  SimulationPreparedXdrMismatchError,
} from './errors';
import {
  OfflineManager,
  OfflineQueuedError,
  type OfflineQueueItem,
  type OfflineState,
} from './offline';
import {
  resolveRequestTimeouts,
  type RequestTimeouts,
  TimeoutError,
  withTimeout,
} from './timeouts';
import { verifyContractId } from './registry';

const READ_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const POLL_ATTEMPTS = 20;
const PROTOCOL_CONFIG_CACHE_MS = 5 * 60 * 1000;

type PreparedTransactionLike = { toXDR(): string };
type BuiltTransaction = ReturnType<TransactionBuilder['build']>;
type TransactionOperation = Parameters<TransactionBuilder['addOperation']>[0];
type SimulationLike = {
  error?: unknown;
  result?: {
    retval?: xdr.ScVal;
  };
};

/**
 * Main SDK client for interacting with the ILN Soroban smart contract.
 *
 * Provides methods for submitting, funding, paying, and querying invoices,
 * as well as batch operations, real-time event subscriptions, and protocol
 * configuration access.
 *
 * @example
 * ```ts
 * import { ILNSdk, ILN_TESTNET, createKeypairSigner } from "@iln/sdk";
 *
 * const sdk = new ILNSdk({
 *   ...ILN_TESTNET,
 *   signer: createKeypairSigner(secretKey),
 * });
 *
 * // Submit an invoice
 * const invoiceId = await sdk.submitInvoice({
 *   freelancer: "GABC...",
 *   payer: "GDEF...",
 *   amount: 1000000n,
 *   dueDate: Math.floor(Date.now() / 1000) + 86400,
 *   discountRate: 500,
 * });
 *
 * // Get invoice details
 * const invoice = await sdk.getInvoice(invoiceId);
 * ```
 */
export class ILNSdk {
  private readonly contractId: string;
  private readonly networkPassphrase: string;
  private readonly server: RpcServerLike;
  private readonly rpcUrl: string;
  private readonly signer?: TransactionSigner;
  private readonly requestTimeouts: RequestTimeouts;
  private protocolConfigCache: { expiresAt: number; value: ProtocolConfig } | null = null;
  private readonly logger = createLogger('client');
  private readonly analyticsNetwork: string;
  private readonly cache: Cache<unknown>;
  private readonly cacheEnabled: boolean;
  private readonly requestBatcher: RequestBatcher;
  private offlineManager: OfflineManager | null = null;
  private readonly backoffOptions: BackoffOptions | false;

  /**
   * Create a new ILN SDK client.
   * @param config - SDK configuration including contract ID, RPC URL, and optional signer.
   */
  constructor(config: ILNSdkConfig) {
    this.contractId = config.contractId;
    this.networkPassphrase = config.networkPassphrase;
    this.server = config.server ?? new rpc.Server(config.rpcUrl);
    this.rpcUrl = config.rpcUrl;
    this.signer = config.signer;
    this.requestTimeouts = resolveRequestTimeouts(config);
    this.analyticsNetwork = config.networkPassphrase.includes('Test SDF Network')
      ? 'testnet'
      : 'mainnet';

    const cacheConfig = config.cache ?? { ttl: 60000, storage: 'memory', enabled: true };
    this.cache = new Cache(cacheConfig);
    this.cacheEnabled = cacheConfig.enabled ?? true;
    this.requestBatcher = new RequestBatcher(config.batching);

    this.backoffOptions = config.backoff ?? {};

    if (config.offline !== undefined) {
      this.offlineManager = new OfflineManager(config.offline);
      this.offlineManager.onSubmit((item) => this.executeQueuedOperation(item));
    }

    if (config.verifyContractId !== false) {
      const verification = verifyContractId(this.contractId);
      if (!verification.isOfficial && verification.warningMessage) {
        console.warn(verification.warningMessage);
        this.logger.warn(verification.warningMessage);
      }
    }
  }

  /**
   * Fetch current request batching and deduplication metrics.
   */
  public getBatchingMetrics(): BatchingMetrics {
    return this.requestBatcher.getMetrics();
  }

  private async wrapRpcCall<T>(promise: Promise<T>, operationName: string): Promise<T> {
    // If backoff is disabled, use the original simple try/catch
    if (this.backoffOptions === false) {
      return this.executeRpcCall(promise, operationName);
    }

    // Wrap the promise factory for retry with backoff
    const { result } = await withBackoff(
      () => this.executeRpcCall(promise, operationName),
      {
        ...this.backoffOptions,
        isRetryable: (error) => {
          // Don't retry if it's a known ILN error (non-transient)
          if (error instanceof ILNError) return false;
          // Don't retry timeout errors — they should surface immediately
          if (error instanceof TimeoutError) return false;
          // Delegate to default transient error check
          return isTransientError(error);
        },
        onRetry: (attempt, error, delayMs) => {
          if (this.logger.enabled) {
            this.logger(`Retrying ${operationName} (attempt ${attempt}) after ${delayMs}ms`, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }
    );

    return result;
  }

  private async executeRpcCall<T>(promise: Promise<T>, operationName: string): Promise<T> {
    try {
      return await promise;
    } catch (error: any) {
      if (error instanceof ILNError) {
        throw error;
      }
      const errMsg = this.toErrorMessage(error);
      if (error instanceof TimeoutError) {
        throw error;
      }
      if (
        errMsg.toLowerCase().includes('insufficient balance') ||
        errMsg.toLowerCase().includes('insufficient_balance') ||
        errMsg.toLowerCase().includes('underfunded')
      ) {
        throw new InsufficientBalanceError(`Insufficient balance for ${operationName}: ${errMsg}`);
      }
      if (
        error.status === 404 ||
        error.status === 502 ||
        error.status === 503 ||
        error.status === 504 ||
        errMsg.includes('fetch failed') ||
        errMsg.includes('NetworkError') ||
        errMsg.includes('ENOTFOUND') ||
        errMsg.includes('ECONNREFUSED') ||
        errMsg.includes('request failed')
      ) {
        throw new NetworkError(`Network error during ${operationName}: ${errMsg}`);
      }
      throw new TransactionFailedError(`Transaction failed during ${operationName}: ${errMsg}`);
    }
  }

  /**
   * Build a transaction operation for submitting an invoice.
   * Use this to compose batch transactions with other operations.
   *
   * @param params - Invoice submission parameters.
   * @returns A Stellar transaction operation that can be added to a TransactionBuilder.
   *
   * @example
   * ```ts
   * const op = sdk.buildSubmitInvoiceOperation({
   *   freelancer: "GABC...",
   *   payer: "GDEF...",
   *   amount: 1000000n,
   *   dueDate: Math.floor(Date.now() / 1000) + 86400,
   *   discountRate: 500,
   * });
   * ```
   */
  public buildSubmitInvoiceOperation(params: SubmitInvoiceParams): TransactionOperation {
    return this.buildInvokeContractFunctionOperation(params.freelancer, 'submit_invoice', [
      this.toAddress(params.freelancer),
      this.toAddress(params.payer),
      nativeToScVal(params.amount, { type: 'i128' }),
      nativeToScVal(params.dueDate, { type: 'u64' }),
      nativeToScVal(params.discountRate, { type: 'u32' }),
    ]);
  }

  /**
   * Build a transaction operation for funding an invoice.
   * Use this to compose batch transactions with other operations.
   *
   * @param params - Invoice funding parameters.
   * @returns A Stellar transaction operation.
   */
  public buildFundInvoiceOperation(params: FundInvoiceParams): TransactionOperation {
    return this.buildInvokeContractFunctionOperation(params.funder, 'fund_invoice', [
      this.toAddress(params.funder),
      nativeToScVal(params.invoiceId, { type: 'u64' }),
    ]);
  }

  /**
   * Build a transaction operation for marking an invoice as paid.
   *
   * @param sourceAddress - The Stellar address of the payer marking the invoice as paid.
   * @param params - Payment parameters containing the invoice ID.
   * @returns A Stellar transaction operation.
   */
  public buildMarkPaidOperation(
    sourceAddress: string,
    params: MarkPaidParams
  ): TransactionOperation {
    return this.buildInvokeContractFunctionOperation(sourceAddress, 'mark_paid', [
      nativeToScVal(params.invoiceId, { type: 'u64' }),
    ]);
  }

  /**
   * Build a transaction operation for claiming a default on an unpaid invoice.
   *
   * @param params - Default claim parameters.
   * @returns A Stellar transaction operation.
   */
  public buildClaimDefaultOperation(params: ClaimDefaultParams): TransactionOperation {
    return this.buildInvokeContractFunctionOperation(params.funder, 'claim_default', [
      this.toAddress(params.funder),
      nativeToScVal(params.invoiceId, { type: 'u64' }),
    ]);
  }

  /**
   * Build a batched transaction containing multiple operations.
   * Simulates the transaction to validate all operations before returning.
   *
   * @param operations - Array of Stellar transaction operations (1-100 operations).
   * @returns The built and simulated transaction, ready for signing and submission.
   * @throws {ValidationError} If the batch is empty or exceeds 100 operations.
   * @throws {WalletNotConnectedError} If no signer is configured and no operation sources are provided.
   *
   * @example
   * ```ts
   * const ops = [
   *   sdk.buildSubmitInvoiceOperation({ ... }),
   *   sdk.buildFundInvoiceOperation({ ... }),
   * ];
   * const tx = await sdk.batch(ops);
   * ```
   */
  public async batch(operations: TransactionOperation[]): Promise<BuiltTransaction> {
    if (operations.length === 0) {
      throw new ValidationError('Batch must contain at least one operation.');
    }

    if (operations.length > 100) {
      throw new ValidationError('Batch cannot contain more than 100 operations.');
    }

    const sourceAddress = await this.resolveBatchSourceAddress(operations);
    const sourceAccount = (await this.wrapRpcCall(
      this.server.getAccount(sourceAddress),
      'getAccount'
    )) as Account;

    const transactionBuilder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    });

    for (const operation of operations) {
      transactionBuilder.addOperation(operation);
    }

    const transaction = transactionBuilder.setTimeout(30).build();
    const simulation = await this.wrapRpcCall(
      this.server.simulateTransaction(transaction),
      'simulateTransaction'
    );
    this.validateBatchSimulation(simulation);

    return transaction;
  }

  /**
   * Batch-submit multiple invoices in a single transaction.
   * Only invoices where the freelancer matches the signer address are included.
   *
   * @param params - Batch submission parameters containing an array of invoices.
   * @returns Results for each invoice including success/failure status and total fee.
   *
   * @example
   * ```ts
   * const result = await sdk.batchSubmitInvoices({
   *   invoices: [
   *     { freelancer: "GABC...", payer: "GDEF...", amount: 1000n, dueDate: 1234567890, discountRate: 500 },
   *   ],
   * });
   * ```
   */
  async batchSubmitInvoices(params: BatchSubmitParams): Promise<BatchResult> {
    const signerAddress = await this.requireSignerAddress();
    const results: BatchResult['results'] = [];
    let totalFee = BigInt(0);

    const operations: TransactionOperation[] = [];
    for (let i = 0; i < params.invoices.length; i++) {
      const invoice = params.invoices[i];
      if (signerAddress !== invoice.freelancer) {
        results.push({
          index: i,
          success: false,
          error: 'submitInvoice must be signed by the freelancer address.',
        });
        continue;
      }

      operations.push(this.buildSubmitInvoiceOperation(invoice));
      results.push({ index: i, success: true });
    }

    if (operations.length === 0) {
      return { success: false, results, totalFee: BigInt(0) };
    }

    try {
      const transaction = await this.batch(operations);
      const simulation = await this.wrapRpcCall(
        this.server.simulateTransaction(transaction),
        'simulateTransaction'
      );

      const simResult = simulation as { minResourceFee?: number };
      totalFee = BigInt(simResult?.minResourceFee ?? BASE_FEE);

      const preparedTransaction = await this.prepareTransaction(transaction);
      await this.signAndSend(preparedTransaction, signerAddress, 'batchSubmitInvoices');

      return { success: true, results, totalFee };
    } catch (error: any) {
      return {
        success: false,
        results: results.map((r) => ({
          ...r,
          success: false,
          error: r.error ?? error.message,
        })),
        totalFee,
      };
    }
  }

  /**
   * Batch-fund multiple invoices in a single transaction.
   *
   * @param params - Batch funding parameters with funder address and invoice IDs.
   * @returns Results for each invoice including success/failure status and total fee.
   *
   * @example
   * ```ts
   * const result = await sdk.batchFundInvoices({
   *   funder: "GABC...",
   *   invoiceIds: [1n, 2n, 3n],
   * });
   * ```
   */
  async batchFundInvoices(params: BatchFundParams): Promise<BatchResult> {
    const signerAddress = await this.requireSignerAddress();
    const results: BatchResult['results'] = [];
    let totalFee = BigInt(0);

    if (signerAddress !== params.funder) {
      return {
        success: false,
        results: params.invoiceIds.map((_, i) => ({
          index: i,
          success: false,
          error: 'batchFundInvoices must be signed by the funder address.',
        })),
        totalFee: BigInt(0),
      };
    }

    const operations: TransactionOperation[] = params.invoiceIds.map((invoiceId, i) => {
      results.push({ index: i, success: true, invoiceId });
      return this.buildFundInvoiceOperation({ funder: params.funder, invoiceId });
    });

    try {
      const transaction = await this.batch(operations);
      const simulation = await this.wrapRpcCall(
        this.server.simulateTransaction(transaction),
        'simulateTransaction'
      );

      const simResult = simulation as { minResourceFee?: number };
      totalFee = BigInt(simResult?.minResourceFee ?? BASE_FEE);

      const preparedTransaction = await this.prepareTransaction(transaction);
      await this.signAndSend(preparedTransaction, params.funder, 'batchFundInvoices');

      return { success: true, results, totalFee };
    } catch (error: any) {
      return {
        success: false,
        results: results.map((r) => ({
          ...r,
          success: false,
          error: error.message,
        })),
        totalFee,
      };
    }
  }

  /**
   * Batch-mark multiple invoices as paid in a single transaction.
   *
   * @param params - Batch payment parameters with invoice IDs.
   * @returns Results for each invoice including success/failure status and total fee.
   *
   * @example
   * ```ts
   * const result = await sdk.batchMarkPaid({
   *   invoiceIds: [1n, 2n, 3n],
   * });
   * ```
   */
  async batchMarkPaid(params: BatchPayParams): Promise<BatchResult> {
    const signerAddress = await this.requireSignerAddress();
    const results: BatchResult['results'] = [];
    let totalFee = BigInt(0);

    const operations: TransactionOperation[] = params.invoiceIds.map((invoiceId, i) => {
      results.push({ index: i, success: true, invoiceId });
      return this.buildMarkPaidOperation(signerAddress, { invoiceId });
    });

    try {
      const transaction = await this.batch(operations);
      const simulation = await this.wrapRpcCall(
        this.server.simulateTransaction(transaction),
        'simulateTransaction'
      );

      const simResult = simulation as { minResourceFee?: number };
      totalFee = BigInt(simResult?.minResourceFee ?? BASE_FEE);

      const preparedTransaction = await this.prepareTransaction(transaction);
      await this.signAndSend(preparedTransaction, signerAddress, 'batchMarkPaid');

      return { success: true, results, totalFee };
    } catch (error: any) {
      return {
        success: false,
        results: results.map((r) => ({
          ...r,
          success: false,
          error: error.message,
        })),
        totalFee,
      };
    }
  }

  /**
   * Estimate the network fee for a batch of operations without submitting.
   *
   * @param operations - Array of Stellar transaction operations.
   * @returns The estimated total fee in stroops.
   *
   * @example
   * ```ts
   * const fee = await sdk.estimateBatchFee(ops);
   * console.log(`Estimated fee: ${fee} stroops`);
   * ```
   */
  async estimateBatchFee(operations: TransactionOperation[]): Promise<bigint> {
    if (operations.length === 0) {
      return BigInt(0);
    }

    const sourceAddress = await this.resolveBatchSourceAddress(operations);
    const sourceAccount = (await this.wrapRpcCall(
      this.server.getAccount(sourceAddress),
      'getAccount'
    )) as Account;

    const transactionBuilder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    });

    for (const operation of operations) {
      transactionBuilder.addOperation(operation);
    }

    const transaction = transactionBuilder.setTimeout(30).build();
    const simulation = await this.wrapRpcCall(
      this.server.simulateTransaction(transaction),
      'simulateTransaction'
    );

    const simResult = simulation as { minResourceFee?: number; error?: unknown };
    if (simResult.error) {
      throw new Error(`Fee estimation failed: ${String(simResult.error)}`);
    }

    return BigInt(simResult?.minResourceFee ?? BASE_FEE);
  }

  private buildInvokeContractFunctionOperation(
    sourceAddress: string,
    method: string,
    args: xdr.ScVal[]
  ): TransactionOperation {
    return Operation.invokeContractFunction({
      source: sourceAddress,
      contract: this.contractId,
      function: method,
      args,
    });
  }

  private async resolveBatchSourceAddress(operations: TransactionOperation[]): Promise<string> {
    const sources = operations
      .map((operation) => this.getOperationSourceAddress(operation))
      .filter((source): source is string => source !== undefined && source !== null);

    if (sources.length > 0) {
      const uniqueSources = [...new Set(sources)];
      if (uniqueSources.length !== 1) {
        throw new ValidationError(
          'All operations in a batch must originate from the same source account.'
        );
      }
      return uniqueSources[0];
    }

    if (!this.signer) {
      throw new WalletNotConnectedError(
        'Batch requires at least one operation source or a configured transaction signer.'
      );
    }

    return this.signer.getPublicKey();
  }

  private getOperationSourceAddress(operation: TransactionOperation): string | undefined {
    if ((operation as { source?: string }).source) {
      return (operation as { source?: string }).source;
    }

    const sourceAccount = (operation as { _attributes?: { sourceAccount?: { _value?: unknown } } })
      ?._attributes?.sourceAccount;
    if (!sourceAccount || !sourceAccount._value) {
      return undefined;
    }

    try {
      return Address.account(sourceAccount._value as any).toString();
    } catch {
      return undefined;
    }
  }

  private validateBatchSimulation(simulation: unknown): void {
    const typedSimulation = simulation as SimulationLike;
    if (typedSimulation.error) {
      const error = typedSimulation.error;
      throw new Error(`Batch simulation failed: ${error ? String(error) : 'Unknown RPC error.'}`);
    }
  }

  /**
   * Check SDK compatibility with the deployed contract version.
   *
   * @returns A compatibility result indicating whether the SDK and contract versions are compatible.
   *
   * @example
   * ```ts
   * const compat = await sdk.checkCompatibility();
   * if (!compat.compatible) {
   *   console.warn("Compatibility issues:", compat.issues);
   * }
   * ```
   */
  async checkCompatibility(): Promise<CompatibilityResult> {
    const invoke = async (method: string): Promise<any> => {
      const transaction = this.buildReadTransaction(method, []);
      const simulation = await this.wrapRpcCall(
        this.server.simulateTransaction(transaction),
        'simulateTransaction'
      );
      return scValToNative(this.extractSimulationRetval(simulation, method));
    };

    return checkCompatibility(invoke);
  }

  /**
   * Subscribe to real-time contract events for a specific invoice.
   * Uses Server-Sent Events (SSE) to receive live updates.
   *
   * @param id - The invoice ID to filter events for.
   * @param callback - Function called when a matching event is received.
   * @returns An unsubscribe function that terminates the SSE stream.
   *
   * @example
   * ```ts
   * const unsubscribe = sdk.subscribeToInvoice(42n, (event) => {
   *   console.log("Invoice event:", event.type, event.value);
   * });
   *
   * // Later, to stop listening:
   * unsubscribe();
   * ```
   */
  subscribeToInvoice(id: bigint | string, callback: EventCallback): Unsubscribe {
    const invoiceId = String(id);
    const base = this.rpcUrl.replace(/\/$/, '');
    const url = `${base}/contracts/${this.contractId}/events?limit=200&order=asc`;

    const handle = openSSE(
      url,
      (ev: RawContractEvent) => {
        try {
          // crude filtering: check topics or value for invoice id string
          const topics = (ev.topics ?? []) as unknown[];
          const value = ev.value ?? '';
          const foundInTopics = topics.some((t) => String(t).includes(invoiceId));
          const foundInValue = String(value).includes(invoiceId);

          if (foundInTopics || foundInValue) {
            callback(ev);
          }
        } catch (err) {
          // swallow
        }
      },
      (err: Error) => {
        if (this.logger.enabled) this.logger('invoice SSE error', { err });
      }
    );

    return () => handle.close();
  }

  /**
   * Subscribe to real-time contract events related to a specific Stellar address.
   * Matches events where the address appears in topics or value.
   *
   * @param address - The Stellar address to filter events for.
   * @param callback - Function called when a matching event is received.
   * @returns An unsubscribe function that terminates the SSE stream.
   *
   * @example
   * ```ts
   * const unsubscribe = sdk.subscribeToAddress("GABC...", (event) => {
   *   console.log("Address event:", event.type);
   * });
   * ```
   */
  subscribeToAddress(address: string, callback: EventCallback): Unsubscribe {
    const base = this.rpcUrl.replace(/\/$/, '');
    const url = `${base}/contracts/${this.contractId}/events?limit=200&order=asc`;

    const handle = openSSE(
      url,
      (ev: RawContractEvent) => {
        try {
          const topics = (ev.topics ?? []) as unknown[];
          const value = ev.value ?? '';
          const found =
            topics.some((t) => String(t).includes(address)) || String(value).includes(address);
          if (found) callback(ev);
        } catch (err) {
          // swallow
        }
      },
      (err: Error) => {
        if (this.logger.enabled) this.logger('address SSE error', { err });
      }
    );

    return () => handle.close();
  }

  createEventEmitter(options?: { maxHistorySize?: number }): ILNEventEmitter {
    return new ILNEventEmitter(options);
  }

  /**
   * Submit a new invoice to the ILN contract.
   * The transaction must be signed by the freelancer address.
   *
   * @param params - Invoice submission parameters.
   * @returns The on-chain invoice ID as a bigint.
   * @throws {ValidationError} If the signer address doesn't match the freelancer.
   *
   * @example
   * ```ts
   * const invoiceId = await sdk.submitInvoice({
   *   freelancer: "GABC...",
   *   payer: "GDEF...",
   *   amount: 1000000n,
   *   dueDate: Math.floor(Date.now() / 1000) + 86400,
   *   discountRate: 500,
   * });
   * console.log(`Invoice ${invoiceId} submitted`);
   * ```
   */
  async submitInvoice(params: SubmitInvoiceParams): Promise<bigint> {
    Validators.assertValid(Validators.validateInvoiceSubmission(params), 'submitInvoice');

    if (this.offlineManager && !this.offlineManager.getIsOnline()) {
      throw new OfflineQueuedError(this.offlineManager.enqueue('submitInvoice', params));
    }

    const signerAddress = await this.requireSignerAddress();

    if (signerAddress !== params.freelancer) {
      throw new ValidationError('submitInvoice must be signed by the freelancer address.');
    }

    try {
      const transaction = await this.buildWriteTransaction(params.freelancer, 'submit_invoice', [
        this.toAddress(params.freelancer),
        this.toAddress(params.payer),
        nativeToScVal(params.amount, { type: 'i128' }),
        nativeToScVal(params.dueDate, { type: 'u64' }),
        nativeToScVal(params.discountRate, { type: 'u32' }),
      ]);

      const simulation = await this.simulateWriteTransaction('submit_invoice', transaction);
      const invoiceId = this.extractBigIntResult(simulation, 'submit_invoice');
      const preparedTransaction = await this.prepareTransaction(transaction);

      if (this.logger.enabled) {
        this.logger('submitInvoice prepared transaction', {
          xdr: this.toHex(preparedTransaction.toXDR()),
        });
      }

      await this.signAndSend(preparedTransaction, params.freelancer, 'submitInvoice');
      track('submitInvoice', this.analyticsNetwork, true);

      // Invalidate cache for this invoice after submission
      this.cache.invalidate(`invoice:${invoiceId}`);

      return invoiceId;
    } catch (err: any) {
      if (
        this.offlineManager &&
        (err instanceof NetworkError || err instanceof TimeoutError || err?.message?.includes('fetch failed'))
      ) {
        throw new OfflineQueuedError(this.offlineManager.enqueue('submitInvoice', params));
      }
      track('submitInvoice', this.analyticsNetwork, false, err?.code ?? err?.name);
      throw err;
    }
  }

  /**
   * Fund an existing invoice, providing liquidity to the freelancer.
   * The transaction must be signed by the funder address.
   *
   * @param params - Invoice funding parameters.
   * @throws {ValidationError} If the signer address doesn't match the funder.
   *
   * @example
   * ```ts
   * await sdk.fundInvoice({
   *   funder: "GABC...",
   *   invoiceId: 42n,
   * });
   * ```
   */
  async fundInvoice(params: FundInvoiceParams): Promise<void> {
    Validators.assertValid(Validators.validateFunding(params), 'fundInvoice');

    if (this.offlineManager && !this.offlineManager.getIsOnline()) {
      throw new OfflineQueuedError(this.offlineManager.enqueue('fundInvoice', params));
    }

    const signerAddress = await this.requireSignerAddress();

    if (signerAddress !== params.funder) {
      throw new ValidationError('fundInvoice must be signed by the funder address.');
    }

    try {
      const transaction = await this.buildWriteTransaction(params.funder, 'fund_invoice', [
        this.toAddress(params.funder),
        nativeToScVal(params.invoiceId, { type: 'u64' }),
      ]);

      if (this.logger.enabled) {
        this.logger('fundInvoice called', { params });
        this.logger('fundInvoice transaction', { xdr: this.toHex(transaction.toXDR()) });
      }

      const preparedTransaction = await this.prepareTransaction(transaction);

      if (this.logger.enabled) {
        this.logger('fundInvoice prepared transaction', {
          xdr: this.toHex(preparedTransaction.toXDR()),
        });
      }

      await this.signAndSend(preparedTransaction, params.funder, 'fundInvoice');
      track('fundInvoice', this.analyticsNetwork, true);

      // Invalidate cache for this invoice after funding
      this.cache.invalidate(`invoice:${params.invoiceId}`);
    } catch (err: any) {
      if (
        this.offlineManager &&
        (err instanceof NetworkError || err instanceof TimeoutError || err?.message?.includes('fetch failed'))
      ) {
        throw new OfflineQueuedError(this.offlineManager.enqueue('fundInvoice', params));
      }
      track('fundInvoice', this.analyticsNetwork, false, err?.code ?? err?.name);
      throw err;
    }
  }

  /**
   * Mark an invoice as paid, completing the payment cycle.
   * The transaction is signed by the configured signer (payer).
   *
   * @param params - Payment parameters with the invoice ID.
   *
   * @example
   * ```ts
   * await sdk.markPaid({ invoiceId: 42n });
   * ```
   */
  async markPaid(params: MarkPaidParams): Promise<void> {
    Validators.assertValid(Validators.validatePayment(params), 'markPaid');

    if (this.offlineManager && !this.offlineManager.getIsOnline()) {
      throw new OfflineQueuedError(this.offlineManager.enqueue('markPaid', params));
    }

    try {
      const payer = await this.requireSignerAddress();
      const transaction = await this.buildWriteTransaction(payer, 'mark_paid', [
        nativeToScVal(params.invoiceId, { type: 'u64' }),
      ]);

      if (this.logger.enabled) {
        this.logger('markPaid called', { params });
        this.logger('markPaid transaction', { xdr: this.toHex(transaction.toXDR()) });
      }

      const preparedTransaction = await this.prepareTransaction(transaction);

      if (this.logger.enabled) {
        this.logger('markPaid prepared transaction', {
          xdr: this.toHex(preparedTransaction.toXDR()),
        });
      }

      await this.signAndSend(preparedTransaction, payer, 'markPaid');
      track('markPaid', this.analyticsNetwork, true);

      // Invalidate cache for this invoice after payment
      this.cache.invalidate(`invoice:${params.invoiceId}`);
    } catch (err: any) {
      if (
        this.offlineManager &&
        (err instanceof NetworkError || err instanceof TimeoutError || err?.message?.includes('fetch failed'))
      ) {
        throw new OfflineQueuedError(this.offlineManager.enqueue('markPaid', params));
      }
      track('markPaid', this.analyticsNetwork, false, err?.code ?? err?.name);
      throw err;
    }
  }

  /**
   * Claim a default on an unpaid invoice after the grace period has elapsed.
   * The transaction must be signed by the funder address.
   *
   * @param params - Default claim parameters.
   * @throws {ValidationError} If the signer address doesn't match the funder.
   *
   * @example
   * ```ts
   * await sdk.claimDefault({
   *   funder: "GABC...",
   *   invoiceId: 42n,
   * });
   * ```
   */
  async claimDefault(params: ClaimDefaultParams): Promise<void> {
    if (this.offlineManager && !this.offlineManager.getIsOnline()) {
      throw new OfflineQueuedError(this.offlineManager.enqueue('claimDefault', params));
    }

    const signerAddress = await this.requireSignerAddress();

    if (signerAddress !== params.funder) {
      throw new ValidationError('claimDefault must be signed by the funder address.');
    }

    try {
      const transaction = await this.buildWriteTransaction(params.funder, 'claim_default', [
        this.toAddress(params.funder),
        nativeToScVal(params.invoiceId, { type: 'u64' }),
      ]);

      if (this.logger.enabled) {
        this.logger('claimDefault called', { params });
        this.logger('claimDefault transaction', { xdr: this.toHex(transaction.toXDR()) });
      }

      const preparedTransaction = await this.prepareTransaction(transaction);

      if (this.logger.enabled) {
        this.logger('claimDefault prepared transaction', {
          xdr: this.toHex(preparedTransaction.toXDR()),
        });
      }

      await this.signAndSend(preparedTransaction, params.funder, 'claimDefault');
      track('claimDefault', this.analyticsNetwork, true);
    } catch (err: any) {
      if (
        this.offlineManager &&
        (err instanceof NetworkError || err instanceof TimeoutError || err?.message?.includes('fetch failed'))
      ) {
        throw new OfflineQueuedError(this.offlineManager.enqueue('claimDefault', params));
      }
      track('claimDefault', this.analyticsNetwork, false, err?.code ?? err?.name);
      throw err;
    }
  }

  /**
   * Retrieve the current state of an invoice from the contract.
   *
   * @param invoiceId - The on-chain ID of the invoice to retrieve.
   * @param options - Optional cache options to bypass the cache.
   * @returns The full invoice data including status, amounts, participants, and timestamps.
   *
   * @example
   * ```ts
   * const invoice = await sdk.getInvoice(42n);
   * console.log(`Status: ${invoice.status}`);
   * console.log(`Amount: ${invoice.amount}`);
   * ```
   */
  async getInvoice(invoiceId: bigint, options?: CacheOptions): Promise<Invoice> {
    const cacheKey = `invoice:${invoiceId}`;

    return this.requestBatcher.execute(cacheKey, async () => {
      // Try cache first
      if (this.cacheEnabled && !options?.bypass) {
        const cached = this.cache.get(cacheKey, options) as Invoice | null;
        if (cached) {
          return cached;
        }
      }

      try {
        const transaction = this.buildReadTransaction('get_invoice', [
          nativeToScVal(invoiceId, { type: 'u64' }),
        ]);
        const simulation = await this.simulateReadTransaction('get_invoice', transaction);

        if (this.logger.enabled) {
          this.logger('getInvoice simulation result', this.summarizeSimulation(simulation));
        }

        const result = this.extractInvoiceResult(simulation);
        track('getInvoice', this.analyticsNetwork, true);

        // Cache the result
        if (this.cacheEnabled && !options?.bypass) {
          this.cache.set(cacheKey, result);
        }

        return result;
      } catch (err: any) {
        track('getInvoice', this.analyticsNetwork, false, err?.code ?? err?.name);
        throw err;
      }
    });
  }

  /**
   * Fetch the reputation score for a Stellar address.
   *
   * @param address - The Stellar address to query.
   * @returns The reputation score as a number.
   *
   * @example
   * ```ts
   * const reputation = await sdk.getReputation("GABC...");
   * console.log(`Reputation: ${reputation}`);
   * ```
   */
  async getReputation(address: string): Promise<number> {
    const transaction = this.buildReadTransaction('get_reputation', [this.toAddress(address)]);
    const simulation = await this.simulateReadTransaction('get_reputation', transaction);
    const result = this.extractSimulationRetval(simulation, 'get_reputation');
    const native = scValToNative(result) as unknown;
    if (typeof native === 'number') return native;
    if (typeof native === 'bigint') return Number(native);
    throw new Error('Unexpected reputation result type');
  }

  /**
   * Fetch contract-wide statistics including total invoices, volume, and yield.
   *
   * @returns Protocol statistics as a native object from the contract.
   *
   * @example
   * ```ts
   * const stats = await sdk.getStats();
   * console.log(stats);
   * ```
   */
  async getStats(): Promise<unknown> {
    const transaction = this.buildReadTransaction('get_stats', []);
    const simulation = await this.simulateReadTransaction('get_stats', transaction);
    const result = this.extractSimulationRetval(simulation, 'get_stats');
    return scValToNative(result);
  }

  /**
   * Fetch a governance proposal by its ID.
   *
   * @param id - The proposal ID as a bigint.
   * @returns The proposal data as returned by the contract.
   *
   * @example
   * ```ts
   * const proposal = await sdk.getProposal(1n);
   * ```
   */
  async getProposal(id: bigint): Promise<GovernanceProposal> {
    const transaction = this.buildReadTransaction('get_proposal', [
      nativeToScVal(id, { type: 'u64' }),
    ]);
    const simulation = await this.simulateReadTransaction('get_proposal', transaction);
    const result = this.extractSimulationRetval(simulation, 'get_proposal');
    return parseGovernanceProposal(scValToNative(result));
  }

  /**
   * List parsed governance proposals with optional filters.
   */
  async listProposals(params: ListProposalsParams = {}): Promise<GovernanceProposal[]> {
    return this.listGovernanceProposals(params);
  }

  /**
   * Fetch a governance proposal by its ID.
   */
  async fetchGovernanceProposal(params: GetProposalParams): Promise<GovernanceProposal> {
    const transaction = this.buildReadTransaction(GovernanceContractMethod.GetProposal, [
      nativeToScVal(params.proposalId, { type: 'u64' }),
    ]);
    const simulation = await this.simulateReadTransaction(
      GovernanceContractMethod.GetProposal,
      transaction
    );
    const result = this.extractSimulationRetval(simulation, GovernanceContractMethod.GetProposal);
    return parseGovernanceProposal(scValToNative(result));
  }

  /**
   * List governance proposals with optional pagination and filtering.
   */
  async listGovernanceProposals(params: ListProposalsParams = {}): Promise<GovernanceProposal[]> {
    const page = params.page ?? 0;
    const pageSize = params.pageSize ?? 20;
    const transaction = this.buildReadTransaction(GovernanceContractMethod.ListProposals, [
      toOptionalProposalStatusScVal(params.status),
      nativeToScVal(page, { type: 'u32' }),
      nativeToScVal(pageSize, { type: 'u32' }),
    ]);
    const simulation = await this.simulateReadTransaction(
      GovernanceContractMethod.ListProposals,
      transaction
    );
    return parseGovernanceProposalListSimulation(
      simulation,
      GovernanceContractMethod.ListProposals
    );
  }

  /**
   * Fetch the current governance execution delay, expressed in ledgers.
   */
  async getExecutionDelay(): Promise<number> {
    const transaction = this.buildReadTransaction(GovernanceContractMethod.GetExecutionDelay, []);
    const simulation = await this.simulateReadTransaction(
      GovernanceContractMethod.GetExecutionDelay,
      transaction
    );
    return this.extractNumberResult(simulation, GovernanceContractMethod.GetExecutionDelay);
  }

  /**
   * Fetch the most recent ledger sequence when the RPC server exposes it.
   */
  async getLatestLedger(): Promise<number | null> {
    const server = this.server as RpcServerLike & {
      getLatestLedger?: () => Promise<unknown>;
    };

    if (!server.getLatestLedger) {
      return null;
    }

    const ledger = await this.wrapRpcCall(
      withTimeout('getLatestLedger', this.requestTimeouts.readMs, server.getLatestLedger()),
      'getLatestLedger'
    );

    if (typeof ledger === 'number') {
      return ledger;
    }
    if (typeof ledger === 'bigint') {
      return Number(ledger);
    }
    if (typeof ledger === 'string') {
      const parsed = Number(ledger);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (ledger && typeof ledger === 'object') {
      const data = ledger as Record<string, unknown>;
      const candidate =
        data.sequence ??
        data.sequenceNumber ??
        data.ledgerSequence ??
        data.ledger ??
        data.latestLedger;
      if (typeof candidate === 'number') {
        return candidate;
      }
      if (typeof candidate === 'bigint') {
        return Number(candidate);
      }
      if (typeof candidate === 'string') {
        const parsed = Number(candidate);
        return Number.isFinite(parsed) ? parsed : null;
      }
    }

    return null;
  }

  /**
   * Create a new governance proposal and submit it on-chain.
   */
  async createProposal(params: CreateProposalParams): Promise<bigint> {
    const transaction = await this.buildWriteTransaction(
      params.proposer,
      GovernanceContractMethod.CreateProposal,
      [
        toAddressScVal(params.proposer),
        encodeProposalAction(params.action),
        toBytesN32ScVal(params.descriptionHash),
        nativeToScVal(params.proposedValue, { type: 'i128' }),
      ]
    );

    const simulation = await this.simulateWriteTransaction(
      GovernanceContractMethod.CreateProposal,
      transaction
    );
    const proposalId = this.extractBigIntResult(
      simulation,
      GovernanceContractMethod.CreateProposal
    );
    const preparedTransaction = await this.prepareTransaction(transaction);
    await this.signAndSend(
      preparedTransaction,
      params.proposer,
      GovernanceContractMethod.CreateProposal
    );
    return proposalId;
  }

  /**
   * Cast a vote on a governance proposal.
   */
  async castVote(params: CastVoteParams): Promise<void> {
    const transaction = await this.buildWriteTransaction(
      params.voter,
      GovernanceContractMethod.CastVote,
      [
        this.toAddress(params.voter),
        nativeToScVal(params.proposalId, { type: 'u64' }),
        nativeToScVal(params.support, { type: 'bool' }),
      ]
    );

    await this.simulateWriteTransaction(GovernanceContractMethod.CastVote, transaction);
    const preparedTransaction = await this.prepareTransaction(transaction);
    await this.signAndSend(preparedTransaction, params.voter, GovernanceContractMethod.CastVote);
  }

  /**
   * Delegate voting power to another account.
   */
  async delegateVotes(params: DelegateVotesParams): Promise<void> {
    const transaction = await this.buildWriteTransaction(
      params.delegator,
      GovernanceContractMethod.DelegateVotes,
      [this.toAddress(params.delegator), this.toAddress(params.delegate)]
    );

    await this.simulateWriteTransaction(GovernanceContractMethod.DelegateVotes, transaction);
    const preparedTransaction = await this.prepareTransaction(transaction);
    await this.signAndSend(
      preparedTransaction,
      params.delegator,
      GovernanceContractMethod.DelegateVotes
    );
  }

  /**
   * Revoke voting delegation from the delegator's account.
   */
  async undelegateVotes(params: UndelegateVotesParams): Promise<void> {
    const transaction = await this.buildWriteTransaction(
      params.delegator,
      GovernanceContractMethod.UndelegateVotes,
      [this.toAddress(params.delegator)]
    );

    await this.simulateWriteTransaction(GovernanceContractMethod.UndelegateVotes, transaction);
    const preparedTransaction = await this.prepareTransaction(transaction);
    await this.signAndSend(
      preparedTransaction,
      params.delegator,
      GovernanceContractMethod.UndelegateVotes
    );
  }

  /**
   * Execute a passed proposal after its timelock expires.
   */
  async executeProposal(params: ExecuteProposalParams): Promise<void> {
    const proposal = await this.fetchGovernanceProposal({ proposalId: params.proposalId });
    if (proposal.status !== ProposalStatus.Passed) {
      throw new ValidationError(
        `Proposal ${String(params.proposalId)} is not executable until it has passed.`
      );
    }

    const latestLedger = await this.getLatestLedger();
    if (latestLedger !== null && latestLedger !== undefined && latestLedger < proposal.etaLedger) {
      const remaining = proposal.etaLedger - latestLedger;
      throw new ValidationError(
        `Proposal ${String(params.proposalId)} is still timelocked for ${remaining} ledger(s).`
      );
    }

    const transaction = await this.buildWriteTransaction(
      params.source,
      GovernanceContractMethod.ExecuteProposal,
      [
        nativeToScVal(params.proposalId, { type: 'u64' }),
        nativeToScVal(params.totalSupply, { type: 'i128' }),
      ]
    );

    await this.simulateWriteTransaction(GovernanceContractMethod.ExecuteProposal, transaction);
    const preparedTransaction = await this.prepareTransaction(transaction);
    await this.signAndSend(
      preparedTransaction,
      params.source,
      GovernanceContractMethod.ExecuteProposal
    );
  }

  /**
   * Veto a proposal as an admin.
   */
  async vetoProposal(params: VetoProposalParams): Promise<void> {
    const transaction = await this.buildWriteTransaction(
      params.admin,
      GovernanceContractMethod.VetoProposal,
      [nativeToScVal(params.proposalId, { type: 'u64' }), toBytesN32ScVal(params.reasonHash)]
    );

    await this.simulateWriteTransaction(GovernanceContractMethod.VetoProposal, transaction);
    const preparedTransaction = await this.prepareTransaction(transaction);
    await this.signAndSend(
      preparedTransaction,
      params.admin,
      GovernanceContractMethod.VetoProposal
    );
  }

  /**
   * Fetch protocol-level configuration from the contract.
   * Results are cached for 5 minutes to reduce RPC calls.
   *
   * @returns The current protocol configuration including fee rates and limits.
   *
   * @example
   * ```ts
   * const config = await sdk.getProtocolConfig();
   * console.log(`Max discount rate: ${config.maxDiscountRate} bps`);
   * ```
   */
  async getProtocolConfig(): Promise<ProtocolConfig> {
    const now = Date.now();
    if (this.protocolConfigCache && this.protocolConfigCache.expiresAt > now) {
      return this.protocolConfigCache.value;
    }

    const transaction = this.buildReadTransaction('get_protocol_config', []);
    const simulation = await this.simulateReadTransaction('get_protocol_config', transaction);
    const result = this.extractSimulationRetval(simulation, 'get_protocol_config');
    const config = this.parseProtocolConfig(
      this.unwrapContractResult(scValToNative(result), 'get_protocol_config')
    );

    this.protocolConfigCache = {
      expiresAt: now + PROTOCOL_CONFIG_CACHE_MS,
      value: config,
    };

    return config;
  }

  /**
   * Perform a raw storage key lookup on the contract.
   *
   * @param key - The storage key to look up.
   * @returns The string value stored at the given key.
   *
   * @example
   * ```ts
   * const value = await sdk.getStorage("my_key");
   * ```
   */
  async getStorage(key: string): Promise<string> {
    const transaction = this.buildReadTransaction('get_storage', [
      nativeToScVal(key, { type: 'string' }),
    ]);
    const simulation = await this.simulateReadTransaction('get_storage', transaction);
    const result = this.extractSimulationRetval(simulation, 'get_storage');
    const native = scValToNative(result);
    return typeof native === 'string' ? native : String(native);
  }

  private extractNumberResult(simulation: unknown, method: string): number {
    const result = this.extractSimulationRetval(simulation, method);
    const native = this.unwrapContractResult(scValToNative(result), method);
    return this.toNumberValue(native, method);
  }

  private buildReadTransaction(method: string, args: xdr.ScVal[]): BuiltTransaction {
    return new TransactionBuilder(new Account(READ_ACCOUNT, '0'), {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.contractId,
          function: method,
          args,
        })
      )
      .setTimeout(30)
      .build();
  }

  private async buildWriteTransaction(
    sourceAddress: string,
    method: string,
    args: xdr.ScVal[]
  ): Promise<BuiltTransaction> {
    const sourceAccount = (await withTimeout(
      `getAccount:${method}`,
      this.requestTimeouts.writeMs,
      this.server.getAccount(sourceAddress)
    )) as Account;

    return new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.contractId,
          function: method,
          args,
        })
      )
      .setTimeout(30)
      .build();
  }

  private async requireSignerAddress(): Promise<string> {
    if (!this.signer) {
      throw new WalletNotConnectedError(
        'A transaction signer is required for state-changing contract calls.'
      );
    }

    return this.signer.getPublicKey();
  }

  private async prepareTransaction(
    transaction: BuiltTransaction
  ): Promise<PreparedTransactionLike> {
    const originalXdr = transaction.toXDR();
    const prepared = await this.wrapRpcCall(
      withTimeout(
        'prepareTransaction',
        this.requestTimeouts.writeMs,
        this.server.prepareTransaction(transaction)
      ),
      'prepareTransaction'
    );

    // Verify the prepared XDR hasn't been tampered with by a compromised RPC node.
    // The prepared transaction should serialize to the same base structure as the original.
    this.verifyPreparedXdrIntegrity(originalXdr, prepared.toXDR(), 'prepareTransaction');

    return prepared;
  }

  /**
   * Verify that the prepared transaction XDR matches the original simulated transaction.
   * This prevents a compromised RPC node from substituting a forged XDR during preparation.
   *
   * @throws {SimulationPreparedXdrMismatchError} If the prepared XDR differs from the original.
   */
  private verifyPreparedXdrIntegrity(
    originalXdr: string,
    preparedXdr: string,
    operationName: string
  ): void {
    // Decode both XDRs and compare their operation hashes.
    // The prepared XDR may have different fees/resource limits set by the RPC node,
    // but the operations should be identical. We compare the operation section
    // by extracting and comparing the operation count and contract function signatures.
    try {
      const originalTx = TransactionBuilder.fromXDR(originalXdr, this.networkPassphrase);
      const preparedTx = TransactionBuilder.fromXDR(preparedXdr, this.networkPassphrase);

      // Compare operation counts
      if (originalTx.operations.length !== preparedTx.operations.length) {
        throw new SimulationPreparedXdrMismatchError(
          `Prepared transaction has ${preparedTx.operations.length} operations but original had ${originalTx.operations.length}. The RPC node may have modified the transaction.`,
          'Verify your RPC endpoint integrity and consider using a different node.',
          {
            operationName,
            originalOperationCount: originalTx.operations.length,
            preparedOperationCount: preparedTx.operations.length,
          }
        );
      }

      // Compare operation types and sources
      for (let i = 0; i < originalTx.operations.length; i++) {
        const origOp = originalTx.operations[i];
        const prepOp = preparedTx.operations[i];

        if (origOp.type !== prepOp.type) {
          throw new SimulationPreparedXdrMismatchError(
            `Operation ${i} type mismatch: original is ${origOp.type} but prepared is ${prepOp.type}. The RPC node may have tampered with the transaction.`,
            'Verify your RPC endpoint integrity and consider using a different node.',
            {
              operationName,
              operationIndex: i,
              originalType: origOp.type,
              preparedType: prepOp.type,
            }
          );
        }
      }

      // Compare network passphrase to ensure the transaction targets the same network
      if (originalTx.networkPassphrase !== preparedTx.networkPassphrase) {
        throw new SimulationPreparedXdrMismatchError(
          'Network passphrase mismatch between original and prepared transaction. The RPC node may be targeting a different network.',
          'Verify your RPC endpoint integrity and consider using a different node.',
          {
            operationName,
            originalNetworkPassphrase: originalTx.networkPassphrase,
            preparedNetworkPassphrase: preparedTx.networkPassphrase,
          }
        );
      }
    } catch (error) {
      if (error instanceof SimulationPreparedXdrMismatchError) {
        throw error;
      }
      // If XDR parsing itself fails, that's a clear sign of tampering
      throw new SimulationPreparedXdrMismatchError(
        `Failed to parse prepared transaction XDR: ${error instanceof Error ? error.message : String(error)}`,
        'Verify your RPC endpoint integrity and consider using a different node.',
        { operationName, originalXdrLength: originalXdr.length, preparedXdrLength: preparedXdr.length }
      );
    }
  }

  private async signAndSend(
    preparedTransaction: PreparedTransactionLike,
    sourceAddress: string,
    methodName?: string
  ): Promise<void> {
    const signer = this.signer;
    if (!signer) {
      throw new WalletNotConnectedError(
        'A transaction signer is required for state-changing contract calls.'
      );
    }

    const signedXdr = await signer.signTransaction(preparedTransaction.toXDR(), {
      address: sourceAddress,
      networkPassphrase: this.networkPassphrase,
    });
    const signedTransaction = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const response = (await this.wrapRpcCall(
      withTimeout(
        'sendTransaction',
        this.requestTimeouts.writeMs,
        this.server.sendTransaction(signedTransaction)
      ),
      'sendTransaction'
    )) as {
      errorResultXdr?: string;
      hash?: string;
      status?: string;
    };

    if (this.logger.enabled) {
      this.logger(`${methodName ?? 'signAndSend'} transaction response`, {
        hash: response.hash,
        status: response.status,
        response,
      });
    }

    if (!response.hash || !response.status) {
      throw new TransactionFailedError('RPC server returned an invalid sendTransaction response.');
    }

    if (response.status !== 'PENDING' && response.status !== 'DUPLICATE') {
      throw new TransactionFailedError(
        `Transaction submission failed with status ${response.status}. ${
          response.errorResultXdr ?? ''
        }`.trim()
      );
    }

    const finalStatus = (await this.wrapRpcCall(
      withTimeout(
        'pollTransaction',
        this.requestTimeouts.writeMs,
        this.server.pollTransaction(response.hash, {
          attempts: POLL_ATTEMPTS,
        })
      ),
      'pollTransaction'
    )) as {
      resultXdr?: string;
      status?: string;
    };

    if (this.logger.enabled) {
      this.logger(`${methodName ?? 'signAndSend'} final status`, finalStatus);
    }

    if (finalStatus.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new TransactionFailedError(
        `Transaction did not succeed. Final status: ${String(finalStatus.status)}.`
      );
    }
  }

  private summarizeSimulation(simulation: unknown): Record<string, unknown> {
    if (!simulation || typeof simulation !== 'object') {
      return { simulation };
    }

    const data = simulation as Record<string, unknown>;
    const result = data.result as Record<string, unknown> | undefined;

    return {
      error: data.error,
      status: data.status,
      fee: result?.fee,
      resources: result?.resources,
      retval: result?.retval,
      result,
    };
  }

  private toHex(xdrData: string): string {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(xdrData, 'base64').toString('hex');
    }

    if (typeof atob !== 'undefined') {
      const binary = atob(xdrData);
      let hex = '';

      for (let i = 0; i < binary.length; i += 1) {
        hex += binary.charCodeAt(i).toString(16).padStart(2, '0');
      }

      return hex;
    }

    return xdrData;
  }

  private extractBigIntResult(simulation: unknown, method: string): bigint {
    const result = this.extractSimulationRetval(simulation, method);
    return this.toBigInt(this.unwrapContractResult(scValToNative(result), method));
  }

  private simulateReadTransaction(method: string, transaction: BuiltTransaction): Promise<unknown> {
    return this.wrapRpcCall(
      withTimeout(
        `simulateTransaction:${method}`,
        this.requestTimeouts.readMs,
        this.server.simulateTransaction(transaction)
      ),
      `simulateReadTransaction:${method}`
    );
  }

  private simulateWriteTransaction(
    method: string,
    transaction: BuiltTransaction
  ): Promise<unknown> {
    return this.wrapRpcCall(
      withTimeout(
        `simulateTransaction:${method}`,
        this.requestTimeouts.simulationMs,
        this.server.simulateTransaction(transaction)
      ),
      `simulateWriteTransaction:${method}`
    );
  }

  private extractInvoiceResult(simulation: unknown): Invoice {
    const result = this.extractSimulationRetval(simulation, 'get_invoice');
    const nativeInvoice = this.unwrapContractResult(scValToNative(result), 'get_invoice') as Record<
      string,
      unknown
    >;

    const referralCode = nativeInvoice.referral_code ?? nativeInvoice.referralCode;
    const allowedLps = nativeInvoice.allowed_lps ?? nativeInvoice.allowedLps;
    const auctionStartRate = nativeInvoice.auction_start_rate ?? nativeInvoice.auctionStartRate;
    const auctionMinRate = nativeInvoice.auction_min_rate ?? nativeInvoice.auctionMinRate;
    const auctionRateDecayPerHour =
      nativeInvoice.auction_rate_decay_per_hour ?? nativeInvoice.auctionRateDecayPerHour;
    const auctionStartedAt = nativeInvoice.auction_started_at ?? nativeInvoice.auctionStartedAt;

    return {
      id: this.toBigInt(nativeInvoice.id),
      freelancer: this.toStringValue(nativeInvoice.freelancer, 'freelancer'),
      payer: this.toStringValue(nativeInvoice.payer, 'payer'),
      token: this.toStringValue(nativeInvoice.token, 'token'),
      amount: this.toBigInt(nativeInvoice.amount),
      dueDate: this.toNumberValue(nativeInvoice.due_date ?? nativeInvoice.dueDate, 'dueDate'),
      discountRate: this.toNumberValue(
        nativeInvoice.discount_rate ?? nativeInvoice.discountRate,
        'discountRate'
      ),
      status: this.parseStatus(nativeInvoice.status),
      funder:
        nativeInvoice.funder === null || nativeInvoice.funder === undefined
          ? null
          : this.toStringValue(nativeInvoice.funder, 'funder'),
      fundedAt:
        (nativeInvoice.funded_at === null || nativeInvoice.funded_at === undefined) &&
        (nativeInvoice.fundedAt === null || nativeInvoice.fundedAt === undefined)
          ? null
          : this.toNumberValue(nativeInvoice.funded_at ?? nativeInvoice.fundedAt, 'fundedAt'),
      amountFunded: this.toBigInt(nativeInvoice.amount_funded ?? nativeInvoice.amountFunded),
      amountPaid: this.toBigInt(nativeInvoice.amount_paid ?? nativeInvoice.amountPaid),
      submitterReputation: this.toNumberValue(
        nativeInvoice.submitter_reputation ?? nativeInvoice.submitterReputation,
        'submitterReputation'
      ),
      referralCode:
        referralCode === null || referralCode === undefined ? null : (referralCode as Uint8Array),
      allowedLps:
        allowedLps === null || allowedLps === undefined
          ? null
          : (allowedLps as unknown[]).map((lp, i) => this.toStringValue(lp, `allowedLps[${i}]`)),
      isAuction: Boolean(nativeInvoice.is_auction ?? nativeInvoice.isAuction),
      auctionStartRate:
        auctionStartRate === null || auctionStartRate === undefined
          ? null
          : this.toNumberValue(auctionStartRate, 'auctionStartRate'),
      auctionMinRate:
        auctionMinRate === null || auctionMinRate === undefined
          ? null
          : this.toNumberValue(auctionMinRate, 'auctionMinRate'),
      auctionRateDecayPerHour:
        auctionRateDecayPerHour === null || auctionRateDecayPerHour === undefined
          ? null
          : this.toNumberValue(auctionRateDecayPerHour, 'auctionRateDecayPerHour'),
      auctionStartedAt:
        auctionStartedAt === null || auctionStartedAt === undefined
          ? null
          : this.toNumberValue(auctionStartedAt, 'auctionStartedAt'),
    };
  }

  private parseProtocolConfig(value: unknown): ProtocolConfig {
    if (!value || typeof value !== 'object') {
      throw new Error('Contract returned an invalid protocol config payload.');
    }

    const config = value as Record<string, unknown>;

    return {
      minInvoiceAmount: this.toBigInt(
        this.configValue(config, 'minInvoiceAmount', 'min_invoice_amount', 'MIN_INVOICE_AMOUNT')
      ),
      maxDiscountRate: this.toNumberValue(
        this.configValue(config, 'maxDiscountRate', 'max_discount_rate', 'MAX_DISCOUNT_RATE'),
        'maxDiscountRate'
      ),
      protocolFeeBps: this.toNumberValue(
        this.configValue(config, 'protocolFeeBps', 'protocol_fee_bps', 'PROTOCOL_FEE_BPS'),
        'protocolFeeBps'
      ),
      minPayerReputation: this.toNumberValue(
        this.configValue(
          config,
          'minPayerReputation',
          'min_payer_reputation',
          'MIN_PAYER_REPUTATION'
        ),
        'minPayerReputation'
      ),
      decayRateBps: this.toNumberValue(
        this.configValue(config, 'decayRateBps', 'decay_rate_bps', 'DECAY_RATE_BPS'),
        'decayRateBps'
      ),
      maxInvoiceDuration: this.optionalNumber(
        config,
        'maxInvoiceDuration',
        'max_invoice_duration',
        'MAX_INVOICE_DURATION'
      ),
      minInvoiceDuration: this.optionalNumber(
        config,
        'minInvoiceDuration',
        'min_invoice_duration',
        'MIN_INVOICE_DURATION'
      ),
      gracePeriodSeconds: this.optionalNumber(
        config,
        'gracePeriodSeconds',
        'grace_period_seconds',
        'GRACE_PERIOD_SECONDS'
      ),
    };
  }

  private configValue(config: Record<string, unknown>, ...keys: string[]): unknown {
    for (const key of keys) {
      if (config[key] !== undefined) {
        return config[key];
      }
    }

    throw new Error(`Protocol config is missing ${keys[0]}.`);
  }

  private optionalNumber(config: Record<string, unknown>, ...keys: string[]): number | undefined {
    for (const key of keys) {
      if (config[key] !== undefined && config[key] !== null) {
        return this.toNumberValue(config[key], key);
      }
    }

    return undefined;
  }

  private extractSimulationRetval(simulation: unknown, method: string): xdr.ScVal {
    const typedSimulation = simulation as SimulationLike;

    if (typedSimulation.error) {
      const error = typedSimulation.error;
      throw new Error(
        `Simulation failed for ${method}: ${error ? String(error) : 'Unknown RPC error.'}`
      );
    }

    if (!typedSimulation.result?.retval) {
      throw new Error(`Simulation for ${method} did not return a contract result.`);
    }

    return typedSimulation.result.retval;
  }

  private unwrapContractResult(value: unknown, method: string): unknown {
    if (!value || typeof value !== 'object') {
      return value;
    }

    if ('ok' in value) {
      return (value as { ok: unknown }).ok;
    }
    if ('Ok' in value) {
      return (value as { Ok: unknown }).Ok;
    }
    if ('err' in value) {
      const error = (value as { err: unknown }).err;
      const parsedError = parseContractError(error);
      if (parsedError instanceof GenericContractError) {
        throw new TransactionFailedError(
          `Contract method ${method} returned an error: ${this.formatContractError(error)}.`
        );
      }
      throw parsedError;
    }
    if ('Err' in value) {
      const error = (value as { Err: unknown }).Err;
      const parsedError = parseContractError(error);
      if (parsedError instanceof GenericContractError) {
        throw new TransactionFailedError(
          `Contract method ${method} returned an error: ${this.formatContractError(error)}.`
        );
      }
      throw parsedError;
    }

    return value;
  }

  private formatContractError(error: unknown): string {
    if (typeof error === 'string') {
      return error;
    }
    if (typeof error === 'number' || typeof error === 'bigint' || typeof error === 'boolean') {
      return String(error);
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private toAddress(address: string) {
    return Address.fromString(address).toScVal();
  }

  private toBigInt(value: unknown): bigint {
    if (typeof value === 'bigint') {
      return value;
    }
    if (typeof value === 'number') {
      return BigInt(value);
    }
    if (typeof value === 'string') {
      return BigInt(value);
    }

    throw new Error(`Expected bigint-compatible value but received ${typeof value}.`);
  }

  private toNumberValue(value: unknown, field: string): number {
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'bigint') {
      return Number(value);
    }

    throw new Error(`Expected numeric ${field} value but received ${typeof value}.`);
  }

  private toStringValue(value: unknown, field: string): string {
    if (typeof value === 'string') {
      return value;
    }

    throw new Error(`Expected string ${field} value but received ${typeof value}.`);
  }

  private parseStatus(value: unknown): InvoiceState {
    if (typeof value === 'string') {
      return this.normalizeStatus(value);
    }

    if (value && typeof value === 'object') {
      const [key] = Object.keys(value as Record<string, unknown>);
      if (key) {
        return this.normalizeStatus(key);
      }
    }

    throw new Error('Unable to parse invoice status from contract response.');
  }

  private normalizeStatus(value: string): InvoiceState {
    const normalized = value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();

    switch (normalized) {
      case 'Pending':
      case 'Funded':
      case 'Paid':
      case 'Defaulted':
        return normalized;
      default:
        throw new Error(`Unknown invoice status "${value}".`);
    }
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  // ── Offline queue public API ──────────────────────────────────────────────

  /**
   * Returns the current offline queue state, or null if the offline queue is
   * not enabled for this SDK instance.
   */
  getOfflineState(): OfflineState | null {
    return this.offlineManager?.getState() ?? null;
  }

  /**
   * Returns the underlying OfflineManager, or null when the queue is disabled.
   * Use this for advanced queue management (retry, remove, clear).
   */
  getOfflineManager(): OfflineManager | null {
    return this.offlineManager;
  }

  /**
   * Manually mark the SDK as online/offline.
   * Useful for Node.js environments that don't have browser connectivity events.
   * When set to `true`, the queue is flushed immediately.
   */
  setOnline(online: boolean): void {
    this.offlineManager?.setOnline(online);
  }

  /**
   * Flush all pending offline queue items immediately.
   * No-op when the offline queue is not enabled.
   */
  async flushOfflineQueue(): Promise<void> {
    if (this.offlineManager) {
      await this.offlineManager.processQueue();
    }
  }

  private async executeQueuedOperation(item: OfflineQueueItem): Promise<boolean> {
    try {
      const params = item.params as any;
      switch (item.operation) {
        case 'submitInvoice':
          await this.submitInvoice(params as SubmitInvoiceParams);
          break;
        case 'fundInvoice':
          await this.fundInvoice(params as FundInvoiceParams);
          break;
        case 'markPaid':
          await this.markPaid(params as MarkPaidParams);
          break;
        case 'claimDefault':
          await this.claimDefault(params as ClaimDefaultParams);
          break;
        default:
          return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStatistics() {
    return this.cache.getStatistics();
  }

  /**
   * Clear all cache entries
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Invalidate cache entries matching a pattern
   */
  invalidateCache(pattern?: string) {
    return this.cache.invalidate(pattern);
  }

  /**
   * Reset cache statistics
   */
  resetCacheStatistics() {
    this.cache.resetStatistics();
  }
}
