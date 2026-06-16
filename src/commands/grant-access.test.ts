import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Per-test control over the validSubnet read. grant-access now checks
// validSubnet BEFORE resolving the primary token, so the DATANET_HAS_NO_PRIMARY_TOKEN
// path requires a valid subnet; an invalid subnet short-circuits to DATANET_NOT_FOUND.
let validSubnet = true;

// Deterministic write-client: getSubnetPrimaryToken resolves to address(0),
// the on-chain signal for a REPPO-only datanet (no primary token configured).
vi.mock('../chain/clients.js', () => ({
  createClients: vi.fn(() => ({
    network: 'testnet',
    account: { address: '0x726c000000000000000000000000000000000000' },
    publicClient: {
      readContract: ({ functionName }: { functionName: string }) => {
        if (functionName === 'validSubnet') return Promise.resolve(validSubnet);
        if (functionName === 'getSubnetPrimaryToken') {
          return Promise.resolve('0x0000000000000000000000000000000000000000');
        }
        return Promise.resolve(undefined);
      },
    },
    walletClient: { chain: {} },
  })),
  nextNonce: vi.fn(() => Promise.resolve(0)),
}));

import { accessFns, GrantAccessCommand } from './grant-access.js';

describe('accessFns', () => {
  it('maps "reppo" to the REPPO access method + fee getter', () => {
    expect(accessFns('reppo')).toEqual({
      access: 'accessSubnetWithREPPOFee',
      feeGetter: 'getAccessFeeREPPO',
    });
  });

  it('maps "primary" to the primary-token access method + fee getter', () => {
    expect(accessFns('primary')).toEqual({
      access: 'accessSubnetWithPrimaryTokenFee',
      feeGetter: 'getAccessFeePrimaryToken',
    });
  });
});

describe('grant-access --token primary pre-flight error codes', () => {
  const FAKE_PK = '0x' + '11'.repeat(32);

  beforeEach(() => {
    validSubnet = true;
    process.env.REPPO_PRIVATE_KEY = FAKE_PK;
    process.env.REPPO_NETWORK = 'testnet';
  });
  afterEach(() => {
    delete process.env.REPPO_PRIVATE_KEY;
    delete process.env.REPPO_NETWORK;
    vi.restoreAllMocks();
  });

  // Runs `grant-access --datanet 19 --token primary` against the mocked chain
  // and returns the structured error code emitted on stderr.
  async function runAndCaptureErrorCode(): Promise<string> {
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      chunks.push(c.toString());
      return true;
    });
    // fail() calls process.exit; turn it into a throwable so execute() rejects.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit__${code ?? 0}`);
    }) as never);

    const cmd = new GrantAccessCommand();
    // Set every option explicitly — constructed-directly (no clipanion parse),
    // the Option fields hold spec tokens, not their resolved values.
    Object.assign(cmd, {
      datanet: '19', token: 'primary', json: true, dryRun: false,
      network: undefined, to: undefined, idempotencyKey: undefined, rpcUrl: undefined,
    });

    await expect(cmd.execute()).rejects.toThrow('__exit__1');
    expect(exitSpy).toHaveBeenCalledWith(1);

    process.stderr.write = origWrite;
    const line = chunks.join('').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    const parsed = JSON.parse(line ?? '{}') as { error: { code: string } };
    return parsed.error.code;
  }

  it('fails with DATANET_HAS_NO_PRIMARY_TOKEN when a valid datanet has getSubnetPrimaryToken == address(0)', async () => {
    validSubnet = true; // a valid datanet that simply charges in REPPO only
    expect(await runAndCaptureErrorCode()).toBe('DATANET_HAS_NO_PRIMARY_TOKEN');
  });

  it('fails with DATANET_NOT_FOUND (not DATANET_HAS_NO_PRIMARY_TOKEN) when the datanet is invalid', async () => {
    validSubnet = false; // nonexistent datanet — validSubnet is checked first
    expect(await runAndCaptureErrorCode()).toBe('DATANET_NOT_FOUND');
  });
});
