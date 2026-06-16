/**
 * Tests for `reppo approve --token <reppo|usdc|0x…>`. Focus: the arbitrary
 * ERC20 token-address path — decimals() is read on-chain for amount scaling,
 * a non-standard token (decimals() reverts) surfaces a clean INVALID_TOKEN,
 * and a non-alias non-address --token is rejected.
 *
 * The chain client is mocked so the suite runs offline. We drive the command
 * to the allowance "no-op" branch (allowance already covers the request) to
 * assert the resolved token/decimals without simulating a full write tx.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { maxUint256 } from 'viem';

// Per-test control: make decimals() throw to exercise the read-failure path.
let decimalsThrows = false;

vi.mock('../chain/clients.js', () => ({
  createClients: vi.fn(() => ({
    network: 'testnet',
    account: { address: '0x726c000000000000000000000000000000000000' },
    publicClient: {
      readContract: ({ functionName }: { functionName: string }) => {
        if (functionName === 'decimals') {
          return decimalsThrows
            ? Promise.reject(new Error('execution reverted'))
            : Promise.resolve(18);
        }
        // Existing allowance is unlimited → command takes the no-op branch.
        if (functionName === 'allowance') return Promise.resolve(maxUint256);
        return Promise.resolve(undefined);
      },
    },
    walletClient: { chain: {} },
  })),
  nextNonce: vi.fn(() => Promise.resolve(0)),
}));

import { ApproveCommand } from './approve.js';
import { setOutputMode } from '../output/format.js';

const FAKE_PK = '0x' + '11'.repeat(32);
// EIP-55 checksummed — viem's isAddress() (used by `approve` to validate the
// --token address path) rejects a mixed-case address that fails the checksum.
const TOKEN_ADDR = '0xEEEe000000000000000000000000000000000000';

function captureStdout(): { restore: () => void; read: () => string } {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => {
    chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
    return true;
  });
  return { restore: () => { process.stdout.write = orig; }, read: () => chunks.join('') };
}

class ExitError extends Error { constructor(public exitCode: number) { super(`exit ${exitCode}`); } }

function makeCmd(opts: { token: string; amount?: string }): ApproveCommand {
  const cmd = new ApproveCommand();
  Object.assign(cmd, {
    spender: 'subnet-manager',
    token: opts.token,
    amount: opts.amount ?? 'max',
    idempotencyKey: undefined,
    dryRun: false,
    json: true,
    network: undefined,
    rpcUrl: undefined,
  });
  return cmd;
}

async function runOk(cmd: ApproveCommand): Promise<{ exitCode: number; stdout: string }> {
  const out = captureStdout();
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
  try {
    let exitCode: number;
    try {
      exitCode = (await cmd.execute()) ?? 0;
    } catch (e) {
      if (e instanceof ExitError) exitCode = e.exitCode;
      else throw e;
    }
    return { exitCode, stdout: out.read() };
  } finally {
    out.restore();
    exitSpy.mockRestore();
  }
}

async function runErrorCode(cmd: ApproveCommand): Promise<string> {
  const chunks: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
    chunks.push(c.toString());
    return true;
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__exit__${code ?? 0}`);
  }) as never);
  try {
    await expect(cmd.execute()).rejects.toThrow('__exit__1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  } finally {
    process.stderr.write = origWrite;
  }
  const line = chunks.join('').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  const parsed = JSON.parse(line ?? '{}') as { error: { code: string } };
  return parsed.error.code;
}

interface ApproveResult {
  token: string;
  requested: { raw: string; formatted: string };
  status?: string;
}

describe('approve --token <arbitrary ERC20 address>', () => {
  beforeEach(() => {
    setOutputMode('json');
    decimalsThrows = false;
    process.env.REPPO_PRIVATE_KEY = FAKE_PK;
    process.env.REPPO_NETWORK = 'testnet';
  });
  afterEach(() => {
    delete process.env.REPPO_PRIVATE_KEY;
    delete process.env.REPPO_NETWORK;
    vi.restoreAllMocks();
  });

  it('accepts a 0x token address, reads decimals() for scaling, and reports it as the token label', async () => {
    const r = await runOk(makeCmd({ token: TOKEN_ADDR, amount: '25' }));
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as ApproveResult;
    // No-op branch (allowance already max), so we still see the resolved fields.
    expect(out.status).toBe('no-op');
    // token field is the lowercased address (the args-fingerprint label).
    expect(out.token).toBe(TOKEN_ADDR.toLowerCase());
    // 25 scaled by the on-chain decimals(18) — proves decimals() was used.
    expect(out.requested.raw).toBe((25n * 10n ** 18n).toString());
    expect(out.requested.formatted).toBe('25');
  });

  it('rejects a --token that is neither an alias nor a valid address with INVALID_TOKEN', async () => {
    expect(await runErrorCode(makeCmd({ token: 'notatoken' }))).toBe('INVALID_TOKEN');
  });

  it('surfaces INVALID_TOKEN (not INTERNAL_ERROR) when the token decimals() read fails', async () => {
    decimalsThrows = true;
    expect(await runErrorCode(makeCmd({ token: TOKEN_ADDR, amount: '25' }))).toBe('INVALID_TOKEN');
  });
});
