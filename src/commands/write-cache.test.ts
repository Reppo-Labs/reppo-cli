import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PublicClient, TransactionReceipt } from 'viem';
import { begin, markSubmitted, getIdempotent } from '../state/idempotency.js';
import { reconcileSubmittedCache } from './write-cache.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'reppo-reconcile-'));
let stateFile = '';

beforeEach(() => {
  stateFile = join(tmpRoot, `state-${Date.now()}.json`);
  process.env.REPPO_STATE_PATH = stateFile;
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('reconcileSubmittedCache', () => {
  const COMMAND = 'vote';
  const args = { podId: '34', votes: '10', like: true };
  const txHash = '0xabc1234567890123456789012345678901234567890123456789012345678901234' as const;

  it('promotes submitted to confirmed when receipt exists', async () => {
    await begin('rk', COMMAND, args);
    await markSubmitted('rk', COMMAND, args, txHash);

    const receipt = {
      status: 'success',
      blockNumber: 42n,
    } as TransactionReceipt;

    const client = {
      getTransactionReceipt: () => Promise.resolve(receipt),
    } as unknown as PublicClient;

    const result = await reconcileSubmittedCache(
      client, 'mainnet', 'rk', COMMAND, args, txHash,
      () => ({ podId: '34' }),
    );

    expect(result?.block).toBe('42');
    expect(result?.basescanUrl).toContain('basescan.org');
    const entry = await getIdempotent('rk', COMMAND, args);
    expect(entry?.status).toBe('confirmed');
  });

  it('preserves submitted payload fields when reconciling', async () => {
    await begin('rk2', COMMAND, args);
    await markSubmitted('rk2', COMMAND, args, txHash, { podId: '34', votes: '10', like: true, voterPower: '123' });

    const receipt = {
      status: 'success',
      blockNumber: 43n,
    } as TransactionReceipt;

    const client = {
      getTransactionReceipt: () => Promise.resolve(receipt),
    } as unknown as PublicClient;

    const result = await reconcileSubmittedCache(
      client, 'mainnet', 'rk2', COMMAND, args, txHash,
      () => ({ podId: '34', votes: '10', like: true }),
      { podId: '34', votes: '10', like: true, voterPower: '123' },
    );

    expect(result?.voterPower).toBe('123');
    expect(result?.block).toBe('43');
  });
});
