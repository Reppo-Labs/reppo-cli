import { describe, it, expect } from 'vitest';
import { parseWei } from './emissions-due.js';

describe('parseWei', () => {
  it('parses decimal-string wei', () => {
    expect(parseWei('1500000000000000000')).toBe(1500000000000000000n);
  });

  it('parses JS number wei via integer truncation', () => {
    expect(parseWei(42)).toBe(42n);
  });

  it('returns 0n for undefined/null/empty', () => {
    expect(parseWei(undefined)).toBe(0n);
    expect(parseWei('')).toBe(0n);
  });

  it('returns 0n for non-digit strings (would otherwise throw SyntaxError)', () => {
    expect(parseWei('abc')).toBe(0n);
    expect(parseWei('1.5')).toBe(0n);
    expect(parseWei('1e18')).toBe(0n);
  });

  it('rejects negatives — claimable emissions cannot be negative', () => {
    // Adversarial / buggy platform API response. Must not be allowed to
    // drag totalDueREPPO below zero.
    expect(parseWei('-500')).toBe(0n);
    expect(parseWei(-42)).toBe(0n);
  });

  it('handles enormous bigints beyond Number.MAX_SAFE_INTEGER', () => {
    const big = '999999999999999999999999999999';
    expect(parseWei(big)).toBe(BigInt(big));
  });
});

import { queryViaAgentsApi } from './emissions-due.js';

/** Build a fetch stub that serves canned JSON pages in order. */
const fetchPages = (pages: Array<{ status?: number; body?: unknown }>) => {
  let call = 0;
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(url.toString());
    const page = pages[Math.min(call++, pages.length - 1)]!;
    return {
      status: page.status ?? 200,
      ok: (page.status ?? 200) >= 200 && (page.status ?? 200) < 300,
      json: async () => page.body ?? {},
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, urls };
};

describe('queryViaAgentsApi', () => {
  it('returns null on 404 so the caller falls back to the legacy path', async () => {
    const { impl } = fetchPages([{ status: 404 }]);
    expect(await queryViaAgentsApi('https://reppo.ai/api/v1', 'a1', 'k1', impl)).toBeNull();
  });

  it('throws INVALID_AGENT_CREDENTIALS on 401 instead of silently falling back', async () => {
    const { impl } = fetchPages([{ status: 401 }]);
    await expect(queryViaAgentsApi('https://reppo.ai/api/v1', 'a1', 'k1', impl))
      .rejects.toMatchObject({ code: 'INVALID_AGENT_CREDENTIALS' });
  });

  it('maps claimable epochs to claimed=false and zero-emission epochs to claimed=true', async () => {
    const { impl } = fetchPages([{
      body: {
        data: {
          currentEpoch: 131,
          byPod: [{
            podId: 7, owner: '0xabc',
            epochs: [
              { epoch: 128, claimed: true, claimable: false },
              { epoch: 129, claimed: false, claimable: false }, // zero emissions: nothing to claim
              { epoch: 130, claimed: false, claimable: true },
            ],
          }],
        },
      },
    }]);
    const out = await queryViaAgentsApi('https://reppo.ai/api/v1', 'a1', 'k1', impl);
    const pod = (out!.result.byPod as Array<{ podId: string; epochs: Array<{ epoch: number; claimed: boolean }> }>)[0]!;
    expect(pod.podId).toBe('7');
    // Only epoch 130 may surface as unclaimed — a consumer fires claim txs off this
    // field, and claiming 129 would revert.
    expect(pod.epochs).toEqual([
      { epoch: 128, amount: '0', claimed: true },
      { epoch: 129, amount: '0', claimed: true },
      { epoch: 130, amount: '0', claimed: false },
    ]);
  });

  it('follows nextCursor across pages and merges epochs per pod', async () => {
    const { impl, urls } = fetchPages([
      {
        body: {
          data: {
            currentEpoch: 131, moreEpochsAvailable: true, nextCursor: '7:120',
            byPod: [{ podId: 7, owner: '0xabc', epochs: [{ epoch: 119, claimed: false, claimable: true }] }],
          },
        },
      },
      {
        body: {
          data: {
            currentEpoch: 131,
            byPod: [{ podId: 7, owner: '0xabc', epochs: [{ epoch: 120, claimed: false, claimable: true }] }],
          },
        },
      },
    ]);
    const out = await queryViaAgentsApi('https://reppo.ai/api/v1', 'a1', 'k1', impl);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('cursor=7%3A120');
    const pod = (out!.result.byPod as Array<{ epochs: unknown[] }>)[0]!;
    expect(pod.epochs).toHaveLength(2);
  });

  it('flags truncation instead of looping forever when the flag is set without a cursor', async () => {
    const { impl } = fetchPages([{
      body: { data: { currentEpoch: 131, moreEpochsAvailable: true, byPod: [] } },
    }]);
    const out = await queryViaAgentsApi('https://reppo.ai/api/v1', 'a1', 'k1', impl);
    expect(out!.result.truncated).toBe(true);
  });
});
