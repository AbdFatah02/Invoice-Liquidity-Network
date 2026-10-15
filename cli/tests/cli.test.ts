import { Keypair } from '@stellar/stellar-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { describe, expect, it, vi, afterEach } from 'vitest';

import * as sdk from '@iln/sdk';
import * as devSeedModule from '../src/dev-seed';
import { runCli } from '../src/cli';
import type { Invoice, ListedInvoice, ResolvedConfig } from '../src/types';

afterEach(() => {
  vi.restoreAllMocks();
});

const TEST_CONFIG: ResolvedConfig = {
  contractId: validAddress('C'),
  keypairPath: '/tmp/iln.secret',
  network: 'testnet',
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  tokenId: validAddress('T'),
};

describe('runCli', () => {
  it('submits an invoice using config token fallback', async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const client = {
      submitInvoice: vi.fn().mockResolvedValue({ invoiceId: 42n, txHash: 'abc123' }),
    };

    const exitCode = await runCli(
      [
        'submit',
        '--payer',
        validAddress(),
        '--amount',
        '100',
        '--due',
        '2025-12-31',
        '--rate',
        '300',
      ],
      {
        createClient: () => client as any,
        loadConfig: () => TEST_CONFIG,
        stderr,
        stdout,
      }
    );

    expect(exitCode).toBe(0);
    expect(client.submitInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 1_000_000_000n,
        discountRate: 300,
        tokenId: TEST_CONFIG.tokenId,
      })
    );
    expect(stdout.toString()).toContain('Submitted invoice 42');
    expect(stderr.toString()).toBe('');
  });

  it('auto-funds the remaining balance when amount is omitted', async () => {
    const stdout = createMemoryStream();
    const client = {
      fundInvoice: vi.fn().mockResolvedValue({ hash: 'tx-hash' }),
    };

    const exitCode = await runCli(['fund', '--id', '7'], {
      createClient: () => client as any,
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(client.fundInvoice).toHaveBeenCalledWith(7n, undefined);
    expect(stdout.toString()).toContain('Funded invoice 7');
  });

  it('prints invoice status details', async () => {
    const stdout = createMemoryStream();
    const invoice: Invoice = {
      amount: 1_000_000_000n,
      amountFunded: 250_000_000n,
      discountRate: 300,
      dueDate: 1_767_225_599,
      freelancer: validAddress(),
      fundedAt: null,
      funder: null,
      id: 3n,
      payer: validAddress('B'),
      status: 'Pending',
      token: 'CTOKEN',
    };
    const client = {
      getInvoice: vi.fn().mockResolvedValue(invoice),
    };

    const exitCode = await runCli(['status', '--id', '3'], {
      createClient: () => client as any,
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stdout.toString()).toContain('Status');
    expect(stdout.toString()).toContain('Pending');
  });

  it('lists invoices for an address', async () => {
    const stdout = createMemoryStream();
    const client = {
      listInvoicesByAddress: vi
        .fn()
        .mockResolvedValue([
          createListedInvoice({ id: 1n, role: 'freelancer', status: 'Pending' }),
          createListedInvoice({ id: 2n, role: 'payer', status: 'Funded' }),
        ]),
    };

    const exitCode = await runCli(['list', '--address', validAddress()], {
      createClient: () => client as any,
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stdout.toString()).toContain('ID');
    expect(stdout.toString()).toContain('freelancer');
    expect(stdout.toString()).toContain('Funded');
  });

  it('prints live protocol configuration', async () => {
    const stdout = createMemoryStream();
    const client = {
      getProtocolConfig: vi.fn().mockResolvedValue({
        minInvoiceAmount: 10_000_000n,
        maxDiscountRate: 2_000,
        protocolFeeBps: 250,
        minPayerReputation: 70,
        decayRateBps: 25,
      }),
    };

    const exitCode = await runCli(['protocol-config'], {
      createClient: () => client as any,
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(client.getProtocolConfig).toHaveBeenCalledTimes(1);
    expect(stdout.toString()).toContain('Min Amount');
    expect(stdout.toString()).toContain('10000000');
    expect(stdout.toString()).toContain('Fee');
  });

  it('prints actionable errors', async () => {
    const stderr = createMemoryStream();

    const exitCode = await runCli(
      ['submit', '--payer', 'not-a-key', '--amount', '100', '--due', '2025-12-31', '--rate', '300'],
      {
        createClient: () => ({} as any),
        loadConfig: () => TEST_CONFIG,
        stderr,
        stdout: createMemoryStream(),
      }
    );

    expect(exitCode).toBe(1);
    expect(stderr.toString()).toContain('Invalid payer address');
  });

  it('marks an invoice as paid', async () => {
    const stdout = createMemoryStream();
    const client = {
      markPaid: vi.fn().mockResolvedValue({ hash: 'paid-hash' }),
    };

    const exitCode = await runCli(['pay', '--id', '42'], {
      createClient: () => client as any,
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(client.markPaid).toHaveBeenCalledWith(42n);
    expect(stdout.toString()).toContain('Marked invoice 42 as paid in transaction paid-hash.');
  });

  it('filters history by action, id, limit, and format json', async () => {
    const stdout = createMemoryStream();
    const invoices = [
      createListedInvoice({ id: 1n, role: 'freelancer', status: 'Pending' }),
      createListedInvoice({ id: 2n, role: 'funder', status: 'Funded' }),
      createListedInvoice({ id: 3n, role: 'payer', status: 'Paid' }),
    ];
    const client = {
      listInvoicesByAddress: vi.fn().mockResolvedValue(invoices),
    };

    const exitCode = await runCli(
      [
        'history',
        '--address',
        validAddress(),
        '--action',
        'pay',
        '--id',
        '3',
        '--limit',
        '1',
        '--format',
        'json',
      ],
      {
        createClient: () => client as any,
        loadConfig: () => TEST_CONFIG,
        stderr: createMemoryStream(),
        stdout,
      }
    );

    expect(exitCode).toBe(0);
    expect(client.listInvoicesByAddress).toHaveBeenCalledWith(expect.any(String));
    // The preAction hook writes a "Using ..." banner to stdout before the JSON.
    // Slice from the first '[' to parse only the JSON array.
    const raw = stdout.toString();
    const output = JSON.parse(raw.slice(raw.indexOf('[')));
    expect(output).toHaveLength(1);
    expect(output[0].id).toBe('3');
    expect(output[0].action).toBe('pay');
  });

  it('rejects invalid history limits and action values', async () => {
    const stderr = createMemoryStream();

    const invalidLimit = await runCli(['history', '--address', validAddress(), '--limit', '0'], {
      createClient: () => ({ listInvoicesByAddress: vi.fn().mockResolvedValue([]) } as any),
      loadConfig: () => TEST_CONFIG,
      stderr,
      stdout: createMemoryStream(),
    });

    expect(invalidLimit).toBe(1);
    expect(stderr.toString()).toContain('--limit must be a positive integer');

    const stderr2 = createMemoryStream();
    const invalidAction = await runCli(
      ['history', '--address', validAddress(), '--action', 'unknown'],
      {
        createClient: () => ({ listInvoicesByAddress: vi.fn().mockResolvedValue([]) } as any),
        loadConfig: () => TEST_CONFIG,
        stderr: stderr2,
        stdout: createMemoryStream(),
      }
    );

    expect(invalidAction).toBe(1);
    expect(stderr2.toString()).toContain('--action must be one of');
  });

  it('fails submit when no token ID is configured and no token flag is provided', async () => {
    const stderr = createMemoryStream();

    const exitCode = await runCli(
      [
        'submit',
        '--payer',
        validAddress(),
        '--amount',
        '100',
        '--due',
        '2025-12-31',
        '--rate',
        '300',
      ],
      {
        createClient: () =>
          ({ submitInvoice: vi.fn().mockResolvedValue({ invoiceId: 1n, txHash: 'hash' }) } as any),
        loadConfig: () => ({ ...TEST_CONFIG, tokenId: undefined }),
        stderr,
        stdout: createMemoryStream(),
      }
    );

    expect(exitCode).toBe(1);
    expect(stderr.toString()).toContain('Missing token ID');
  });

  it('runs dev start, stop, and reset using the provided environment helper', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const reset = vi.fn().mockResolvedValue(undefined);
    const status = vi.fn().mockResolvedValue(undefined);
    const createDevEnvironment = vi.fn(() => ({ start, stop, reset, status }));

    await expect(
      runCli(['dev', 'start'], {
        createClient: () => ({} as any),
        createDevEnvironment,
        loadConfig: () => TEST_CONFIG,
        stderr: createMemoryStream(),
        stdout: createMemoryStream(),
      })
    ).resolves.toBe(0);

    await expect(
      runCli(['dev', 'stop'], {
        createClient: () => ({} as any),
        createDevEnvironment,
        loadConfig: () => TEST_CONFIG,
        stderr: createMemoryStream(),
        stdout: createMemoryStream(),
      })
    ).resolves.toBe(0);

    await expect(
      runCli(['dev', 'reset'], {
        createClient: () => ({} as any),
        createDevEnvironment,
        loadConfig: () => TEST_CONFIG,
        stderr: createMemoryStream(),
        stdout: createMemoryStream(),
      })
    ).resolves.toBe(0);

    expect(createDevEnvironment).toHaveBeenCalledTimes(3);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('runs local dev status without requiring ILN config', async () => {
    const stdout = createMemoryStream();
    const status = vi.fn().mockResolvedValue(undefined);
    const loadConfig = vi.fn(() => {
      throw new Error('config should not be loaded');
    });

    const exitCode = await runCli(['dev', 'status'], {
      createClient: () => ({} as any),
      createDevEnvironment: () => ({
        reset: vi.fn(),
        start: vi.fn(),
        status,
        stop: vi.fn(),
      }),
      loadConfig,
      stderr: createMemoryStream(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(status).toHaveBeenCalledTimes(1);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('decodes ScVal XDR without requiring ILN config', async () => {
    const stdout = createMemoryStream();
    const loadConfig = vi.fn(() => {
      throw new Error('config should not be loaded');
    });

    const exitCode = await runCli(
      [
        'xdr',
        'decode',
        'AAAAEQAAAAEAAAADAAAADgAAAAZhbW91bnQAAAAAAAUAAAAAO5rKAAAAAA4AAAACaWQAAAAAAAUAAAAAAAAAKgAAAA4AAAAGc3RhdHVzAAAAAAAOAAAABkZ1bmRlZAAA',
      ],
      {
        createClient: () => ({} as any),
        loadConfig,
        stderr: createMemoryStream(),
        stdout,
      }
    );

    expect(exitCode).toBe(0);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(stdout.toString()).toContain('"amount": "1000000000"');
    expect(stdout.toString()).toContain('"status": "Funded"');
  });

  it('checks SDK compatibility and passes when compatible', async () => {
    const stdout = createMemoryStream();
    const client = {
      getVersion: vi.fn().mockResolvedValue('1.0.0'),
    };
    vi.spyOn(sdk, 'checkCompatibility').mockImplementation(
      async (fn: (method: string) => Promise<unknown>) => {
        const sdkVersion = '1.0.0';
        const contractVersion = (await fn('get_version')) as string;
        return { sdkVersion, contractVersion, compatible: true, issues: [] };
      }
    );

    const exitCode = await runCli(['compat', 'check'], {
      createClient: () => client as any,
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stdout.toString()).toContain('SDK Version:      1.0.0');
    expect(stdout.toString()).toContain('Contract Version: 1.0.0');
    expect(stdout.toString()).toContain('success Compatibility check passed!');
  });

  it('fails compatibility check and prints issues', async () => {
    const stderr = createMemoryStream();
    const client = {
      getVersion: vi.fn().mockResolvedValue('2.0.0'),
    };
    vi.spyOn(sdk, 'checkCompatibility').mockImplementation(async () => {
      return {
        sdkVersion: '1.0.0',
        contractVersion: '2.0.0',
        compatible: false,
        issues: ['Method mismatch', 'Type mismatch'],
      };
    });

    const exitCode = await runCli(['compat', 'check'], {
      createClient: () => client as any,
      loadConfig: () => TEST_CONFIG,
      stderr,
      stdout: createMemoryStream(),
    });

    expect(exitCode).toBe(1);
    // Issues and failure message go to stderr via ui.error
    expect(stderr.toString()).toContain('Compatibility check failed!');
    expect(stderr.toString()).toContain('Method mismatch');
    expect(stderr.toString()).toContain('Type mismatch');
  });

  it('rejects invalid dev seed count and token values', async () => {
    const stderr = createMemoryStream();

    const exitCode = await runCli(['dev', 'seed', '--count', '0'], {
      createClient: () => ({} as any),
      loadConfig: () => TEST_CONFIG,
      stderr,
      stdout: createMemoryStream(),
    });

    expect(exitCode).toBe(1);
    expect(stderr.toString()).toContain('--count must be a positive integer');

    const stderr2 = createMemoryStream();
    const exitCode2 = await runCli(['dev', 'seed', '--token', 'INVALID'], {
      createClient: () => ({} as any),
      loadConfig: () => TEST_CONFIG,
      stderr: stderr2,
      stdout: createMemoryStream(),
    });

    expect(exitCode2).toBe(1);
    expect(stderr2.toString()).toContain('Invalid token');
  });

  it('supports submit --json formatting', async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const client = {
      submitInvoice: vi.fn().mockResolvedValue({ invoiceId: 123n, txHash: 'abc123' }),
    };

    const exitCode = await runCli(
      [
        '--json',
        'submit',
        '--payer',
        validAddress(),
        '--amount',
        '100',
        '--due',
        '2025-12-31',
        '--rate',
        '300',
      ],
      {
        createClient: () => client as any,
        loadConfig: () => TEST_CONFIG,
        stderr,
        stdout,
      }
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.toString());
    expect(parsed).toEqual({
      success: true,
      invoiceId: '123',
      txHash: 'abc123',
    });
    expect(stderr.toString()).toContain('Using testnet');
  });

  it('supports fund --json formatting', async () => {
    const stdout = createMemoryStream();
    const client = {
      fundInvoice: vi.fn().mockResolvedValue({ hash: 'tx-hash' }),
    };

    const exitCode = await runCli(['--json', 'fund', '--id', '123'], {
      createClient: () => client as any,
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.toString());
    expect(parsed).toEqual({
      success: true,
      invoiceId: '123',
      txHash: 'tx-hash',
    });
  });

  it('supports pay --json formatting', async () => {
    const stdout = createMemoryStream();
    const client = {
      markPaid: vi.fn().mockResolvedValue({ hash: 'tx-hash' }),
    };

    const exitCode = await runCli(['--json', 'pay', '--id', '123'], {
      createClient: () => client as any,
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.toString());
    expect(parsed).toEqual({
      success: true,
      invoiceId: '123',
      txHash: 'tx-hash',
    });
  });

  it('outputs protocol config in json when requested', async () => {
    const stdout = createMemoryStream();
    const client = {
      getProtocolConfig: vi.fn().mockResolvedValue({
        minInvoiceAmount: 10_000_000n,
        maxDiscountRate: 2_000,
        protocolFeeBps: 250,
        minPayerReputation: 70,
        decayRateBps: 25,
        minInvoiceDuration: 3600,
        maxInvoiceDuration: null,
        gracePeriodSeconds: null,
      }),
    };

    const exitCode = await runCli(['--json', 'protocol-config'], {
      createClient: () => client as any,
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.toString());
    expect(parsed).toEqual({
      minInvoiceAmount: '10000000',
      maxDiscountRate: 2000,
      protocolFeeBps: 250,
      minPayerReputation: 70,
      decayRateBps: 25,
      minInvoiceDuration: 3600,
      maxInvoiceDuration: null,
      gracePeriodSeconds: null,
    });
  });

  it('formats error messages as JSON when --json option is passed', async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();

    const exitCode = await runCli(['--json', 'submit', '--payer', 'invalid-address'], {
      createClient: () => ({} as any),
      loadConfig: () => TEST_CONFIG,
      stderr,
      stdout,
    });

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.toString());
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Invalid payer address');
  });

  it('pipes stdin to commands expecting invoice id', async () => {
    const stdout = createMemoryStream();
    const client = {
      fundInvoice: vi.fn().mockResolvedValue({ hash: 'tx-hash' }),
    };

    const Readable = require('node:stream').Readable;
    const mockStdin = new Readable();
    mockStdin.push('123\n');
    mockStdin.push(null);
    mockStdin.isTTY = false;

    const oldStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: mockStdin, configurable: true });

    try {
      const exitCode = await runCli(['fund'], {
        createClient: () => client as any,
        loadConfig: () => TEST_CONFIG,
        stderr: createMemoryStream(),
        stdout,
      });

      expect(exitCode).toBe(0);
      expect(client.fundInvoice).toHaveBeenCalledWith(123n, undefined);
    } finally {
      Object.defineProperty(process, 'stdin', { value: oldStdin, configurable: true });
    }
  });

  it('pipes JSON from stdin to commands expecting invoice id', async () => {
    const stdout = createMemoryStream();
    const client = {
      markPaid: vi.fn().mockResolvedValue({ hash: 'tx-hash' }),
    };

    const Readable = require('node:stream').Readable;
    const mockStdin = new Readable();
    mockStdin.push(JSON.stringify({ success: true, invoiceId: '456', txHash: 'abc' }));
    mockStdin.push(null);
    mockStdin.isTTY = false;

    const oldStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: mockStdin, configurable: true });

    try {
      const exitCode = await runCli(['pay'], {
        createClient: () => client as any,
        loadConfig: () => TEST_CONFIG,
        stderr: createMemoryStream(),
        stdout,
      });

      expect(exitCode).toBe(0);
      expect(client.markPaid).toHaveBeenCalledWith(456n);
    } finally {
      Object.defineProperty(process, 'stdin', { value: oldStdin, configurable: true });
    }
  });
});

describe('help output', () => {
  async function getHelp(args: string[]): Promise<string> {
    const stdout = createMemoryStream();
    await runCli(args, {
      createClient: () => ({} as any),
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });
    return stdout.toString();
  }

  it('program --help contains Quick tips', async () => {
    const out = await getHelp(['--help']);
    expect(out).toContain('Quick tips');
    expect(out).toContain('iln dev start');
    expect(out).toContain('iln dashboard');
  });

  it('submit --help contains Examples and See also sections', async () => {
    const out = await getHelp(['submit', '--help']);
    expect(out).toContain('Examples:');
    expect(out).toContain('--payer');
    expect(out).toContain('--amount');
    expect(out).toContain('See also:');
    expect(out).toContain('iln status');
    expect(out).toContain('iln list');
  });

  it('fund --help contains Examples and See also sections', async () => {
    const out = await getHelp(['fund', '--help']);
    expect(out).toContain('Examples:');
    expect(out).toContain('iln fund --id 42');
    expect(out).toContain('See also:');
    expect(out).toContain('iln history');
  });

  it('pay --help contains Examples, Tips, and See also sections', async () => {
    const out = await getHelp(['pay', '--help']);
    expect(out).toContain('Examples:');
    expect(out).toContain('iln pay --id 42');
    expect(out).toContain('Tips:');
    expect(out).toContain('See also:');
  });

  it('status --help contains Examples and See also sections', async () => {
    const out = await getHelp(['status', '--help']);
    expect(out).toContain('Examples:');
    expect(out).toContain('iln status --id 42');
    expect(out).toContain('See also:');
  });

  it('list --help contains Examples and See also sections', async () => {
    const out = await getHelp(['list', '--help']);
    expect(out).toContain('Examples:');
    expect(out).toContain('iln list --address');
    expect(out).toContain('See also:');
  });

  it('history --help contains Examples and See also sections', async () => {
    const out = await getHelp(['history', '--help']);
    expect(out).toContain('Examples:');
    expect(out).toContain('iln history --address');
    expect(out).toContain('--action fund');
    expect(out).toContain('See also:');
  });

  it('config --help contains Examples and See also sections', async () => {
    const out = await getHelp(['config', '--help']);
    expect(out).toContain('Examples:');
    expect(out).toContain('iln config');
    expect(out).toContain('See also:');
    expect(out).toContain('iln compat check');
  });

  it('dashboard --help contains Examples and Tips sections', async () => {
    const out = await getHelp(['dashboard', '--help']);
    expect(out).toContain('Examples:');
    expect(out).toContain('iln dashboard');
    expect(out).toContain('Tips:');
    expect(out).toContain('--refresh');
    expect(out).toContain('--export');
  });

  it('xdr decode --help contains Examples and Tips', async () => {
    const out = await getHelp(['xdr', 'decode', '--help']);
    expect(out).toContain('Examples:');
    expect(out).toContain('Tips:');
  });

  it('dev start --help contains Examples and See also', async () => {
    const out = await getHelp(['dev', 'start', '--help']);
    expect(out).toContain('Examples:');
    expect(out).toContain('iln dev start');
    expect(out).toContain('See also:');
    expect(out).toContain('iln dev seed');
  });

  it('dev seed --help contains Examples, Tips, and See also', async () => {
    const out = await getHelp(['dev', 'seed', '--help']);
    expect(out).toContain('Examples:');
    expect(out).toContain('--scenario');
    expect(out).toContain('Tips:');
    expect(out).toContain('See also:');
  });
});

describe('man command', () => {
  it('iln man outputs roff .TH header for top-level', async () => {
    const stdout = createMemoryStream();
    const exitCode = await runCli(['man'], {
      createClient: () => ({} as any),
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });
    expect(exitCode).toBe(0);
    const out = stdout.toString();
    expect(out).toContain('.TH ILN 1');
    expect(out).toContain('.SH NAME');
    expect(out).toContain('.SH SYNOPSIS');
    expect(out).toContain('.SH COMMANDS');
    expect(out).toContain('.SH EXAMPLES');
  });

  it('iln man submit outputs submit subcommand man page', async () => {
    const stdout = createMemoryStream();
    const exitCode = await runCli(['man', 'submit'], {
      createClient: () => ({} as any),
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });
    expect(exitCode).toBe(0);
    const out = stdout.toString();
    expect(out).toContain('.TH ILN-SUBMIT 1');
    // roff escapes - as \- so iln-submit → iln\-submit in the output
    expect(out).toContain('iln\\-submit');
    expect(out).toContain('payer');
    expect(out).toContain('amount');
    expect(out).toContain('rate');
  });

  it('iln man fund outputs fund subcommand man page', async () => {
    const stdout = createMemoryStream();
    await runCli(['man', 'fund'], {
      createClient: () => ({} as any),
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });
    const out = stdout.toString();
    expect(out).toContain('.TH ILN-FUND 1');
    expect(out).toContain('invoice ID');
  });

  it('iln man unknown-command outputs error message', async () => {
    const stdout = createMemoryStream();
    await runCli(['man', 'nonexistent'], {
      createClient: () => ({} as any),
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });
    expect(stdout.toString()).toContain('unknown command');
  });

  it('watch prints the current status and exits once an invoice reaches a terminal state', async () => {
    const stdout = createMemoryStream();
    const invoice: Invoice = createInvoice({ id: 9n, status: 'Paid' });
    const client = {
      getInvoice: vi.fn().mockResolvedValue(invoice),
    };

    const exitCode = await runCli(['--quiet', 'watch', '--id', '9'], {
      createClient: () => client as any,
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(client.getInvoice).toHaveBeenCalledWith(9n);
    expect(stdout.toString()).toContain('Invoice 9');
    expect(stdout.toString()).toContain('Paid');
  });

  it('exports invoices to CSV on stdout', async () => {
    const stdout = createMemoryStream();
    const client = {
      listInvoicesByAddress: vi
        .fn()
        .mockResolvedValue([
          createListedInvoice({ id: 1n, role: 'freelancer', status: 'Pending' }),
        ]),
    };

    const exitCode = await runCli(['export', '--address', validAddress(), '--output', '-'], {
      createClient: () => client as any,
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(client.listInvoicesByAddress).toHaveBeenCalledWith(expect.any(String));
    expect(stdout.toString()).toContain(
      'id,freelancer,payer,amount,discountRate,dueDate,status,funder,fundedAt'
    );
    expect(stdout.toString()).toContain('1,');
  });

  it('quotes CSV fields and neutralizes spreadsheet formulas in exported data', async () => {
    const stdout = createMemoryStream();
    const client = {
      listInvoicesByAddress: vi.fn().mockResolvedValue([
        createListedInvoice({
          id: 1n,
          role: 'freelancer',
          status: 'Pending',
          freelancer: '=HYPERLINK("https://attacker.invalid")',
          payer: 'Payer, Inc.\nSecond line',
        }),
      ]),
    };

    const exitCode = await runCli(['export', '--address', validAddress(), '--output', '-'], {
      createClient: () => client as any,
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stdout.toString()).toContain("'=HYPERLINK(\"https://attacker.invalid\")");
    expect(stdout.toString()).toContain('"Payer, Inc.\nSecond line"');
  });

  it('exports all invoices when no address filter is given', async () => {
    const stdout = createMemoryStream();
    const client = {
      getInvoiceCount: vi.fn().mockResolvedValue(2n),
      getInvoice: vi.fn().mockImplementation(async (id: bigint) => createInvoice({ id })),
    };

    const exitCode = await runCli(['export', '--output', '-'], {
      createClient: () => client as any,
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(client.getInvoiceCount).toHaveBeenCalledTimes(1);
    expect(client.getInvoice).toHaveBeenCalledTimes(2);
  });

  it('prints protocol-wide analytics from iln stats', async () => {
    const stdout = createMemoryStream();
    vi.spyOn(sdk, 'AnalyticsSDK').mockImplementation(function MockAnalyticsSDK() {
      return {
        getProtocolStats: vi.fn().mockResolvedValue({
          totalInvoices: 10n,
          totalFunded: 6n,
          totalPaid: 4n,
          totalVolume: 500_000_000n,
        }),
      } as any;
    } as any);

    const exitCode = await runCli(['stats'], {
      createClient: () => ({} as any),
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stdout.toString()).toContain('Invoices');
    expect(stdout.toString()).toContain('10');
    expect(stdout.toString()).toContain('Volume');
  });

  it('prints the reputation score for an address', async () => {
    const stdout = createMemoryStream();
    const address = validAddress();
    const client = {
      getReputation: vi.fn().mockResolvedValue(87),
    };

    const exitCode = await runCli(['reputation', 'get', address], {
      createClient: () => client as any,
      loadConfig: () => TEST_CONFIG,
      stderr: createMemoryStream(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(client.getReputation).toHaveBeenCalledWith(address);
    expect(stdout.toString()).toContain('87');
  });

  it('switches the active network and persists it to .ilnrc.json', async () => {
    const stdout = createMemoryStream();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'iln-cli-network-'));
    fs.writeFileSync(
      path.join(cwd, '.ilnrc.json'),
      JSON.stringify({ version: 2, network: 'testnet', contractIds: {}, aliases: {} }, null, 2)
    );
    const previousCwd = process.cwd();
    process.chdir(cwd);

    try {
      const exitCode = await runCli(['network', 'switch', 'mainnet'], {
        createClient: () => ({} as any),
        loadConfig: () => TEST_CONFIG,
        stderr: createMemoryStream(),
        stdout,
      });

      expect(exitCode).toBe(0);
      expect(stdout.toString()).toContain('mainnet');
      const written = JSON.parse(fs.readFileSync(path.join(cwd, '.ilnrc.json'), 'utf8'));
      expect(written.network).toBe('mainnet');
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects an unsupported network in network switch', async () => {
    const stderr = createMemoryStream();
    const exitCode = await runCli(['network', 'switch', 'devnet'], {
      createClient: () => ({} as any),
      loadConfig: () => TEST_CONFIG,
      stderr,
      stdout: createMemoryStream(),
    });

    expect(exitCode).toBe(1);
    expect(stderr.toString()).toContain('Unsupported network');
  });
});

function createMemoryStream(): Writable & { toString(): string } {
  let output = '';
  return Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    }),
    {
      toString() {
        return output;
      },
    }
  );
}

function createInvoice(
  overrides: Partial<Invoice> & Pick<Invoice, 'id'> & { status?: string }
): Invoice {
  const { id, ...rest } = overrides;
  return {
    amount: 1_000_000_000n,
    amountFunded: 0n,
    discountRate: 300,
    dueDate: 1_767_225_599,
    freelancer: validAddress(),
    fundedAt: null,
    funder: null,
    id,
    payer: validAddress('B'),
    status: 'Pending',
    token: 'CTOKEN',
    ...rest,
  };
}

function createListedInvoice(
  overrides: Partial<ListedInvoice> & Pick<ListedInvoice, 'id' | 'role' | 'status'>
): ListedInvoice {
  const { id, role, status, ...rest } = overrides;
  return {
    amount: 1_000_000_000n,
    amountFunded: 0n,
    discountRate: 300,
    dueDate: 1_767_225_599,
    freelancer: validAddress(),
    fundedAt: null,
    funder: null,
    id,
    payer: validAddress('B'),
    role,
    status,
    token: 'CTOKEN',
    ...rest,
  };
}

function validAddress(seed = 'A'): string {
  return Keypair.random().publicKey();
}
