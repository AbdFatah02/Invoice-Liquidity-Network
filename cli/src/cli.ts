#!/usr/bin/env node
import { Address, StrKey } from '@stellar/stellar-sdk';
import { Command } from 'commander';
import pc from 'picocolors';
import fs from 'node:fs';

import { parseDisplayAmount } from './amounts';
import { ILNClient } from './client';
import { loadConfig, initConfig, readRawConfig, writeRawConfig } from './config';
import { parseDueDate } from './dates';
import { LocalDevEnvironment } from './dev-environment';
import { formatUnknownError, formatILNError, isStructuredError } from './errors';
import { decodeScValXdr, formatDecodedScVal } from './xdr';
import {
  createUi,
  describeConfig,
  formatHistoryJson,
  formatHistoryTable,
  formatInvoiceDetails,
  formatInvoiceDetailsJson,
  formatInvoiceList,
  formatInvoiceListJson,
  formatProtocolConfig,
  formatProtocolConfigJson,
  formatProtocolStats,
  formatProtocolStatsJson,
  formatReputation,
  formatReputationJson,
  helpExample,
  helpSection,
  formatJsonSuccess,
  formatJsonError,
} from './format';
import { generateManPage } from './man';
import { registerInspectCommand } from './inspect';
import { registerCompletionCommand } from './completion';
import { registerEnvCommands } from './env';
import {
  promptMissingArguments,
  validateStellarAddress,
  validatePositiveInteger,
  validatePositiveNumber,
  validateBasisPoints,
  validateDate,
} from './prompts';
import { createKeypairFileSigner } from './signer';
import { TestnetAccountSeeder } from './dev-seed';
import {
  createWallet,
  importWallet,
  listWallets,
  deleteWallet,
  fundWalletFromFriendbot,
} from './wallet';
import type { Ui } from './format';
import type { Invoice, ResolvedConfig } from './types';

import { checkCompatibility } from '@iln/sdk';
import { runInteractive } from './interactive';
import { VersionManager } from './version';
import { runTutorial } from './tutorial';
import { withSpinner, createTransactionProgress, type ProgressOptions } from './progress';

export interface CliDependencies {
  createClient(config: ResolvedConfig): ILNClient;
  createDevEnvironment?(ui: Ui): Pick<LocalDevEnvironment, 'reset' | 'start' | 'status' | 'stop'>;
  loadConfig(options?: { cwd?: string; env?: NodeJS.ProcessEnv }): ResolvedConfig;
  stderr: NodeJS.WritableStream;
  stdout: NodeJS.WritableStream;
  __returnProgramForDocs?: boolean;
}

export async function runCli(
  argv: string[],
  dependencies: Partial<CliDependencies> = {}
): Promise<number | any> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const ui = createUi(stdout, stderr);
  const load = dependencies.loadConfig ?? loadConfig;
  const createClient =
    dependencies.createClient ??
    ((config: ResolvedConfig) =>
      new ILNClient({
        contractId: config.contractId,
        networkPassphrase: config.networkPassphrase,
        rpcUrl: config.rpcUrl,
        signer: createKeypairFileSigner(config.keypairPath),
      }));
  const createDevEnvironment =
    dependencies.createDevEnvironment ?? ((devUi: Ui) => new LocalDevEnvironment({ ui: devUi }));

  // Step 1: Load custom aliases from config
  let customAliases: Record<string, string> = {};
  try {
    const { rawConfig } = readRawConfig(process.cwd());
    customAliases = rawConfig.aliases || {};
  } catch {
    // Ignore if config doesn't exist or is invalid
  }

  // Step 2: Resolve aliases in argv
  const resolvedArgv = [...argv];
  if (resolvedArgv.length > 0) {
    const firstArg = resolvedArgv[0];
    if (customAliases[firstArg]) {
      resolvedArgv[0] = customAliases[firstArg];
    }
  }

  const program = new Command();

  program.configureOutput({
    writeOut: (str) => stdout.write(str),
    writeErr: (str) => stderr.write(str),
  });

  program.configureHelp({
    formatHelp: (cmd, helper) => {
      const term = (str: string) => pc.bold(pc.cyan(str));
      const sections: string[] = [];

      const usage = helper.commandUsage(cmd);
      if (usage) sections.push(`${pc.bold('Usage:')} ${usage}`);

      const description = helper.commandDescription(cmd);
      if (description) sections.push(`\n${description}`);

      const args = helper.visibleArguments(cmd);
      if (args.length) {
        sections.push(`\n${pc.bold('Arguments:')}`);
        args.forEach((a) =>
          sections.push(
            `  ${term(
              helper.argumentTerm(a).padEnd(helper.padWidth(cmd, helper))
            )}  ${helper.argumentDescription(a)}`
          )
        );
      }

      const opts = helper.visibleOptions(cmd);
      if (opts.length) {
        sections.push(`\n${pc.bold('Options:')}`);
        opts.forEach((o) =>
          sections.push(
            `  ${term(
              helper.optionTerm(o).padEnd(helper.padWidth(cmd, helper))
            )}  ${helper.optionDescription(o)}`
          )
        );
      }

      const cmds = helper.visibleCommands(cmd);
      if (cmds.length) {
        sections.push(`\n${pc.bold('Commands:')}`);
        cmds.forEach((c) =>
          sections.push(
            `  ${term(
              helper.subcommandTerm(c).padEnd(helper.padWidth(cmd, helper))
            )}  ${helper.subcommandDescription(c)}`
          )
        );
      }

      return sections.join('\n') + '\n';
    },
  });

  const versionManager = new VersionManager(ui);

  program
    .name('iln')
    .version(versionManager.getCurrentVersion(), '-v, --version', 'output the current version')
    .description('Invoice Liquidity Network CLI')
    .exitOverride()
    .showHelpAfterError()
    .option('--json', 'output machine-readable JSON (applies to: status, list)')
    .option('--quiet', 'suppress informational messages; show only command output')
    .hook('preAction', (_thisCommand, actionCommand) => {
      registerCompletionCommand(program);
      registerEnvCommands(program);
      registerInspectCommand(program, createClient, load, ui);

      const isConfiglessXdrCommand =
        actionCommand.name() === 'decode' && actionCommand.parent?.name() === 'xdr';
      if (
        actionCommand.name() === 'man' ||
        isConfiglessXdrCommand ||
        (actionCommand.parent?.name() === 'dev' &&
          ['reset', 'start', 'status', 'stop'].includes(actionCommand.name()))
      ) {
        return;
      }

      const config = load();
      const opts = program.opts() as { json?: boolean; quiet?: boolean };
      if (!opts.quiet && !opts.json) {
        ui.info(`Using ${describeConfig(config)}`);
      }

      // --- Version Management ---
      const currentVersion = versionManager.getCurrentVersion();

      // 1. Version Pinning
      if (config.requiredVersion && config.requiredVersion !== currentVersion) {
        throw new Error(
          `Version mismatch: This project requires ILN CLI version ${config.requiredVersion}, but you are running ${currentVersion}.`
        );
      }

      // 2. Update Check
      if (config.autoUpdate && !opts.quiet && !opts.json) {
        // Fire and forget update check to not block startup significantly
        void versionManager.notifyUpdateIfAvailable();
      }
    });

  program
    .command('submit')
    .alias('s')
    .description('Submit a new invoice from the configured signer account.')
    .option('--payer <address>', 'payer Stellar address')
    .option('--amount <amount>', 'invoice amount in display units, for example 100 or 12.5')
    .option('--due <date>', 'due date as YYYY-MM-DD or Unix timestamp')
    .option('--rate <bps>', 'discount rate in basis points')
    .option('--token <contractId>', 'override token contract ID from config')
    .option('--yes', 'skip interactive prompts and use defaults')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln submit --payer GABC... --amount 100 --due 2026-03-31 --rate 300'),
        helpExample(
          'iln submit --payer GABC... --amount 12.5 --due 2026-06-15 --rate 150 --token CDEF...'
        ),
        '',
        helpSection('See also:'),
        helpExample('iln status --id <id>    Check the state of a submitted invoice'),
        helpExample('iln list --address <G>  List all invoices for your address'),
      ].join('\n')
    )
    .action(
      async (options: {
        amount?: string;
        due?: string;
        payer?: string;
        rate?: string;
        token?: string;
        yes?: boolean;
      }) => {
        const config = load();
        const client = createClient(config);
        const tokenId = options.token ?? config.tokenId;
        if (!tokenId) {
          throw new Error(
            'Missing token ID. Set `tokenId` in .iln.json, set `ILN_TOKEN_ID`, or pass `--token`.'
          );
        }

        // Prompt for missing required arguments in interactive mode
        let payer = options.payer;
        let amount = options.amount;
        let due = options.due;
        let rate = options.rate;

        if (!options.yes && process.stdin.isTTY) {
          const resolved = await promptMissingArguments(
            [
              {
                name: 'payer',
                description: 'Payer Stellar address (G...)',
                required: true,
                validate: validateStellarAddress,
              },
              {
                name: 'amount',
                description: 'Invoice amount in display units (e.g. 100 or 12.5)',
                required: true,
                validate: validatePositiveNumber,
              },
              {
                name: 'due',
                description: 'Due date as YYYY-MM-DD or Unix timestamp',
                required: true,
                validate: validateDate,
              },
              {
                name: 'rate',
                description: 'Discount rate in basis points (e.g. 500 = 5%)',
                required: true,
                defaultValue: '500',
                validate: validateBasisPoints,
              },
            ],
            { payer, amount, due, rate }
          );

          payer = resolved.payer;
          amount = resolved.amount;
          due = resolved.due;
          rate = resolved.rate;
        }

        if (!payer || !amount || !due || !rate) {
          throw new Error(
            'Missing required arguments. Use --payer, --amount, --due, --rate or run interactively.'
          );
        }

        assertStellarAddress(payer, 'payer');
        assertContractId(tokenId, 'token');

        const progress = cliProgressOptions(program, stdout);
        const tx = createTransactionProgress('Submitting invoice', progress);
        let submitResult: { invoiceId: bigint; txHash: string };
        try {
          submitResult = await client.submitInvoice({
            amount: parseDisplayAmount(amount),
            discountRate: parseBasisPoints(rate),
            dueDate: parseDueDate(due),
            payer,
            tokenId,
          });
          tx.succeed(
            `Invoice ${submitResult.invoiceId.toString()} submitted (tx ${submitResult.txHash})`
          );
        } catch (err) {
          tx.fail('Invoice submission failed');
          throw err;
        }

        const globalOpts = program.opts() as { json?: boolean };
        if (globalOpts.json) {
          stdout.write(
            formatJsonSuccess({
              invoiceId: submitResult.invoiceId.toString(),
              txHash: submitResult.txHash,
            }) + '\n'
          );
        }
      }
    );

  program
    .command('fund')
    .alias('f')
    .description('Fund an invoice using the configured signer account.')
    .option('--id <invoiceId>', 'invoice ID')
    .option(
      '--amount <amount>',
      'amount to fund in display units; defaults to the remaining balance'
    )
    .option('--yes', 'skip interactive prompts and use defaults')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln fund --id 42'),
        helpExample('iln fund --id 42 --amount 50   (partial funding)'),
        '',
        helpSection('See also:'),
        helpExample('iln status --id <id>    Confirm the invoice is now Funded'),
        helpExample('iln history --address <G>  View your funding history'),
      ].join('\n')
    )
    .action(async (options: { amount?: string; id?: string; yes?: boolean }) => {
      let invoiceId = await resolveIdFromStdin(options.id);

      if (!invoiceId && !options.yes && process.stdin.isTTY) {
        const resolved = await promptMissingArguments(
          [
            {
              name: 'id',
              description: 'Invoice ID to fund',
              required: true,
              validate: validatePositiveInteger,
            },
          ],
          { id: invoiceId }
        );
        invoiceId = resolved.id;
      }

      if (!invoiceId) {
        throw new Error('Missing required argument: --id. Provide it via option or pipe to stdin.');
      }
      const client = createClient(load());
      const progress = cliProgressOptions(program, stdout);
      const tx = createTransactionProgress('Funding invoice', progress);
      let fundResult: { hash: string };
      try {
        fundResult = await client.fundInvoice(
          parseInvoiceId(invoiceId),
          options.amount ? parseDisplayAmount(options.amount) : undefined
        );
        tx.succeed(`Invoice ${invoiceId} funded (tx ${fundResult.hash})`);
      } catch (err) {
        tx.fail('Invoice funding failed');
        throw err;
      }

      const globalOpts = program.opts() as { json?: boolean };
      if (globalOpts.json) {
        stdout.write(
          formatJsonSuccess({ invoiceId: invoiceId.toString(), txHash: fundResult.hash }) + '\n'
        );
      }
    });

  program
    .command('pay')
    .alias('p')
    .description('Mark an invoice as paid using the configured signer account.')
    .option('--id <invoiceId>', 'invoice ID')
    .option('--yes', 'skip interactive prompts and use defaults')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln pay --id 42'),
        '',
        helpSection('Tips:'),
        helpExample('Only the payer address on the invoice can mark it paid.'),
        helpExample('Run `iln status --id <id>` first to confirm the invoice is Funded.'),
        '',
        helpSection('See also:'),
        helpExample('iln status --id <id>    Verify the invoice is now Paid'),
        helpExample('iln history --address <G>  View your payment history'),
      ].join('\n')
    )
    .action(async (options: { id?: string; yes?: boolean }) => {
      let invoiceId = await resolveIdFromStdin(options.id);

      if (!invoiceId && !options.yes && process.stdin.isTTY) {
        const resolved = await promptMissingArguments(
          [
            {
              name: 'id',
              description: 'Invoice ID to mark as paid',
              required: true,
              validate: validatePositiveInteger,
            },
          ],
          { id: invoiceId }
        );
        invoiceId = resolved.id;
      }

      if (!invoiceId) {
        throw new Error('Missing required argument: --id. Provide it via option or pipe to stdin.');
      }
      const client = createClient(load());
      const progress = cliProgressOptions(program, stdout);
      const tx = createTransactionProgress('Marking invoice paid', progress);
      let payResult: { hash: string };
      try {
        payResult = await client.markPaid(parseInvoiceId(invoiceId));
        tx.succeed(`Invoice ${invoiceId} marked paid (tx ${payResult.hash})`);
      } catch (err) {
        tx.fail('Mark-paid failed');
        throw err;
      }

      const globalOpts = program.opts() as { json?: boolean };
      if (globalOpts.json) {
        stdout.write(
          formatJsonSuccess({ invoiceId: invoiceId.toString(), txHash: payResult.hash }) + '\n'
        );
      }
    });

  program
    .command('status')
    .description('Show the current state of an invoice.')
    .option('--id <invoiceId>', 'invoice ID')
    .option('--yes', 'skip interactive prompts and use defaults')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln status --id 42'),
        helpExample('iln status --id 1    (invoice IDs start at 1)'),
        '',
        helpSection('See also:'),
        helpExample('iln list --address <G>  List all invoices for an address'),
        helpExample('iln history --address <G>  View full action history'),
      ].join('\n')
    )
    .action(async (options: { id?: string; yes?: boolean }) => {
      let invoiceId = await resolveIdFromStdin(options.id);

      if (!invoiceId && !options.yes && process.stdin.isTTY) {
        const resolved = await promptMissingArguments(
          [
            {
              name: 'id',
              description: 'Invoice ID to check status',
              required: true,
              validate: validatePositiveInteger,
            },
          ],
          { id: invoiceId }
        );
        invoiceId = resolved.id;
      }

      if (!invoiceId) {
        throw new Error('Missing required argument: --id. Provide it via option or pipe to stdin.');
      }

      const client = createClient(load());
      const progress = cliProgressOptions(program, stdout);
      const invoice = await withSpinner(
        'Fetching invoice…',
        () => client.getInvoice(parseInvoiceId(invoiceId)),
        progress,
        `Fetched invoice ${invoiceId}`
      );
      const opts = program.opts() as { json?: boolean };
      ui.info(
        opts.json
          ? formatJsonSuccess(JSON.parse(formatInvoiceDetailsJson(invoice)))
          : formatInvoiceDetails(invoice)
      );
    });

  program
    .command('list')
    .description('List all invoices associated with a Stellar address.')
    .option('--address <address>', 'freelancer, payer, or funder Stellar address')
    .option('--yes', 'skip interactive prompts and use defaults')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln list --address GABC...'),
        helpExample(
          'iln list --address GABC...   (returns invoices where address is freelancer, payer, or funder)'
        ),
        '',
        helpSection('See also:'),
        helpExample('iln history --address <G>  Filter by action type or invoice ID'),
        helpExample('iln status --id <id>       Inspect a specific invoice'),
      ].join('\n')
    )
    .action(async (options: { address?: string; yes?: boolean }) => {
      let address = options.address;

      if (!options.yes && process.stdin.isTTY) {
        const resolved = await promptMissingArguments(
          [
            {
              name: 'address',
              description: 'Stellar address to list invoices for',
              required: true,
              validate: validateStellarAddress,
            },
          ],
          { address }
        );
        address = resolved.address;
      }

      if (!address) {
        throw new Error('Missing required argument: --address');
      }

      assertStellarAddress(address, 'address');
      const client = createClient(load());
      const progress = cliProgressOptions(program, stdout);
      const invoices = await withSpinner(
        'Fetching invoices…',
        () => client.listInvoicesByAddress(address),
        progress,
        'Invoices loaded'
      );
      const opts = program.opts() as { json?: boolean };
      ui.info(
        opts.json
          ? formatJsonSuccess(JSON.parse(formatInvoiceListJson(invoices)))
          : formatInvoiceList(invoices)
      );
    });

  program
    .command('history')
    .description('Show past invoice submissions, fundings, and payments for a Stellar address.')
    .option('--address <address>', 'Stellar address to query history for')
    .option('--id <invoiceId>', 'filter to a specific invoice ID')
    .option(
      '--action <type>',
      'filter by action type: submit (freelancer), fund (funder), pay (payer)'
    )
    .option('--limit <n>', 'maximum number of results to return')
    .option('--format <fmt>', 'output format: table (default) or json', 'table')
    .option('--yes', 'skip interactive prompts and use defaults')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln history --address GABC...'),
        helpExample('iln history --address GABC... --action fund --limit 10 --format json'),
        '',
        helpSection('See also:'),
        helpExample('iln list --address <G>    Quick overview of all invoices'),
        helpExample('iln status --id <id>      Full details on a single invoice'),
      ].join('\n')
    )
    .action(
      async (options: {
        address?: string;
        id?: string;
        action?: string;
        limit?: string;
        format: string;
        yes?: boolean;
      }) => {
        let address = options.address;

        if (!options.yes && process.stdin.isTTY) {
          const resolved = await promptMissingArguments(
            [
              {
                name: 'address',
                description: 'Stellar address to query history for',
                required: true,
                validate: validateStellarAddress,
              },
            ],
            { address }
          );
          address = resolved.address;
        }

        if (!address) {
          throw new Error('Missing required argument: --address');
        }

        assertStellarAddress(address, 'address');

        if (options.format !== 'table' && options.format !== 'json') {
          throw new Error('--format must be table or json');
        }

        const ACTION_TO_ROLE: Record<string, 'freelancer' | 'funder' | 'payer'> = {
          submit: 'freelancer',
          fund: 'funder',
          pay: 'payer',
        };

        if (options.action && !ACTION_TO_ROLE[options.action]) {
          throw new Error(`--action must be one of: ${Object.keys(ACTION_TO_ROLE).join(', ')}`);
        }

        const client = createClient(load());
        const progress = cliProgressOptions(program, stdout);
        let invoices = await withSpinner(
          'Fetching invoice history…',
          () => client.listInvoicesByAddress(address),
          progress,
          'History loaded'
        );

        if (options.id !== undefined) {
          const targetId = parseInvoiceId(options.id);
          invoices = invoices.filter((inv) => inv.id === targetId);
        }

        if (options.action) {
          const role = ACTION_TO_ROLE[options.action];
          invoices = invoices.filter((inv) => inv.role === role);
        }

        if (options.limit !== undefined) {
          const limit = parseInt(options.limit, 10);
          if (isNaN(limit) || limit <= 0) {
            throw new Error('--limit must be a positive integer');
          }
          invoices = invoices.slice(0, limit);
        }

        const globalOpts = program.opts() as { json?: boolean };
        const output =
          options.format === 'json' || globalOpts.json
            ? formatJsonSuccess(JSON.parse(formatHistoryJson(invoices)))
            : formatHistoryTable(invoices);

        ui.info(output);
      }
    );

  program
    .command('watch')
    .description('Watch an invoice for real-time status updates until it reaches a terminal state.')
    .requiredOption('--id <invoiceId>', 'invoice ID')
    .option('--interval <ms>', 'poll interval in milliseconds', '3000')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln watch --id 42'),
        helpExample('iln watch --id 42 --interval 5000'),
        '',
        helpSection('Tips:'),
        helpExample('Exits automatically once the invoice reaches Paid, Defaulted, or Disputed.'),
        helpExample('Press Ctrl-C to stop watching early.'),
        '',
        helpSection('See also:'),
        helpExample('iln status --id <id>    One-shot status check'),
      ].join('\n')
    )
    .action(async (options: { id: string; interval: string }) => {
      const invoiceId = parseInvoiceId(options.id);
      const intervalMs = Math.max(1000, parseInt(options.interval, 10) || 3000);
      const client = createClient(load());
      const globalOpts = program.opts() as { json?: boolean; quiet?: boolean };
      const TERMINAL = new Set(['Paid', 'Defaulted', 'Disputed']);

      let lastStatus: string | undefined;

      const print = (invoice: Invoice) => {
        const ts = new Date().toISOString();
        if (globalOpts.json) {
          stdout.write(
            JSON.stringify({ ts, invoiceId: invoice.id.toString(), status: invoice.status }) + '\n'
          );
        } else {
          ui.info(`[${ts}] Invoice ${invoice.id} — ${invoice.status}`);
        }
      };

      if (!globalOpts.quiet && !globalOpts.json) {
        ui.info(pc.bold(`Watching invoice ${invoiceId} (Ctrl-C to stop)...`));
      }

      await new Promise<void>((resolve) => {
        let stopped = false;
        let timer: ReturnType<typeof setInterval> | undefined;

        const finish = () => {
          if (stopped) return;
          stopped = true;
          if (timer) clearInterval(timer);
          process.off('SIGINT', onSigint);
          resolve();
        };

        const onSigint = () => {
          if (!globalOpts.quiet && !globalOpts.json) {
            ui.info('\nStopped watching.');
          }
          finish();
        };

        const poll = async () => {
          try {
            const invoice = await client.getInvoice(invoiceId);
            if (invoice.status !== lastStatus) {
              print(invoice);
              lastStatus = invoice.status;
            }
            if (TERMINAL.has(invoice.status)) {
              if (!globalOpts.json) {
                ui.success(`Invoice reached terminal state: ${invoice.status}`);
              }
              finish();
            }
          } catch (err: any) {
            ui.error(err?.message ?? String(err));
          }
        };

        process.on('SIGINT', onSigint);
        void poll().then(() => {
          if (!stopped) {
            timer = setInterval(poll, intervalMs);
          }
        });
      });
    });

  program
    .command('export')
    .description('Export invoices to CSV.')
    .option('--address <address>', 'filter by freelancer, payer, or funder address')
    .option('--output <file>', 'output file path; use - for stdout', 'invoices.csv')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln export --output invoices.csv'),
        helpExample('iln export --address GABC... --output -'),
        '',
        helpSection('See also:'),
        helpExample('iln list --address <G>  List invoices without exporting'),
      ].join('\n')
    )
    .action(async (options: { address?: string; output: string }) => {
      if (options.address) {
        assertStellarAddress(options.address, 'address');
      }

      const client = createClient(load());
      const progress = cliProgressOptions(program, stdout);
      const invoices = await withSpinner(
        'Fetching invoices…',
        () => fetchInvoicesForExport(client, options.address),
        progress,
        'Invoices loaded'
      );

      const header = 'id,freelancer,payer,amount,discountRate,dueDate,status,funder,fundedAt';
      const rows = invoices.map((inv) =>
        [
          csvCell(inv.id.toString()),
          csvCell(inv.freelancer),
          csvCell(inv.payer),
          csvCell(inv.amount.toString()),
          csvCell(inv.discountRate),
          csvCell(inv.dueDate),
          csvCell(inv.status),
          csvCell(inv.funder ?? ''),
          csvCell(inv.fundedAt ?? ''),
        ].join(',')
      );
      const csv = [header, ...rows].join('\n');

      if (options.output === '-') {
        stdout.write(csv + '\n');
      } else {
        fs.writeFileSync(options.output, csv, 'utf8');
        ui.success(`Exported ${invoices.length} invoice(s) to ${options.output}`);
      }
    });

  program
    .command('stats')
    .description('Show protocol-wide analytics: total invoices, funded, paid, and volume.')
    .option('--api-url <url>', 'override the analytics API base URL')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln stats'),
        helpExample('iln stats --api-url https://api.iln.network'),
      ].join('\n')
    )
    .action(async (options: { apiUrl?: string }) => {
      const config = load();
      const { AnalyticsSDK } = await import('@iln/sdk');
      const baseUrl =
        options.apiUrl ??
        (config.network === 'mainnet' ? 'https://api.iln.network' : 'http://localhost:3001');
      const api = new AnalyticsSDK(baseUrl);

      const progress = cliProgressOptions(program, stdout);
      const stats = await withSpinner(
        'Fetching protocol stats…',
        () => api.getProtocolStats(),
        progress,
        'Stats loaded'
      );

      const globalOpts = program.opts() as { json?: boolean };
      ui.info(
        globalOpts.json
          ? formatJsonSuccess(JSON.parse(formatProtocolStatsJson(stats)))
          : formatProtocolStats(stats)
      );
    });

  // Reputation command
  const reputationCommand = program
    .command('reputation')
    .description('Query on-chain reputation scores.');

  reputationCommand
    .command('get [address]')
    .description(
      'Get the reputation score of a Stellar address (defaults to the configured signer).'
    )
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln reputation get GABC...'),
        helpExample("iln reputation get   (uses the configured signer's address)"),
      ].join('\n')
    )
    .action(async (address: string | undefined) => {
      const config = load();
      const client = createClient(config);

      let targetAddress = address;
      if (!targetAddress) {
        const signer = createKeypairFileSigner(config.keypairPath);
        targetAddress = await signer.getPublicKey();
      }
      assertStellarAddress(targetAddress, 'address');

      const progress = cliProgressOptions(program, stdout);
      const score = await withSpinner(
        'Fetching reputation…',
        () => client.getReputation(targetAddress!),
        progress,
        'Reputation loaded'
      );

      const globalOpts = program.opts() as { json?: boolean };
      ui.info(
        globalOpts.json
          ? formatJsonSuccess(JSON.parse(formatReputationJson(targetAddress, score)))
          : formatReputation(targetAddress, score)
      );
    });

  // Network command
  const networkCommand = program
    .command('network')
    .description('Manage the active Stellar network.');

  networkCommand
    .command('switch <target>')
    .description(
      'Switch the active network (testnet, mainnet, or standalone) in the local config file.'
    )
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln network switch mainnet'),
        helpExample('iln network switch testnet'),
        '',
        helpSection('Tips:'),
        helpExample('Writes to .ilnrc.json, creating it if none exists.'),
        helpExample(
          "Clears any explicit `rpcUrl` override so the new network's default RPC endpoint applies."
        ),
        '',
        helpSection('See also:'),
        helpExample('iln config show   View the resolved configuration for the current directory'),
      ].join('\n')
    )
    .action((target: string) => {
      if (target !== 'testnet' && target !== 'mainnet' && target !== 'standalone') {
        throw new Error('Unsupported network. Choose one of: "testnet", "mainnet", "standalone".');
      }

      const cwd = process.cwd();
      const { rawConfig } = readRawConfig(cwd);
      rawConfig.network = target;
      delete rawConfig.rpcUrl;
      const filePath = writeRawConfig(cwd, rawConfig);

      const globalOpts = program.opts() as { json?: boolean };
      if (globalOpts.json) {
        stdout.write(formatJsonSuccess({ network: target }) + '\n');
      } else {
        ui.success(`Active network switched to ${target}.`);
        ui.info(`Saved to ${filePath}`);
      }
    });

  // Compatibility check command
  const compatCommand = program
    .command('compat')
    .description('SDK and contract compatibility utilities');

  compatCommand
    .command('check')
    .description('Check SDK compatibility with the deployed contract version.')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln compat check'),
        '',
        helpSection('Tips:'),
        helpExample('Run this after updating the SDK or redeploying the contract.'),
        helpExample('A failed check means the SDK version does not match the on-chain contract.'),
        '',
        helpSection('See also:'),
        helpExample('iln config   Show live protocol parameters from the contract'),
      ].join('\n')
    )
    .action(async () => {
      const config = load();
      const client = createClient(config);

      const globalOpts = program.opts() as { json?: boolean };

      const progress = cliProgressOptions(program, stdout);
      const result = await withSpinner(
        'Checking contract compatibility…',
        () =>
          checkCompatibility(async (method: string) => {
            if (method === 'get_version') {
              return client.getVersion();
            }
            throw new Error(`Unsupported compatibility check invoke method: ${method}`);
          }),
        progress,
        'Compatibility check complete'
      );

      if (globalOpts.json) {
        stdout.write(JSON.stringify(result, null, 2) + '\n');
        if (!result.compatible) {
          throw new Error('Compatibility check failed.');
        }
        return;
      }

      ui.info(`SDK Version:      ${result.sdkVersion}`);
      ui.info(`Contract Version: ${result.contractVersion}`);

      if (result.compatible) {
        ui.success(
          'Compatibility check passed! The SDK is fully compatible with the deployed contract.'
        );
      } else {
        ui.error('Compatibility check failed!');
        result.issues.forEach((issue) => {
          ui.error(` - ${issue}`);
        });
        throw new Error('Compatibility check failed.');
      }
    });

  program
    .command('protocol-config')
    .description('Show live protocol configuration from the ILN contract.')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln config'),
        helpExample('iln config   (shows min amount, max rate, fee, reputation thresholds)'),
        '',
        helpSection('See also:'),
        helpExample('iln compat check   Verify SDK and contract versions are compatible'),
      ].join('\n')
    )
    .action(async () => {
      const client = createClient(load());
      const progress = cliProgressOptions(program, stdout);
      const config = await withSpinner(
        'Fetching protocol configuration…',
        () => client.getProtocolConfig(),
        progress,
        'Protocol config loaded'
      );
      const globalOpts = program.opts() as { json?: boolean };
      ui.info(
        globalOpts.json
          ? formatJsonSuccess(JSON.parse(formatProtocolConfigJson(config)))
          : formatProtocolConfig(config)
      );
    });

  // Config file management
  const configCommand = program
    .command('config')
    .description('Manage the local ILN config file (.ilnrc.json).');

  configCommand
    .command('init')
    .description('Generate a starter .ilnrc.json config file in the current directory.')
    .option(
      '--cwd <dir>',
      'directory to write the config file into (defaults to current directory)'
    )
    .action((options: { cwd?: string }) => {
      const targetCwd = options.cwd ?? process.cwd();
      const created = initConfig(targetCwd);
      ui.success(`Created ${created}`);
      ui.info('Edit the file to set your contract IDs and keypair path, then run any iln command.');
    });

  configCommand
    .command('show')
    .description('Show the resolved configuration that would be used for the current directory.')
    .action(() => {
      const config = load();
      const globalOpts = program.opts() as { json?: boolean };
      if (globalOpts.json) {
        ui.info(formatJsonSuccess(config));
      } else {
        ui.info(describeConfig(config));
        ui.info(`  keypairPath  ${config.keypairPath}`);
        if (config.tokenId) {
          ui.info(`  tokenId      ${config.tokenId}`);
        }
      }
    });

  const xdrCommand = program.command('xdr').description('Inspect Soroban XDR values');

  xdrCommand
    .command('decode')
    .description('Decode a base64 Soroban ScVal XDR value.')
    .argument('[base64]', 'base64-encoded ScVal XDR')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln xdr decode AAAAAQAAAAA='),
        helpExample('iln xdr decode "$(stellar contract invoke ... 2>&1 | grep XDR)"'),
        '',
        helpSection('Tips:'),
        helpExample('Does not require a configured keypair or network connection.'),
        helpExample(
          'Useful for inspecting raw contract return values from Horizon or RPC responses.'
        ),
      ].join('\n')
    )
    .action((base64?: string) => {
      if (!base64) {
        throw new Error('Missing base64 ScVal XDR. Usage: iln xdr decode <base64>');
      }

      stdout.write(formatDecodedScVal(decodeScValXdr(base64)));
    });

  // Dashboard command
  program
    .command('dashboard')
    .description('Launch the real-time dashboard for monitoring invoice activity.')
    .option('--refresh <ms>', 'Refresh interval in milliseconds', '5000')
    .option('--export <file>', 'Export dashboard data to JSON file')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln dashboard'),
        helpExample('iln dashboard --refresh 10000   (refresh every 10 seconds)'),
        helpExample('iln dashboard --export snapshot.json   (export data and exit)'),
        '',
        helpSection('Tips:'),
        helpExample('Press q or Ctrl-C to exit the dashboard.'),
        helpExample('Use --export to capture a point-in-time snapshot for reporting.'),
      ].join('\n')
    )
    .action(async (options: { refresh: string; export?: string }) => {
      const config = load();
      const client = createClient(config);
      const { runDashboard } = await import('./dashboard');

      if (options.export) {
        const { Dashboard } = await import('./dashboard');
        const dashboard = new Dashboard(client, config, {
          refreshIntervalMs: parseInt(options.refresh, 10),
        });
        // Quick refresh and export
        await dashboard['refresh']();
        const data = dashboard.exportData();
        const fs = await import('fs');
        fs.writeFileSync(options.export, JSON.stringify(data, null, 2));
        ui.success(`Dashboard data exported to ${options.export}`);
      } else {
        await runDashboard(client, config, {
          refreshIntervalMs: parseInt(options.refresh, 10),
        });
      }
    });

  // Generate command — template system for boilerplate code
  const collectVars = (val: string, prev: string[]): string[] => [...prev, val];

  program
    .command('generate')
    .description('Generate boilerplate code from a built-in or custom template.')
    .argument('[template]', 'template name (omit or use --list to see available templates)')
    .option('--list', 'list available templates and exit')
    .option('--preview', 'print generated output without writing to disk')
    .option('--out <dir>', 'output directory (default: current directory)', '.')
    .option(
      '--var <key=value>',
      'set a template variable, repeatable (e.g. --var contractId=C…)',
      collectVars,
      [] as string[]
    )
    .action(
      async (
        template: string | undefined,
        options: { list?: boolean; preview?: boolean; out: string; var: string[] }
      ) => {
        const { generate, listTemplates } = await import('./generate');

        if (options.list || !template) {
          const templates = listTemplates();
          ui.info('Available templates:\n');
          for (const t of templates) {
            ui.info(`  ${t.name.padEnd(24)} ${t.description}`);
          }
          if (!template && !options.list) {
            ui.info('\nUsage: iln generate <template> [--var key=value] [--preview] [--out <dir>]');
          }
          return;
        }

        const vars: Record<string, string> = {};
        for (const assignment of options.var) {
          const eq = assignment.indexOf('=');
          if (eq !== -1) vars[assignment.slice(0, eq)] = assignment.slice(eq + 1);
        }

        const result = generate({
          template,
          vars,
          outDir: options.out,
          preview: options.preview,
        });

        if (options.preview) {
          ui.info(`--- Preview: ${result.outputFile} ---\n`);
          stdout.write(result.content);
        } else {
          ui.success(`Generated ${result.outputFile}`);
        }
      }
    );

  // Development commands
  const devCommand = program.command('dev').description('Development utilities');

  devCommand
    .command('start')
    .description(
      'Start a local Stellar node, deploy contracts, fund accounts, and write .env.local.'
    )
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln dev start'),
        '',
        helpSection('Tips:'),
        helpExample('Requires Docker. Pulls stellar/quickstart:testing on first run.'),
        helpExample('Writes .env.local with contract IDs and funded keypairs.'),
        '',
        helpSection('See also:'),
        helpExample('iln dev seed   Create testnet accounts after starting the environment'),
        helpExample('iln dev stop   Stop the local node when you are done'),
      ].join('\n')
    )
    .action(async () => {
      await createDevEnvironment(ui).start();
    });

  devCommand
    .command('stop')
    .description('Stop and remove the local Stellar node container.')
    .action(async () => {
      await createDevEnvironment(ui).stop();
    });

  devCommand
    .command('reset')
    .description('Stop, clear local state, and start a fresh local environment.')
    .action(async () => {
      await createDevEnvironment(ui).reset();
    });

  devCommand
    .command('status')
    .description('Show local node, contract, and account environment status.')
    .option('--json', 'output machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      await createDevEnvironment(ui).status({ json: options.json });
    });

  devCommand
    .command('seed')
    .description('Create and fund testnet accounts with USDC/EURC trustlines for development.')
    .option('--scenario <type>', 'seeding scenario: new-user, active-lp, disputed')
    .option('--count <n>', 'number of records to seed per scenario', '1')
    .option('--token <symbol>', 'specific token to use: USDC or EURC')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln dev seed'),
        helpExample('iln dev seed --scenario active-lp --count 3 --token USDC'),
        '',
        helpSection('Tips:'),
        helpExample('Saves keypairs to .env.testnet.accounts for use in other commands.'),
        helpExample('Use --scenario new-user to get a blank freelancer + payer pair.'),
        helpExample('Use --scenario active-lp to pre-fund invoices for LP testing.'),
        '',
        helpSection('See also:'),
        helpExample('iln dev start   Start the local environment before seeding'),
      ].join('\n')
    )
    .action(async (options: { scenario?: string; count?: string; token?: string }) => {
      const config = load();
      const seeder = new TestnetAccountSeeder({ config, ui });
      const count = parseInt(options.count ?? '1', 10);
      if (isNaN(count) || count <= 0) {
        throw new Error('--count must be a positive integer');
      }
      await seeder.seed({ scenario: options.scenario, count, token: options.token });
    });

  // Version management commands
  program
    .command('update')
    .description('Check for and install CLI updates.')
    .argument('[version]', 'target version to install')
    .action(async (version?: string) => {
      await versionManager.performUpdate(version);
    });

  program
    .command('changelog')
    .description('Show the changelog for the installed or specified version.')
    .argument('[version]', 'version to show changelog for')
    .action(async (version?: string) => {
      await versionManager.showChangelog(version);
    });
  // Wallet management commands
  const walletCommand = program
    .command('wallet')
    .description('Manage Stellar keypairs for use with ILN.');

  walletCommand
    .command('create')
    .description('Generate a new Stellar keypair and store it encrypted.')
    .requiredOption('--name <name>', 'wallet name identifier')
    .requiredOption('--password <password>', 'encryption password for the wallet')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln wallet create --name my-wallet --password "my-secret"'),
        '',
        helpSection('Tips:'),
        helpExample('Wallets are stored encrypted at ~/.iln/wallets/.'),
        helpExample('Use a strong password to protect your keypair.'),
        '',
        helpSection('See also:'),
        helpExample('iln wallet list       List all stored wallets'),
        helpExample('iln wallet import     Import an existing secret key'),
      ].join('\n')
    )
    .action((options: { name: string; password: string }) => {
      const wallet = createWallet(options.name, options.password);
      ui.success(`Created wallet '${wallet.name}'`);
      ui.info(`Public key: ${wallet.publicKey}`);
      ui.info(`Created at: ${wallet.createdAt}`);
    });

  walletCommand
    .command('import')
    .description('Import an existing Stellar secret key into an encrypted wallet.')
    .requiredOption('--name <name>', 'wallet name identifier')
    .requiredOption('--secret <secret>', 'Stellar secret key (starts with S)')
    .requiredOption('--password <password>', 'encryption password for the wallet')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln wallet import --name my-wallet --secret SABC... --password "my-secret"'),
        '',
        helpSection('Tips:'),
        helpExample('The secret key is validated before import.'),
        helpExample('Use a strong password to protect your keypair.'),
        '',
        helpSection('See also:'),
        helpExample('iln wallet list       List all stored wallets'),
        helpExample('iln wallet create     Generate a new keypair'),
      ].join('\n')
    )
    .action((options: { name: string; secret: string; password: string }) => {
      const wallet = importWallet(options.name, options.secret, options.password);
      ui.success(`Imported wallet '${wallet.name}'`);
      ui.info(`Public key: ${wallet.publicKey}`);
      ui.info(`Created at: ${wallet.createdAt}`);
    });

  walletCommand
    .command('list')
    .description('List all stored wallets.')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln wallet list'),
        '',
        helpSection('See also:'),
        helpExample('iln wallet create     Generate a new keypair'),
        helpExample('iln wallet import     Import an existing secret key'),
      ].join('\n')
    )
    .option('--json', 'output machine-readable JSON')
    .action((options: { json?: boolean }) => {
      const wallets = listWallets();
      if (wallets.length === 0) {
        if (options.json) {
          ui.info(formatJsonSuccess([]));
        } else {
          ui.info("No wallets found. Use 'iln wallet create' or 'iln wallet import' to add one.");
        }
        return;
      }

      if (options.json) {
        ui.info(formatJsonSuccess(wallets));
        return;
      }

      ui.info('Stored wallets:\n');
      for (const wallet of wallets) {
        ui.info(`  ${wallet.name}`);
        ui.info(`    Public key: ${wallet.publicKey}`);
        ui.info(`    Created: ${wallet.createdAt}`);
        ui.info('');
      }
    });

  walletCommand
    .command('fund')
    .description('Fund a wallet from Stellar Friendbot (testnet only).')
    .requiredOption('--name <name>', 'wallet name to fund')
    .requiredOption('--password <password>', 'encryption password for the wallet')
    .option('--friendbot <url>', 'Friendbot URL', 'https://friendbot.stellar.org')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln wallet fund --name my-wallet --password "my-secret"'),
        '',
        helpSection('Tips:'),
        helpExample('Only works on testnet. Requires the wallet to exist.'),
        helpExample("Funds are sent to the wallet's public key."),
        '',
        helpSection('See also:'),
        helpExample('iln wallet list       List all stored wallets'),
      ].join('\n')
    )
    .action(async (options: { name: string; password: string; friendbot?: string }) => {
      const wallets = listWallets();
      const wallet = wallets.find((w) => w.name === options.name);
      if (!wallet) {
        throw new Error(`Wallet '${options.name}' not found.`);
      }

      const progress = cliProgressOptions(program, stdout);
      await withSpinner(
        `Funding wallet '${options.name}'…`,
        () => fundWalletFromFriendbot(wallet.publicKey, options.friendbot),
        progress
      );
      ui.success(`Successfully funded wallet '${options.name}'`);
    });

  walletCommand
    .command('delete')
    .description('Delete a stored wallet.')
    .requiredOption('--name <name>', 'wallet name to delete')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln wallet delete --name my-wallet'),
        '',
        helpSection('Tips:'),
        helpExample('This action cannot be undone. Make sure you have backed up your secret key.'),
        '',
        helpSection('See also:'),
        helpExample('iln wallet list       List all stored wallets'),
      ].join('\n')
    )
    .action((options: { name: string }) => {
      deleteWallet(options.name);
      ui.success(`Deleted wallet '${options.name}'`);
    });

  // Interactive mode
  program
    .command('interactive')
    .description('Start an interactive guided session for invoice operations.')
    .action(async () => {
      const config = load();
      const client = createClient(config);
      await runInteractive({ client, config, ui });
    });

  // Tutorial mode
  program
    .command('tutorial')
    .description('Step-by-step guided tutorial for submitting your first invoice.')
    .addHelpText(
      'after',
      [
        '',
        helpSection('About:'),
        helpExample('Walks you through each field with explanations at every step.'),
        helpExample('Progress is saved so you can resume if interrupted.'),
        helpExample("Type 'skip' at any prompt to exit and save your progress."),
        '',
        helpSection('Examples:'),
        helpExample('iln tutorial              (start or resume the tutorial)'),
        '',
        helpSection('See also:'),
        helpExample('iln interactive           Full interactive mode without explanations'),
        helpExample('iln submit --help         Reference for the submit command'),
      ].join('\n')
    )
    .action(async () => {
      const config = load();
      const client = createClient(config);
      await runTutorial({ client, config, ui });
    });

  program
    .command('man')
    .description('Print a roff man page for iln or a subcommand.')
    .argument('[command]', 'subcommand to document, e.g. submit, fund, pay')
    .addHelpText(
      'after',
      [
        '',
        helpSection('Examples:'),
        helpExample('iln man                  (top-level man page)'),
        helpExample('iln man submit           (man page for the submit command)'),
        helpExample('iln man | man -l -       (view in terminal man pager)'),
        helpExample('iln man submit > iln-submit.1  (save to file)'),
      ].join('\n')
    )
    .action((commandName?: string) => {
      stdout.write(generateManPage(program, commandName));
    });

  // Alias management commands
  const aliasCommand = program.command('alias').description('Manage CLI command aliases');

  aliasCommand
    .command('list')
    .description('List all configured aliases')
    .option('--json', 'output machine-readable JSON')
    .action((options: { json?: boolean }) => {
      if (options.json) {
        ui.info(
          formatJsonSuccess({
            builtin: { s: 'submit', f: 'fund', p: 'pay' },
            custom: customAliases,
          })
        );
        return;
      }
      ui.info('Built-in aliases:');
      ui.info('  s → submit');
      ui.info('  f → fund');
      ui.info('  p → pay');
      ui.info('');
      ui.info('Custom aliases:');
      if (Object.keys(customAliases).length === 0) {
        ui.info('  (none)');
      } else {
        for (const [alias, command] of Object.entries(customAliases)) {
          ui.info(`  ${alias} → ${command}`);
        }
      }
    });

  aliasCommand
    .command('add')
    .description('Add a new custom alias')
    .argument('<alias>', 'Alias name')
    .argument('<command>', 'Command to alias')
    .action((alias: string, command: string) => {
      const cwd = process.cwd();
      const { rawConfig } = readRawConfig(cwd);
      if (!rawConfig.aliases) {
        rawConfig.aliases = {};
      }
      rawConfig.aliases[alias] = command;
      const filePath = writeRawConfig(cwd, rawConfig);
      ui.success(`Added alias: ${alias} → ${command}`);
      ui.info(`Saved to ${filePath}`);
    });

  aliasCommand
    .command('remove')
    .alias('rm')
    .description('Remove a custom alias')
    .argument('<alias>', 'Alias name to remove')
    .action((alias: string) => {
      const cwd = process.cwd();
      const { rawConfig } = readRawConfig(cwd);
      if (rawConfig.aliases && rawConfig.aliases[alias]) {
        delete rawConfig.aliases[alias];
        const filePath = writeRawConfig(cwd, rawConfig);
        ui.success(`Removed alias: ${alias}`);
        ui.info(`Saved to ${filePath}`);
      } else {
        ui.error(`Alias not found: ${alias}`);
      }
    });

  try {
    if (dependencies.__returnProgramForDocs) {
      return program;
    }
    await program.parseAsync(resolvedArgv, { from: 'user' });
    return 0;
  } catch (error: any) {
    // commander's .exitOverride() converts informational exits (--help,
    // --version) into thrown CommanderError instances with exitCode 0.
    // Treat those as success instead of printing them as errors.
    if (typeof error?.exitCode === 'number' && error.exitCode === 0) {
      return 0;
    }
    const isJson = program.opts().json;
    if (isJson) {
      if (isStructuredError(error)) {
        stdout.write(
          JSON.stringify(
            {
              success: false,
              error: error.message,
              code: error.code,
              remediation: error.remediation,
              docsUrl: error.docsUrl,
            },
            null,
            2
          ) + '\n'
        );
      } else {
        stdout.write(formatJsonError(formatUnknownError(error)) + '\n');
      }
    } else if (isStructuredError(error)) {
      const hyperlinks = Boolean((stderr as NodeJS.WriteStream).isTTY);
      stderr.write(formatILNError(error, { hyperlinks }) + '\n');
    } else {
      ui.error(formatUnknownError(error));
    }
    return 1;
  }
}

export async function main(): Promise<void> {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    const onData = (chunk: string) => {
      data += chunk;
    };
    const onEnd = () => {
      cleanup();
      resolve(data.trim());
    };
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      clearTimeout(timeoutId);
    };
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve(data.trim());
    }, 1000);

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
  });
}

async function resolveIdFromStdin(optionId?: string): Promise<string | undefined> {
  if (optionId && optionId !== '-') {
    return optionId;
  }
  const stdinVal = await readStdin();
  if (!stdinVal) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(stdinVal);
    const idVal = parsed.invoiceId ?? parsed.id;
    if (idVal !== undefined) {
      return String(idVal);
    }
  } catch {
    // Treat as raw text ID
  }
  return stdinVal;
}

function cliProgressOptions(program: Command, stdout: NodeJS.WritableStream): ProgressOptions {
  const opts = program.opts() as { quiet?: boolean; json?: boolean };
  if (opts.quiet || opts.json) {
    return { output: stdout, enabled: false };
  }
  return { output: stdout };
}

async function fetchInvoicesForExport(
  client: Pick<ILNClient, 'getInvoiceCount' | 'getInvoice' | 'listInvoicesByAddress'>,
  address?: string
): Promise<Invoice[]> {
  if (address) {
    return client.listInvoicesByAddress(address);
  }

  const count = await client.getInvoiceCount();
  const invoices: Invoice[] = [];
  for (let i = 1n; i <= count; i += 1n) {
    try {
      invoices.push(await client.getInvoice(i));
    } catch {
      // Skip failed/non-existent indexes
    }
  }
  return invoices;
}

/** Quote one RFC 4180 CSV field and neutralize spreadsheet formula prefixes. */
function csvCell(value: string | number | bigint): string {
  let cell = String(value);
  if (/^[\u0000-\u0020]*[=+@-]/.test(cell)) {
    cell = `'${cell}`;
  }
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

function parseInvoiceId(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error('Invoice ID must be a positive integer.');
  }

  return BigInt(value);
}

function parseBasisPoints(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error('Discount rate must be an integer basis-point value.');
  }

  return Number(value);
}

function assertStellarAddress(value: string, field: string): void {
  if (!StrKey.isValidEd25519PublicKey(value)) {
    throw new Error(`Invalid ${field} address: ${value}`);
  }
}

function assertContractId(value: string, field: string): void {
  try {
    Address.fromString(value);
  } catch {
    throw new Error(`Invalid ${field} contract ID: ${value}`);
  }
}
