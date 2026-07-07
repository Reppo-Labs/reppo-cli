import { describe, it, expect, vi } from 'vitest';
import { maxUint256 } from 'viem';
import { ensureAllowance } from './allowance.js';
import type { Clients } from './clients.js';

const ACCOUNT = '0x726c000000000000000000000000000000000000';
const TOKEN = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x2222222222222222222222222222222222222222';
const APPROVE_TX = '0xabc0000000000000000000000000000000000000000000000000000000000001';

// Builds a Clients-shaped mock. `allowance` seeds the on-chain allowance read;
// `receiptStatus` controls the approve receipt. After the approve tx is sent, the
// allowance read flips to maxUint256 (the approval propagating) — except for the
// first `staleReads` post-approve reads, which simulate a lagging replica that
// hasn't applied the approve yet (issue #55).
function makeClients(opts: {
  allowance: bigint;
  receiptStatus?: 'success' | 'reverted';
  staleReads?: number;
}): { clients: Clients; writeContract: ReturnType<typeof vi.fn> } {
  let approved = false;
  let stale = opts.staleReads ?? 0;
  const writeContract = vi.fn(() => { approved = true; return Promise.resolve(APPROVE_TX); });
  const clients = {
    network: 'testnet',
    account: { address: ACCOUNT },
    publicClient: {
      readContract: vi.fn(({ functionName }: { functionName: string }) => {
        if (functionName !== 'allowance') return Promise.resolve(undefined);
        if (!approved) return Promise.resolve(opts.allowance);
        if (stale > 0) { stale--; return Promise.resolve(opts.allowance); } // lagging replica
        return Promise.resolve(maxUint256);
      }),
      getTransactionCount: vi.fn(() => Promise.resolve(7)),
      waitForTransactionReceipt: vi.fn(() => Promise.resolve({ status: opts.receiptStatus ?? 'success' })),
    },
    walletClient: { chain: {}, writeContract },
  } as unknown as Clients;
  return { clients, writeContract };
}

/** Instant sleeper for poll tests — counts calls instead of waiting wall-clock. */
function fastSleep(): { fn: (ms: number) => Promise<void>; calls: () => number } {
  let n = 0;
  return { fn: () => { n++; return Promise.resolve(); }, calls: () => n };
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

  // ── post-approve visibility poll (issue #55: receipt ≠ read-path visibility) ──

  it('does not sleep when the approval is visible on the first post-approve read', async () => {
    const s = fastSleep();
    const { clients } = makeClients({ allowance: 0n }); // visible immediately after approve
    const res = await ensureAllowance(clients, TOKEN, SPENDER, 500n, 0n, s.fn);
    expect(res.approved).toBe(true);
    expect(s.calls()).toBe(0); // no lag → no waiting
  });

  it('polls through lagging replica reads until the approval is visible', async () => {
    const s = fastSleep();
    const { clients } = makeClients({ allowance: 0n, staleReads: 3 });
    const res = await ensureAllowance(clients, TOKEN, SPENDER, 500n, 0n, s.fn);
    expect(res.approved).toBe(true);
    expect(s.calls()).toBe(3); // slept once per stale read, stopped when visible
  });

  it('gives up after the poll bound and still returns approved (spend may yet succeed)', async () => {
    const s = fastSleep();
    const { clients } = makeClients({ allowance: 0n, staleReads: 99 }); // never becomes visible
    const res = await ensureAllowance(clients, TOKEN, SPENDER, 500n, 0n, s.fn);
    expect(res).toEqual({ approved: true, approveTx: APPROVE_TX }); // falls through, no throw
    expect(s.calls()).toBe(10); // bounded — ALLOWANCE_VISIBILITY_POLLS
  });
});
