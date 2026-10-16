import {
  Account,
  Address,
  BASE_FEE,
  Horizon,
  Networks,
  Operation,
  rpc as SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr as stellarXdr,
} from '@stellar/stellar-sdk';

import { ContractCallError, NetworkError } from '../errors';
import { xdr as sdkXdr } from '../xdr';

/**
 * Supported transaction types for filtering history.
 * Maps to Horizon operation type strings.
 */
export type TransactionType =
  | 'payment'
  | 'create_account'
  | 'change_trust'
  | 'manage_sell_offer'
  | 'manage_buy_offer'
  | 'path_payment_strict_send'
  | 'path_payment_strict_receive'
  | 'invoke_host_function';

/**
 * A normalised transaction record returned by {@link InvoiceClient.getTransactionHistory}.
 */
export interface TransactionRecord {
  /** Unique operation ID from Horizon. */
  id: string;
  /** ISO-8601 timestamp of when the operation was included in a ledger. */
  createdAt: string;
  /** Horizon operation type string (e.g. `"payment"`, `"invoke_host_function"`). */
  type: TransactionType | string;
  /** Source account that submitted the transaction. */
  from: string;
  /** Destination account (present for payment-like operations). */
  to?: string;
  /** Asset code (e.g. `"XLM"`, `"USDC"`). */
  asset?: string;
  /** Human-readable amount as a string to preserve decimal precision. */
  amount?: string;
  /** Hash of the parent transaction envelope. */
  transactionHash: string;
}

/**
 * Options for {@link InvoiceClient.getTransactionHistory}.
 */
export interface TransactionHistoryOptions {
  /**
   * Filter to a specific operation type.
   * When omitted all types are returned.
   */
  type?: TransactionType | string;
  /**
   * Inclusive lower bound (ISO-8601 or `Date`).
   * Operations with `created_at` before this value are excluded.
   */
  startDate?: string | Date;
  /**
   * Inclusive upper bound (ISO-8601 or `Date`).
   * Operations with `created_at` after this value are excluded.
   */
  endDate?: string | Date;
  /**
   * Number of records per page (1-200, default 20).
   * Horizon caps this at 200.
   */
  limit?: number;
  /**
   * Pagination cursor returned by a previous call as `nextCursor`.
   * Pass this value to fetch the next page of results.
   */
  cursor?: string;
  /**
   * Sort order for results (default `"desc"` - newest first).
   */
  order?: 'asc' | 'desc';
}

/**
 * Paginated response from {@link InvoiceClient.getTransactionHistory}.
 */
export interface TransactionHistoryPage {
  /** The records on this page. */
  records: TransactionRecord[];
  /**
   * Cursor to pass as `cursor` to fetch the next page.
   * `undefined` when there are no more pages.
   */
  nextCursor?: string;
  /** Total number of records returned on this page. */
  count: number;
}

export interface SignTransactionOptions {
  address: string;
  networkPassphrase: string;
}

/**
 * Minimal signer interface compatible with Freighter-style signers and
 * keypair-backed SDK signers.
 */
export interface InvoiceTransactionSigner {
  getPublicKey(): Promise<string>;
  signTransaction(transactionXdr: string, options: SignTransactionOptions): Promise<string>;
}

export interface RpcServerLike {
  getAccount(address: string): Promise<unknown>;
  simulateTransaction(transaction: unknown): Promise<unknown>;
  prepareTransaction(transaction: unknown): Promise<{ toXDR(): string }>;
  sendTransaction(transaction: unknown): Promise<unknown>;
  pollTransaction(hash: string, options?: { attempts?: number }): Promise<unknown>;
}

export interface InvoiceClientOptions {
  /** Soroban RPC URL used for contract calls. Defaults to the first constructor URL. */
  rpcUrl?: string;
  /** Horizon URL used by transaction history. Defaults to the first constructor URL. */
  horizonUrl?: string;
  /** Convenience network selector used when no explicit networkPassphrase is provided. */
  network?: 'testnet' | 'mainnet';
  /** Network passphrase used while building and signing transactions. */
  networkPassphrase?: string;
  /** Optional signer for submit/fund/pay contract calls. */
  signer?: InvoiceTransactionSigner;
  /** Optional Soroban RPC test double. */
  rpcServer?: RpcServerLike;
  /** Optional Horizon test double. */
  horizonServer?: Pick<Horizon.Server, 'payments'>;
}

export interface InvoiceClientConfig extends InvoiceClientOptions {
  contractId: string;
}

export interface SubmitInvoiceInput {
  freelancer?: string;
  payer: string;
  amount: bigint | number | string;
  dueDate: bigint | number | string | Date;
  discountRate: bigint | number | string;
  token: string;
  referralCode?: Uint8Array | string;
  allowedLps?: string[];
}

export interface FundInvoiceInput {
  funder?: string;
  invoiceId: bigint | number | string;
  amount?: bigint | number | string;
  fundAmount?: bigint | number | string;
  requireOracleVerification?: boolean;
}

export interface MarkPaidInput {
  payer?: string;
  invoiceId: bigint | number | string;
  amount?: bigint | number | string;
}

export interface DisputeInvoiceInput {
  disputer?: string;
  invoiceId: bigint | number | string;
  reasonCategory: 'quality' | 'timing' | 'amount' | 'other' | string;
  evidenceCid: string;
  reasonDescription?: string;
}

export interface SubmitDisputeEvidenceInput {
  submitter?: string;
  invoiceId: bigint | number | string;
  evidenceCid: string;
  description?: string;
}

export interface ResolveDisputeInput {
  admin?: string;
  invoiceId: bigint | number | string;
  decision: 'favor_payer' | 'favor_freelancer';
  notes?: string;
}

export interface AutoResolveDisputeInput {
  caller?: string;
  invoiceId: bigint | number | string;
}

export interface ContractEventResult {
  type?: string;
  topic: unknown[];
  value?: unknown;
  raw: unknown;
}

export interface ContractWriteResult {
  hash: string;
  txHash: string;
  events: ContractEventResult[];
}

export interface SubmitInvoiceResult extends ContractWriteResult {
  invoiceId: bigint;
}

type BuiltTransaction = ReturnType<TransactionBuilder['build']>;

type SimulationLike = {
  error?: unknown;
  result?: {
    retval?: stellarXdr.ScVal;
  };
};

type SendTransactionLike = {
  errorResultXdr?: string;
  hash?: string;
  status?: string;
};

type PollTransactionLike = {
  events?: unknown[];
  resultXdr?: string;
  status?: string;
};

const DEFAULT_TIMEOUT_SECONDS = 30;
const POLL_ATTEMPTS = 30;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function normaliseOperation(op: any): TransactionRecord {
  return {
    id: op.id,
    createdAt: op.created_at,
    type: op.type,
    from: op.source_account ?? op.from ?? '',
    to: op.to,
    asset:
      op.asset_type === 'native'
        ? 'XLM'
        : op.asset_code ?? op.selling_asset_code ?? op.buying_asset_code,
    amount: op.amount ?? op.starting_balance,
    transactionHash: op.transaction_hash,
  };
}

/**
 * Converts an array of {@link TransactionRecord} objects to a CSV string.
 *
 * @param records - The records to serialise.
 * @returns A UTF-8 CSV string with a header row.
 */
export function exportTransactionsToCsv(records: TransactionRecord[]): string {
  const headers = [
    'id',
    'createdAt',
    'type',
    'from',
    'to',
    'asset',
    'amount',
    'transactionHash',
  ] as const;

  const escape = (value: string | undefined): string => {
    if (value === undefined || value === '') return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = records.map((r) => headers.map((h) => escape(r[h])).join(','));

  return [headers.join(','), ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Client for interacting with the Invoice Liquidity Network protocol on Stellar.
 *
 * Provides methods to create, fund, and settle invoices via the ILN smart contract,
 * and to query, filter, paginate, and export an account's transaction history.
 *
 * @example
 * ```ts
 * const client = new InvoiceClient({
 *   contractId: 'CA3D...',
 *   rpcUrl: 'https://soroban-testnet.stellar.org',
 *   horizonUrl: 'https://horizon-testnet.stellar.org',
 *   signer,
 * });
 * ```
 */
export class InvoiceClient {
  private server: Pick<Horizon.Server, 'payments'>;
  private rpcServer: RpcServerLike;
  private contractId: string;
  private networkPassphrase: string;
  private signer?: InvoiceTransactionSigner;

  /**
   * Creates a new InvoiceClient instance.
   *
   * The legacy `(serverUrl, contractId, options?)` signature is preserved for
   * transaction-history users. Prefer the config-object signature for Soroban
   * writes because Horizon and Soroban RPC commonly use different URLs.
   */
  constructor(config: InvoiceClientConfig);
  constructor(serverUrl: string, contractId: string, options?: InvoiceClientOptions);
  constructor(
    serverUrlOrConfig: string | InvoiceClientConfig,
    contractId?: string,
    options: InvoiceClientOptions = {}
  ) {
    const config =
      typeof serverUrlOrConfig === 'string'
        ? {
            ...options,
            contractId: contractId ?? '',
            horizonUrl: options.horizonUrl ?? serverUrlOrConfig,
            rpcUrl: options.rpcUrl ?? serverUrlOrConfig,
          }
        : {
            ...serverUrlOrConfig,
            horizonUrl: serverUrlOrConfig.horizonUrl ?? serverUrlOrConfig.rpcUrl,
          };

    if (!config.contractId) {
      throw new Error('InvoiceClient requires a contractId.');
    }

    const rpcUrl = config.rpcUrl ?? config.horizonUrl;
    if (!rpcUrl && !config.rpcServer) {
      throw new Error('InvoiceClient requires an rpcUrl or rpcServer for contract writes.');
    }

    this.server = config.horizonServer ?? new Horizon.Server(config.horizonUrl ?? rpcUrl ?? '');
    this.rpcServer = config.rpcServer ?? new SorobanRpc.Server(rpcUrl ?? '');
    this.contractId = config.contractId;
    this.networkPassphrase =
      config.networkPassphrase ??
      (config.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET);
    this.signer = config.signer;
  }

  // -------------------------------------------------------------------------
  // Invoice lifecycle
  // -------------------------------------------------------------------------

  /**
   * Submits a new invoice to the ILN smart contract for liquidity.
   *
   * @param invoiceData - The invoice payload to submit on-chain.
   * @returns The submitted transaction hash, parsed events, and invoice ID.
   */
  public async submitInvoice(invoiceData: SubmitInvoiceInput): Promise<SubmitInvoiceResult> {
    const freelancer = invoiceData.freelancer ?? (await this.requireSignerAddress());
    await this.assertSignerMatches(freelancer, 'submitInvoice');

    const transaction = await this.buildWriteTransaction(
      freelancer,
      'submit_invoice',
      this.buildSubmitInvoiceArgs({ ...invoiceData, freelancer })
    );

    const simulation = await this.simulate(transaction, 'submit_invoice');
    const invoiceId = this.extractBigIntResult(simulation, 'submit_invoice');
    const result = await this.prepareSignAndSend(transaction, freelancer, 'submit_invoice');

    return { ...result, invoiceId };
  }

  /**
   * Funds a pending invoice as a liquidity provider.
   *
   * @param invoiceIdOrInput - Invoice ID or funding options.
   * @param amount - Optional partial funding amount in token base units.
   * @returns The submitted transaction hash and parsed settlement events.
   */
  public async fundInvoice(
    invoiceIdOrInput: bigint | number | string | FundInvoiceInput,
    amount?: bigint | number | string
  ): Promise<ContractWriteResult> {
    const input =
      typeof invoiceIdOrInput === 'object'
        ? invoiceIdOrInput
        : { invoiceId: invoiceIdOrInput, amount };

    const funder = input.funder ?? (await this.requireSignerAddress());
    await this.assertSignerMatches(funder, 'fundInvoice');

    const invoiceId = this.toBigInt(input.invoiceId, 'invoiceId');
    const fundAmount =
      input.fundAmount !== undefined || input.amount !== undefined
        ? this.toBigInt(input.fundAmount ?? input.amount, 'fundAmount')
        : (await this.getInvoiceAmounts(invoiceId)).remainingFunding;

    if (fundAmount <= 0n) {
      throw new ContractCallError(
        'Invoice does not have any remaining balance to fund.',
        this.contractId,
        'fund_invoice'
      );
    }

    const args = [this.addressScVal(funder), this.u64ScVal(invoiceId), this.i128ScVal(fundAmount)];

    if (input.requireOracleVerification !== undefined) {
      args.push(this.boolScVal(input.requireOracleVerification));
    }

    const transaction = await this.buildWriteTransaction(funder, 'fund_invoice', args);
    await this.simulate(transaction, 'fund_invoice');
    return this.prepareSignAndSend(transaction, funder, 'fund_invoice');
  }

  /**
   * Marks an invoice as paid, releasing the escrowed funds to liquidity providers.
   *
   * @param invoiceIdOrInput - Invoice ID or payment options.
   * @param amount - Optional payment amount. If omitted, the remaining amount is fetched.
   * @returns The submitted transaction hash and parsed settlement events.
   */
  public async markPaid(
    invoiceIdOrInput: bigint | number | string | MarkPaidInput,
    amount?: bigint | number | string
  ): Promise<ContractWriteResult> {
    const input =
      typeof invoiceIdOrInput === 'object'
        ? invoiceIdOrInput
        : { invoiceId: invoiceIdOrInput, amount };

    const payer = input.payer ?? (await this.requireSignerAddress());
    await this.assertSignerMatches(payer, 'markPaid');

    const invoiceId = this.toBigInt(input.invoiceId, 'invoiceId');
    const paymentAmount =
      input.amount === undefined
        ? (await this.getInvoiceAmounts(invoiceId)).remainingPayment
        : this.toBigInt(input.amount, 'amount');

    const args = [
      this.addressScVal(payer),
      this.u64ScVal(invoiceId),
      this.i128ScVal(paymentAmount),
    ];

    const transaction = await this.buildWriteTransaction(payer, 'mark_paid', args);
    await this.simulate(transaction, 'mark_paid');
    return this.prepareSignAndSend(transaction, payer, 'mark_paid');
  }

  /**
   * Files a dispute on an invoice with reason category and evidence IPFS CID.
   *
   * @param input - Dispute filing payload.
   * @returns The submitted transaction hash and parsed events.
   */
  public async disputeInvoice(input: DisputeInvoiceInput): Promise<ContractWriteResult> {
    const disputer = input.disputer ?? (await this.requireSignerAddress());
    await this.assertSignerMatches(disputer, 'disputeInvoice');

    const invoiceId = this.toBigInt(input.invoiceId, 'invoiceId');
    const args = [
      this.addressScVal(disputer),
      this.u64ScVal(invoiceId),
      this.stringScVal(input.reasonCategory),
      this.stringScVal(input.evidenceCid),
    ];

    const transaction = await this.buildWriteTransaction(disputer, 'dispute_invoice', args);
    await this.simulate(transaction, 'dispute_invoice');
    return this.prepareSignAndSend(transaction, disputer, 'dispute_invoice');
  }

  /**
   * Submits supporting evidence (IPFS CID) for an active dispute.
   *
   * @param input - Evidence submission payload.
   * @returns The submitted transaction hash and parsed events.
   */
  public async submitDisputeEvidence(
    input: SubmitDisputeEvidenceInput
  ): Promise<ContractWriteResult> {
    const submitter = input.submitter ?? (await this.requireSignerAddress());
    await this.assertSignerMatches(submitter, 'submitDisputeEvidence');

    const invoiceId = this.toBigInt(input.invoiceId, 'invoiceId');
    const args = [
      this.addressScVal(submitter),
      this.u64ScVal(invoiceId),
      this.stringScVal(input.evidenceCid),
    ];

    const transaction = await this.buildWriteTransaction(
      submitter,
      'submit_dispute_evidence',
      args
    );
    await this.simulate(transaction, 'submit_dispute_evidence');
    return this.prepareSignAndSend(transaction, submitter, 'submit_dispute_evidence');
  }

  /**
   * Resolves a dispute through admin arbitration.
   *
   * @param input - Arbitration resolution decision and memo.
   * @returns The submitted transaction hash and parsed events.
   */
  public async resolveDispute(input: ResolveDisputeInput): Promise<ContractWriteResult> {
    const admin = input.admin ?? (await this.requireSignerAddress());
    await this.assertSignerMatches(admin, 'resolveDispute');

    const invoiceId = this.toBigInt(input.invoiceId, 'invoiceId');
    const args = [
      this.addressScVal(admin),
      this.u64ScVal(invoiceId),
      this.stringScVal(input.decision),
      this.stringScVal(input.notes ?? ''),
    ];

    const transaction = await this.buildWriteTransaction(admin, 'resolve_dispute', args);
    await this.simulate(transaction, 'resolve_dispute');
    return this.prepareSignAndSend(transaction, admin, 'resolve_dispute');
  }

  /**
   * Auto-resolves a dispute once the evidence/dispute deadline has expired.
   *
   * @param input - Target invoice to auto-resolve.
   * @returns The submitted transaction hash and parsed events.
   */
  public async autoResolveDispute(input: AutoResolveDisputeInput): Promise<ContractWriteResult> {
    const caller = input.caller ?? (await this.requireSignerAddress());
    await this.assertSignerMatches(caller, 'autoResolveDispute');

    const invoiceId = this.toBigInt(input.invoiceId, 'invoiceId');
    const args = [this.addressScVal(caller), this.u64ScVal(invoiceId)];

    const transaction = await this.buildWriteTransaction(
      caller,
      'auto_resolve_dispute',
      args
    );
    await this.simulate(transaction, 'auto_resolve_dispute');
    return this.prepareSignAndSend(transaction, caller, 'auto_resolve_dispute');
  }

  private buildSubmitInvoiceArgs(
    input: SubmitInvoiceInput & { freelancer: string }
  ): stellarXdr.ScVal[] {
    const args = [
      this.addressScVal(input.freelancer),
      this.addressScVal(input.payer),
      this.i128ScVal(this.toBigInt(input.amount, 'amount')),
      this.u64ScVal(this.toUnixTimestamp(input.dueDate)),
      this.u32ScVal(input.discountRate),
      this.addressScVal(input.token),
    ];

    if (input.referralCode !== undefined) {
      args.push(this.bytesScVal(input.referralCode));
    }

    if (input.allowedLps !== undefined) {
      args.push(this.addressVecScVal(input.allowedLps));
    }

    return args;
  }

  private async buildWriteTransaction(
    sourceAddress: string,
    method: string,
    args: stellarXdr.ScVal[]
  ): Promise<BuiltTransaction> {
    const sourceAccount = (await this.rpc('getAccount', method, () =>
      this.rpcServer.getAccount(sourceAddress)
    )) as Account;

    return new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          source: sourceAddress,
          contract: this.contractId,
          function: method,
          args,
        })
      )
      .setTimeout(DEFAULT_TIMEOUT_SECONDS)
      .build();
  }

  private buildReadTransaction(method: string, args: stellarXdr.ScVal[]): BuiltTransaction {
    return new TransactionBuilder(new Account(this.readOnlyAccount(), '0'), {
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
      .setTimeout(DEFAULT_TIMEOUT_SECONDS)
      .build();
  }

  private async simulate(transaction: BuiltTransaction, method: string): Promise<SimulationLike> {
    const simulation = (await this.rpc('simulateTransaction', method, () =>
      this.rpcServer.simulateTransaction(transaction)
    )) as SimulationLike;

    if (simulation.error) {
      throw new ContractCallError(
        `Simulation failed for ${method}: ${String(simulation.error)}`,
        this.contractId,
        method
      );
    }

    return simulation;
  }

  private async prepareSignAndSend(
    transaction: BuiltTransaction,
    sourceAddress: string,
    method: string
  ): Promise<ContractWriteResult> {
    const signer = this.signer;
    if (!signer) {
      throw new ContractCallError(
        'A signer is required for state-changing contract calls.',
        this.contractId,
        method
      );
    }

    const prepared = await this.rpc('prepareTransaction', method, () =>
      this.rpcServer.prepareTransaction(transaction)
    );
    const signedXdr = await signer.signTransaction(prepared.toXDR(), {
      address: sourceAddress,
      networkPassphrase: this.networkPassphrase,
    });
    const signedTransaction = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const response = (await this.rpc('sendTransaction', method, () =>
      this.rpcServer.sendTransaction(signedTransaction)
    )) as SendTransactionLike;

    if (!response.hash || !response.status) {
      throw new NetworkError(`RPC server returned an invalid ${method} submission response.`);
    }

    if (response.status !== 'PENDING' && response.status !== 'DUPLICATE') {
      throw new ContractCallError(
        `Transaction submission failed with status ${response.status}. ${
          response.errorResultXdr ?? ''
        }`.trim(),
        this.contractId,
        method
      );
    }

    const finalStatus = (await this.rpc('pollTransaction', method, () =>
      this.rpcServer.pollTransaction(response.hash as string, { attempts: POLL_ATTEMPTS })
    )) as PollTransactionLike;

    if (finalStatus.status !== 'SUCCESS') {
      throw new ContractCallError(
        `Transaction did not succeed. Final status: ${String(finalStatus.status)}.`,
        this.contractId,
        method
      );
    }

    return {
      hash: response.hash,
      txHash: response.hash,
      events: this.parseEvents(finalStatus),
    };
  }

  private async getInvoiceAmounts(invoiceId: bigint): Promise<{
    remainingFunding: bigint;
    remainingPayment: bigint;
  }> {
    const transaction = this.buildReadTransaction('get_invoice', [this.u64ScVal(invoiceId)]);
    const simulation = await this.simulate(transaction, 'get_invoice');
    const invoice = this.unwrapContractResult(
      this.extractRetval(simulation, 'get_invoice'),
      'get_invoice'
    );

    if (!invoice || typeof invoice !== 'object') {
      throw new ContractCallError(
        'Contract returned an invalid invoice payload.',
        this.contractId,
        'get_invoice'
      );
    }

    const total = this.toBigInt(this.invoiceField(invoice, 'amount'), 'invoice.amount');
    const funded = this.toBigInt(
      this.invoiceField(invoice, 'amount_funded', 'amountFunded') ?? 0n,
      'invoice.amount_funded'
    );
    const paid = this.toBigInt(
      this.invoiceField(invoice, 'amount_paid', 'amountPaid') ?? 0n,
      'invoice.amount_paid'
    );

    return {
      remainingFunding: total - funded,
      remainingPayment: total - paid,
    };
  }

  private invoiceField(invoice: unknown, ...keys: string[]): unknown {
    if (invoice instanceof Map) {
      for (const key of keys) {
        if (invoice.has(key)) {
          return invoice.get(key);
        }
      }
      return undefined;
    }

    const record = invoice as Record<string, unknown>;
    for (const key of keys) {
      if (record[key] !== undefined) {
        return record[key];
      }
    }

    return undefined;
  }

  private extractBigIntResult(simulation: SimulationLike, method: string): bigint {
    return this.toBigInt(
      this.unwrapContractResult(this.extractRetval(simulation, method), method),
      `${method} result`
    );
  }

  private extractRetval(simulation: SimulationLike, method: string): unknown {
    if (!simulation.result?.retval) {
      throw new ContractCallError(
        `Simulation for ${method} did not return a contract result.`,
        this.contractId,
        method
      );
    }

    return scValToNative(simulation.result.retval);
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
      throw new ContractCallError(
        `Contract rejected ${method}: ${this.formatContractError((value as { err: unknown }).err)}`,
        this.contractId,
        method
      );
    }
    if ('Err' in value) {
      throw new ContractCallError(
        `Contract rejected ${method}: ${this.formatContractError((value as { Err: unknown }).Err)}`,
        this.contractId,
        method
      );
    }

    return value;
  }

  private parseEvents(finalStatus: PollTransactionLike): ContractEventResult[] {
    const events = Array.isArray(finalStatus.events) ? finalStatus.events : [];

    return events.map((event) => {
      const record = event as Record<string, unknown>;
      const topic = Array.isArray(record.topic)
        ? record.topic.map((item) => this.readEventValue(item))
        : [];

      return {
        type: topic.find((item): item is string => typeof item === 'string'),
        topic,
        value: record.value === undefined ? undefined : this.readEventValue(record.value),
        raw: event,
      };
    });
  }

  private readEventValue(value: unknown): unknown {
    if (value instanceof stellarXdr.ScVal) {
      return scValToNative(value);
    }
    return value;
  }

  private async assertSignerMatches(address: string, method: string): Promise<void> {
    if (!this.signer) {
      throw new ContractCallError(
        'A signer is required for state-changing contract calls.',
        this.contractId,
        method
      );
    }

    const signerAddress = await this.requireSignerAddress();
    if (signerAddress !== address) {
      throw new ContractCallError(
        `${method} must be signed by ${address}.`,
        this.contractId,
        method
      );
    }
  }

  private async requireSignerAddress(): Promise<string> {
    if (!this.signer) {
      throw new ContractCallError(
        'A signer is required for state-changing contract calls.',
        this.contractId
      );
    }

    return this.signer.getPublicKey();
  }

  private async rpc<T>(operation: string, method: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ContractCallError || error instanceof NetworkError) {
        throw error;
      }

      const status =
        typeof error === 'object' && error !== null && 'status' in error
          ? Number((error as { status?: unknown }).status)
          : undefined;
      const message = error instanceof Error ? error.message : String(error);

      throw new NetworkError(
        `Network error during ${operation} for ${method}: ${message}`,
        undefined,
        Number.isFinite(status) ? { status } : undefined
      );
    }
  }

  private addressScVal(address: string): stellarXdr.ScVal {
    return this.encodeScVal(new Address(address).toScVal());
  }

  private i128ScVal(value: bigint): stellarXdr.ScVal {
    return this.encodeScVal(nativeToScVal(value, { type: 'i128' }));
  }

  private u64ScVal(value: bigint): stellarXdr.ScVal {
    return this.encodeScVal(nativeToScVal(value, { type: 'u64' }));
  }

  private u32ScVal(value: bigint | number | string): stellarXdr.ScVal {
    return this.encodeScVal(nativeToScVal(Number(value), { type: 'u32' }));
  }

  private boolScVal(value: boolean): stellarXdr.ScVal {
    return this.encodeScVal(nativeToScVal(value, { type: 'bool' }));
  }

  private bytesScVal(value: Uint8Array | string): stellarXdr.ScVal {
    const bytes = typeof value === 'string' ? this.stringToBytes(value) : value;
    return this.encodeScVal(nativeToScVal(bytes));
  }

  private stringScVal(value: string): stellarXdr.ScVal {
    return this.encodeScVal(nativeToScVal(value, { type: 'string' }));
  }

  private symbolScVal(value: string): stellarXdr.ScVal {
    return this.encodeScVal(nativeToScVal(value, { type: 'symbol' }));
  }

  private addressVecScVal(addresses: string[]): stellarXdr.ScVal {
    return this.encodeScVal(
      stellarXdr.ScVal.scvVec(addresses.map((address) => new Address(address).toScVal()))
    );
  }

  private encodeScVal(scVal: stellarXdr.ScVal): stellarXdr.ScVal {
    sdkXdr.encode(scVal);
    return scVal;
  }

  private stringToBytes(value: string): Uint8Array {
    const trimmed = value.trim();
    const hex = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;

    if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
      return new Uint8Array(
        Array.from({ length: hex.length / 2 }, (_, index) =>
          Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
        )
      );
    }

    return new Uint8Array(Array.from(trimmed, (char) => char.charCodeAt(0)));
  }

  private toBigInt(value: unknown, field: string): bigint {
    if (typeof value === 'bigint') {
      return value;
    }
    if (typeof value === 'number') {
      return BigInt(value);
    }
    if (typeof value === 'string') {
      return BigInt(value);
    }

    throw new ContractCallError(
      `Expected bigint-compatible ${field}, received ${typeof value}.`,
      this.contractId
    );
  }

  private toUnixTimestamp(value: bigint | number | string | Date): bigint {
    if (value instanceof Date) {
      return BigInt(Math.floor(value.getTime() / 1000));
    }

    return this.toBigInt(value, 'dueDate');
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

  private readOnlyAccount(): string {
    return 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  }

  // -------------------------------------------------------------------------
  // Transaction history
  // -------------------------------------------------------------------------

  /**
   * Fetches paginated transaction history for a Stellar account.
   *
   * Results are sourced from the Horizon payments endpoint and normalised into
   * {@link TransactionRecord} objects. Client-side filters are applied after
   * the Horizon response so that `limit` reflects the number of records
   * **returned to the caller** (post-filter), not the raw Horizon page size.
   *
   * @param accountId - The Stellar public key (`G...`) to query.
   * @param options - Optional filters, pagination cursor, and sort order.
   * @returns A {@link TransactionHistoryPage} containing records and a cursor
   *   for the next page.
   */
  public async getTransactionHistory(
    accountId: string,
    options: TransactionHistoryOptions = {}
  ): Promise<TransactionHistoryPage> {
    const { type, startDate, endDate, limit = 20, cursor, order = 'desc' } = options;

    const clampedLimit = Math.min(Math.max(1, limit), 200);
    const horizonLimit = Math.min(clampedLimit * 3, 200);

    let query = this.server.payments().forAccount(accountId).limit(horizonLimit).order(order);

    if (cursor) {
      query = query.cursor(cursor);
    }

    const response = await query.call();
    const raw: any[] = response.records ?? [];

    let records = raw.map(normaliseOperation);

    if (type) {
      records = records.filter((r) => r.type === type);
    }

    if (startDate) {
      const start = toDate(startDate).getTime();
      records = records.filter((r) => new Date(r.createdAt).getTime() >= start);
    }

    if (endDate) {
      const end = toDate(endDate).getTime();
      records = records.filter((r) => new Date(r.createdAt).getTime() <= end);
    }

    const page = records.slice(0, clampedLimit);
    const lastRaw = raw[raw.length - 1];
    const nextCursor =
      raw.length > 0 && page.length === clampedLimit ? lastRaw.paging_token : undefined;

    return {
      records: page,
      nextCursor,
      count: page.length,
    };
  }
}
