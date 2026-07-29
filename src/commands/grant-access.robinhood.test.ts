import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mocked chain for the robinhood (RBV1) branch: single-token fee surface.
// Records every functionName so tests can assert the V2 selectors are never
// issued on robinhood (they don't exist on SubnetManagerRBV1).
const SUBNET_TOKEN = '0x2629A8083065938B533b117704935D727270eE7A';
const seenReads: string[] = [];
const seenSims: { functionName: string; address: string }[] = [];

vi.mock('../chain/clients.js', () => ({
  createClients: vi.fn(() => ({
    network: 'robinhood',
    account: { address: '0x726c000000000000000000000000000000000000' },
    publicClient: {
      readContract: ({ functionName }: { functionName: string }) => {
        seenReads.push(functionName);
        switch (functionName) {
          case 'validSubnet': return Promise.resolve(true);
          case 'getSubnetToken': return Promise.resolve(SUBNET_TOKEN);
          case 'decimals': return Promise.resolve(18);
          case 'symbol': return Promise.resolve('PAW');
          case 'hasSubnetAccess': return Promise.resolve(false);
          case 'getAccessFee': return Promise.resolve(5n * 10n ** 18n);
          case 'balanceOf': return Promise.resolve(10n * 10n ** 18n);
          case 'allowance': return Promise.resolve(10n ** 30n);
          default: return Promise.reject(new Error(`unexpected read on robinhood: ${functionName}`));
        }
      },
      simulateContract: ({ functionName, address }: { functionName: string; address: string }) => {
        seenSims.push({ functionName, address });
        return Promise.resolve({ request: { gas: 100_000n } });
      },
    },
    walletClient: { chain: {} },
  })),
  nextNonce: vi.fn(() => Promise.resolve(0)),
}));

import { GrantAccessCommand } from './grant-access.js';

describe('grant-access — robinhood (RBV1) dry-run branch', () => {
  const FAKE_PK = '0x' + '11'.repeat(32);

  beforeEach(() => {
    seenReads.length = 0;
    seenSims.length = 0;
    process.env.REPPO_PRIVATE_KEY = FAKE_PK;
    process.env.REPPO_NETWORK = 'robinhood';
  });
  afterEach(() => {
    delete process.env.REPPO_PRIVATE_KEY;
    delete process.env.REPPO_NETWORK;
    vi.restoreAllMocks();
  });

  async function runDryRun(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      out.push(c.toString());
      return true;
    });
    const cmd = new GrantAccessCommand();
    Object.assign(cmd, {
      datanet: '1', token: 'reppo', json: true, dryRun: true,
      network: undefined, to: undefined, idempotencyKey: undefined, rpcUrl: undefined,
      ...overrides,
    });
    const code = await cmd.execute();
    expect(code).toBe(0);
    const line = out.join('').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    return JSON.parse(line ?? '{}') as Record<string, unknown>;
  }

  it('resolves the subnet token as the fee token and simulates accessSubnet', async () => {
    const result = await runDryRun();
    expect(result.token).toBe('subnet-token');
    expect((result.feeToken as { address: string }).address).toBe(SUBNET_TOKEN);
    expect((result.feeToken as { symbol: string }).symbol).toBe('PAW');
    expect((result.feeAmount as { formatted: string }).formatted).toBe('5');
    // no legacy REPPO fee fields on robinhood
    expect(result.feeREPPO).toBeUndefined();
    expect(seenSims).toEqual([expect.objectContaining({ functionName: 'accessSubnet' })]);
  });

  it('never issues the V2 fee selectors on robinhood', async () => {
    await runDryRun();
    expect(seenReads).toContain('getSubnetToken');
    expect(seenReads).toContain('getAccessFee');
    expect(seenReads).not.toContain('getSubnetPrimaryToken');
    expect(seenReads).not.toContain('getAccessFeeREPPO');
    expect(seenReads).not.toContain('getAccessFeePrimaryToken');
  });

  it('accepts --token primary as an alias (orquestra passes it for non-REPPO fees)', async () => {
    const result = await runDryRun({ token: 'primary' });
    expect(result.token).toBe('subnet-token');
    expect((result.feeToken as { symbol: string }).symbol).toBe('PAW');
  });
});
