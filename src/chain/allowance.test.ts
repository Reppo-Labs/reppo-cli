import { describe, it, expect, vi } from 'vitest';
import { maxUint256 } from 'viem';
import { ensureAllowance } from './allowance.js';
import type { Clients } from './clients.js';

const ACCOUNT = '0x726c000000000000000000000000000000000000';
const TOKEN = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x2222222222222222222222222222222222222222';
const APPROVE_TX = '0xabc0000000000000000000000000000000000000000000000000000000000001';

// Builds a Clients-shaped mock. `allowance` seeds the on-chain allowance read;
// `receiptStatus` controls the approve receipt.
function makeClients(opts: {
  allowance: bigint;
  receiptStatus?: 'success' | 'reverted';
}): { clients: Clients; writeContract: ReturnType<typeof vi.fn> } {
  const writeContract = vi.fn(() => Promise.resolve(APPROVE_TX));
  const clients = {
    network: 'testnet',
    account: { address: ACCOUNT },
    publicClient: {
      readContract: vi.fn(({ functionName }: { functionName: string }) =>
        Promise.resolve(functionName === 'allowance' ? opts.allowance : undefined)),
      getTransactionCount: vi.fn(() => Promise.resolve(7)),
      waitForTransactionReceipt: vi.fn(() => Promise.resolve({ status: opts.receiptStatus ?? 'success' })),
    },
    walletClient: { chain: {}, writeContract },
  } as unknown as Clients;
  return { clients, writeContract };
}

describe('ensureAllowance', () => {
  it('is a no-op when the allowance already covers the amount (no approve tx)', async () => {
    const { clients, writeContract } = makeClients({ allowance: 1000n });
    const res = await ensureAllowance(clients, TOKEN, SPENDER, 100n, 1000n);
    expect(res).toEqual({ approved: false });
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('sends an unlimited approve() and waits when the allowance is short', async () => {
    const { clients, writeContract } = makeClients({ allowance: 0n });
    const res = await ensureAllowance(clients, TOKEN, SPENDER, 500n, 0n);
    expect(res).toEqual({ approved: true, approveTx: APPROVE_TX });
    expect(writeContract).toHaveBeenCalledTimes(1);
    const call = writeContract.mock.calls[0]![0] as { functionName: string; args: unknown[]; nonce: number };
    expect(call.functionName).toBe('approve');
    expect(call.args).toEqual([SPENDER, maxUint256]); // unlimited, matches `reppo approve` default
    expect(call.nonce).toBe(7);
  });

  it('reads the allowance on-chain when knownAllowance is omitted (sufficient → no-op)', async () => {
    const { clients, writeContract } = makeClients({ allowance: 999n });
    const res = await ensureAllowance(clients, TOKEN, SPENDER, 500n);
    expect(res.approved).toBe(false);
    expect(clients.publicClient.readContract).toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('throws APPROVE_REVERTED when the approve tx reverts on-chain', async () => {
    const { clients } = makeClients({ allowance: 0n, receiptStatus: 'reverted' });
    await expect(ensureAllowance(clients, TOKEN, SPENDER, 500n, 0n))
      .rejects.toMatchObject({ code: 'APPROVE_REVERTED' });
  });
});
