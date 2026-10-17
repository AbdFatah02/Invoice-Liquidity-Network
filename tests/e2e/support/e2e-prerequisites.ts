/**
 * Shared E2E prerequisites.
 *
 * Audit finding (#1241, #1242, #1243, #1244): every cross-package E2E file used
 * to guard its integration assertions with `if (!isNodeRunning) return
 * ctx.skip()` and defaulted its contract IDs to placeholder strings such as
 * `C_DEPLOYED_CONTRACT_ID`. A node that never came up therefore produced a green
 * run with the whole integration surface silently skipped, and release CI grepped
 * for a `"<n> skipped"` string that the vitest reporter never emits — so the
 * "skip regression" check could not fire.
 *
 * Invariant enforced here (fail-closed by default):
 *
 *   I1 — An E2E suite may only report success when its external dependencies are
 *        actually reachable. An unreachable Soroban RPC is an actionable failure
 *        with the RPC URL, the last transport error and the documented recovery
 *        path — never a silent skip.
 *   I2 — A suite may only talk to a contract when a *real* deployed contract ID
 *        is supplied through the environment. Placeholder-shaped IDs
 *        (`C_*_REPLACE_ME`, `C_DEPLOYED_CONTRACT_ID`, …) are rejected with the
 *        same actionable failure, so a placeholder can never masquerade as a
 *        deployed contract.
 *   I3 — Skipping is possible only through the explicit, opt-in, locally-scoped
 *        escape hatch `E2E_ALLOW_SKIP=1`. CI never sets it, and
 *        `scripts/check-e2e-coverage.mjs` (#1243) fails the build on any skipped
 *        test, so the escape hatch cannot be used to green a release.
 *
 * See docs/runbooks/e2e-prerequisites.md for the operator runbook (control,
 * owner, recovery path) and docs/e2e-test-scope.md for the audit trail.
 */
import * as StellarSdk from '@stellar/stellar-sdk';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Failure raised when an E2E prerequisite is not satisfied. */
export class E2EPrerequisiteError extends Error {
  readonly prerequisite: string;
  readonly recovery: string;

  constructor(prerequisite: string, detail: string, recovery: string) {
    super(
      [
        `E2E prerequisite "${prerequisite}" is not satisfied.`,
        `  detail:   ${detail}`,
        `  recovery: ${recovery}`,
        '  See docs/runbooks/e2e-prerequisites.md for the full runbook.',
      ].join('\n')
    );
    this.name = 'E2EPrerequisiteError';
    this.prerequisite = prerequisite;
    this.recovery = recovery;
  }
}

const RECOVERY_NODE =
  'start the node with `docker compose -f tests/e2e/docker-compose.yml up -d stellar-quickstart`, ' +
  'confirm `curl -s -X POST -H "Content-Type: application/json" -d \'{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}\' ' +
  'http://localhost:8000/soroban/rpc` responds, then re-run. Set E2E_ALLOW_SKIP=1 only for a local, ' +
  'non-release run that genuinely has no node available.';

const RECOVERY_CONTRACT =
  'provision a real contract: `node scripts/provision-e2e-contract.mjs` (deploys the built WASM, or ' +
  'validates an already-deployed CONTRACT_ID) and export the CONTRACT_ID it prints.';

/**
 * Contract IDs that only ever existed as documentation placeholders. Anything
 * matching these shapes is rejected instead of being passed to the SDK (#1242).
 */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^C_[A-Z0-9_]*REPLACE_ME$/,
  /^C_[A-Z0-9_]*_REPLACE_ME$/,
  /^C_DEPLOYED_CONTRACT_ID$/,
  /^C_MOCK_CONTRACT_ID_REPLACE_ME$/,
  /^C_[A-Z]+_CONTRACT_ID$/,
];

/** True when the value is missing, empty, or one of the known placeholder IDs. */
export function isPlaceholderContractId(value: string | undefined | null): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Result of evaluating a suite's prerequisites. Evaluation never throws for
 * prerequisite failures so that the *dependency-free* parts of a suite still
 * execute; the failure is carried into a dedicated, always-present test instead
 * of being converted into a skip.
 */
export interface PrerequisiteStatus {
  /** True when every prerequisite held. */
  ok: boolean;
  /** The failure to surface, when `ok` is false. */
  error?: E2EPrerequisiteError;
  /** True only when the operator opted into skipping with `E2E_ALLOW_SKIP=1`. */
  skip: boolean;
}

/**
 * Evaluate the prerequisites of an integration suite at module scope (I1/I2/I3).
 *
 * @param probe runs the same checks the suite performs once connected.
 * @returns `{ ok: false, error }` when a prerequisite is unmet — the caller must
 *          surface `error` through a failing test, never through a skip.
 *          `{ ok: false, skip: true }` only when `E2E_ALLOW_SKIP=1` is set.
 * @throws any non-prerequisite error unchanged (e.g. a bug in the probe).
 */
export async function evaluatePrerequisites(
  probe: () => Promise<void>
): Promise<PrerequisiteStatus> {
  try {
    await probe();
    return { ok: true, skip: false };
  } catch (error) {
    if (!(error instanceof E2EPrerequisiteError)) throw error;

    if (skipsAllowed()) {
      const reasonFile = process.env.E2E_SKIP_REASONS_FILE;
      if (reasonFile) {
        mkdirSync(dirname(reasonFile), { recursive: true });
        appendFileSync(
          reasonFile,
          `${JSON.stringify({
            reason: error.message,
            prerequisite: error.prerequisite,
            recovery: error.recovery,
            recordedAt: new Date().toISOString(),
          })}\n`
        );
      }
      console.warn(
        `[e2e] E2E_ALLOW_SKIP=1 — skipping integration scenarios: ${error.prerequisite}. ` +
          'This escape hatch is forbidden on release branches; scripts/check-e2e-coverage.mjs ' +
          'fails the build on any skipped test.'
      );
      return { ok: false, error, skip: true };
    }

    return { ok: false, error, skip: false };
  }
}

/**
 * Body of the always-present prerequisite test. Suites expose this so the unmet
 * dependency surfaces as one actionable failure instead of N unrelated errors.
 */
export function assertPrerequisitesSatisfied(status: PrerequisiteStatus): void {
  if (!status.ok && status.error) throw status.error;
}

/** True when skipping is explicitly allowed via `E2E_ALLOW_SKIP=1` (I3). */
export function skipsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.E2E_ALLOW_SKIP;
  return raw === '1' || raw?.toLowerCase() === 'true';
}

/**
 * Resolve a real contract ID from the environment or fail actionably (I2).
 *
 * @param envVar    environment variable that carries the contract ID
 * @param options.fallbackEnvVars additional variables tried in order (e.g. the
 *                         deployed-contract file written by the deployer)
 * @param options.label human-readable dependency name used in the failure
 */
export function requireContractId(
  envVar: string,
  options: { fallbackEnvVars?: string[]; label?: string } = {}
): string {
  const candidates = [envVar, ...(options.fallbackEnvVars ?? [])];
  for (const name of candidates) {
    const value = process.env[name];
    if (!isPlaceholderContractId(value)) return value!.trim();
  }

  const configured = candidates
    .map((name) => `${name}=${process.env[name] ?? '<unset>'}`)
    .join(', ');
  const label = options.label ?? envVar;
  throw new E2EPrerequisiteError(
    `${label} contract id`,
    `${configured}. Placeholder contract IDs are rejected: they are not deployed contracts, ` +
      'so any assertion made against them proves nothing.',
    RECOVERY_CONTRACT
  );
}

/**
 * Read an optional contract ID without failing. Returns `undefined` when unset or
 * placeholder — used by suites whose scenarios only need the value at the point
 * they actually talk to the chain.
 */
export function optionalContractId(envVar: string): string | undefined {
  return isPlaceholderContractId(process.env[envVar]) ? undefined : process.env[envVar]!.trim();
}

/**
 * Fail actionably unless the Soroban RPC is reachable and healthy (I1).
 *
 * @returns the connected `rpc.Server`, ready for use by the suite.
 */
export async function requireHealthyRpc(
  rpcUrl: string,
  options: { allowHttp?: boolean; env?: NodeJS.ProcessEnv } = {}
): Promise<StellarSdk.rpc.Server> {
  const server = new StellarSdk.rpc.Server(rpcUrl, { allowHttp: options.allowHttp ?? true });

  let health: StellarSdk.rpc.Api.GetHealthResponse;
  try {
    health = await server.getHealth();
  } catch (error) {
    throw new E2EPrerequisiteError(
      'stellar rpc',
      `${rpcUrl} is unreachable (${error instanceof Error ? error.message : String(error)})`,
      RECOVERY_NODE
    );
  }

  if (health.status !== 'healthy') {
    throw new E2EPrerequisiteError(
      'stellar rpc health',
      `${rpcUrl} reported status "${health.status}" (expected "healthy")`,
      RECOVERY_NODE
    );
  }

  return server;
}

/**
 * Resolve an optional contract ID, failing actionably when the caller requires one.
 * Provided so suites that need a contract ID can express "required" at the call
 * site while sharing the single placeholder-rejection implementation (I2).
 */
export function resolveContractId(envVar: string, required: true): string;
export function resolveContractId(envVar: string, required?: false): string | undefined;
export function resolveContractId(envVar: string, required = false): string | undefined {
  return required ? requireContractId(envVar) : optionalContractId(envVar);
}
