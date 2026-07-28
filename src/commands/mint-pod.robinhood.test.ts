import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mocked chain for the robinhood (RBV1) mint branch. Dry-run only touches
// validSubnet + simulateContract, so the mock stays minimal and records the
// simulated call to prove the RBV1 mintPod path (not mintPodWithREPPO) ran.
const RB_POD_MANAGER = '0xeAd1A577B02829b7F634aD7eE30Fbbc2CDF7e478';
const seenSims: { functionName: string; address: string }[] = [];

vi.mock('../chain/clients.js', () => ({
  createClients: vi.fn(() => ({
    network: 'robinhood',
    account: { address: '0x726c000000000000000000000000000000000000' },
    publicClient: {
      readContract: ({ functionName }: { functionName: string }) => {
        if (functionName === 'validSubnet') return Promise.resolve(true);
        return Promise.reject(new Error(`unexpected read in dry-run: ${functionName}`));
      },
      simulateContract: ({ functionName, address }: { functionName: string; address: string }) => {
        seenSims.push({ functionName, address });
        return Promise.resolve({ result: 7n, request: { gas: 250_000n } });
      },
    },
    walletClient: { chain: {} },
  })),
  nextNonce: vi.fn(() => Promise.resolve(0)),
}));

import { MintPodCommand } from './mint-pod.js';

describe('mint-pod — robinhood (RBV1) branch', () => {
  const FAKE_PK = '0x' + '11'.repeat(32);

  beforeEach(() => {
    seenSims.length = 0;
    process.env.REPPO_PRIVATE_KEY = FAKE_PK;
    process.env.REPPO_NETWORK = 'robinhood';
  });
  afterEach(() => {
    delete process.env.REPPO_PRIVATE_KEY;
    delete process.env.REPPO_NETWORK;
    vi.restoreAllMocks();
  });

  function makeCmd(overrides: Record<string, unknown> = {}): MintPodCommand {
    const cmd = new MintPodCommand();
    Object.assign(cmd, {
      datanet: '1', token: 'reppo', json: true, dryRun: true,
      network: undefined, to: undefined, idempotencyKey: undefined, rpcUrl: undefined,
      podName: undefined, podDescription: undefined, subnetUuid: undefined,
      podUrl: undefined, imageUrl: undefined, category: 'Dataset', platform: 'reppo-cli',
      dataset: undefined, datasetUri: undefined, agreeToTerms: false,
      ...overrides,
    });
    return cmd;
  }

  async function captureErrorCode(cmd: MintPodCommand): Promise<string> {
    const chunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      chunks.push(c.toString());
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit__${code ?? 0}`);
    }) as never);
    await expect(cmd.execute()).rejects.toThrow('__exit__1');
    const line = chunks.join('').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    return (JSON.parse(line ?? '{}') as { error: { code: string } }).error.code;
  }

  it('dry-run simulates RBV1 mintPod against the RBV1 PodManager and reports subnet-token', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      out.push(c.toString());
      return true;
    });
    const code = await makeCmd().execute();
    expect(code).toBe(0);
    const line = out.join('').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    const result = JSON.parse(line ?? '{}') as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(result.token).toBe('subnet-token');
    expect(result.predictedPodId).toBe('7');
    expect(seenSims).toEqual([{ functionName: 'mintPod', address: RB_POD_MANAGER }]);
  });

  it('rejects --token primary with INVALID_TOKEN (no token choice on RBV1)', async () => {
    expect(await captureErrorCode(makeCmd({ token: 'primary' }))).toBe('INVALID_TOKEN');
  });

  it('rejects Phase-2 publishing with UNSUPPORTED_ON_NETWORK (no robinhood metadata API)', async () => {
    const cmd = makeCmd({
      podName: 'My Pod', subnetUuid: 'cms127jgm0001l204knjvwh5q', agreeToTerms: true,
    });
    process.env.REPPO_AGENT_ID = 'agent-1';
    process.env.REPPO_AGENT_API_KEY = 'key-1';
    try {
      expect(await captureErrorCode(cmd)).toBe('UNSUPPORTED_ON_NETWORK');
    } finally {
      delete process.env.REPPO_AGENT_ID;
      delete process.env.REPPO_AGENT_API_KEY;
    }
  });
});
