import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Per-test control over hasUserClaimedEmissions (the voter already-claimed pre-flight).
let alreadyClaimed = false;

vi.mock('../chain/clients.js', () => ({
  createClients: vi.fn(() => ({
    network: 'testnet',
    account: { address: '0x726c000000000000000000000000000000000000' },
    publicClient: {
      readContract: ({ functionName }: { functionName: string }) => {
        if (functionName === 'hasUserClaimedEmissions') return Promise.resolve(alreadyClaimed);
        return Promise.resolve(undefined);
      },
    },
    walletClient: { chain: {} },
  })),
  nextNonce: vi.fn(() => Promise.resolve(0)),
}));

import { ClaimVoterEmissionsCommand } from './claim-voter-emissions.js';

describe('claim-voter-emissions pre-flight', () => {
  const FAKE_PK = '0x' + '11'.repeat(32);

  beforeEach(() => {
    alreadyClaimed = false;
    process.env.REPPO_PRIVATE_KEY = FAKE_PK;
    process.env.REPPO_NETWORK = 'testnet';
  });
  afterEach(() => {
    delete process.env.REPPO_PRIVATE_KEY;
    delete process.env.REPPO_NETWORK;
    vi.restoreAllMocks();
  });

  async function runAndCaptureErrorCode(opts: Record<string, unknown>): Promise<string> {
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      chunks.push(c.toString());
      return true;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit__${code ?? 0}`);
    }) as never);

    const cmd = new ClaimVoterEmissionsCommand();
    Object.assign(cmd, {
      pod: '34', epoch: '3940', json: true, dryRun: false,
      network: undefined, idempotencyKey: undefined, rpcUrl: undefined, ...opts,
    });

    await expect(cmd.execute()).rejects.toThrow('__exit__1');
    expect(exitSpy).toHaveBeenCalledWith(1);

    process.stderr.write = origWrite;
    const line = chunks.join('').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    const parsed = JSON.parse(line ?? '{}') as { error: { code: string } };
    return parsed.error.code;
  }

  it('fails with ALREADY_CLAIMED when the voter has already claimed (epoch, pod)', async () => {
    alreadyClaimed = true;
    expect(await runAndCaptureErrorCode({})).toBe('ALREADY_CLAIMED');
  });

  it('rejects a non-integer pod id with INVALID_POD_ID', async () => {
    expect(await runAndCaptureErrorCode({ pod: 'abc' })).toBe('INVALID_POD_ID');
  });

  it('rejects a non-integer epoch with INVALID_EPOCH', async () => {
    expect(await runAndCaptureErrorCode({ epoch: 'xyz' })).toBe('INVALID_EPOCH');
  });
});
