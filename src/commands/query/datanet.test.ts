/**
 * Tests for `reppo query datanet <id>` metadata enrichment. Both sides are
 * stubbed so the suite runs offline:
 *   - the chain read client (`createReadClient`) is vi.mock'd to return
 *     deterministic validSubnet / getAccessFeeREPPO results;
 *   - the catalog `fetch` is stubbed per-test.
 *
 * Focus: the off-chain catalog metadata is merged into the output, and a
 * catalog outage / no-match degrades to `{ unavailable }` WITHOUT breaking
 * the authoritative on-chain answer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Per-test control over what getSubnetPrimaryToken resolves to: a real token
// address by default, or address(0) for the REPPO-only (no primary token) case.
const NON_ZERO_PRIMARY = '0xEeEE000000000000000000000000000000000000';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
let primaryTokenAddr = NON_ZERO_PRIMARY;

// Deterministic chain reads — dispatch on the function name the command calls.
vi.mock('../../chain/clients.js', () => ({
  createReadClient: vi.fn(() => ({
    readContract: ({ functionName }: { functionName: string }) => {
      if (functionName === 'validSubnet') return Promise.resolve(true);
      if (functionName === 'getAccessFeeREPPO') return Promise.resolve(50n * 10n ** 18n);
      if (functionName === 'hasSubnetAccess') return Promise.resolve(false);
      if (functionName === 'currentEpoch') return Promise.resolve(97n);
      if (functionName === 'getSubnetPrimaryToken') return Promise.resolve(primaryTokenAddr);
      if (functionName === 'getAccessFeePrimaryToken') return Promise.resolve(25n * 10n ** 18n);
      if (functionName === 'decimals') return Promise.resolve(18);
      if (functionName === 'symbol') return Promise.resolve('EXY');
      return Promise.resolve(undefined);
    },
  })),
}));

import { QueryDatanetCommand } from './datanet.js';
import { setOutputMode } from '../../output/format.js';
import type { RawSubnet } from '../../api/subnets.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const FULL_ROW: RawSubnet = {
  id: 'cmnhuowns000bic04e16t6735',
  tokenId: '9',
  subnetName: 'TradingGym AI',
  subnetDescription: 'RL gym for trading agents.',
  thumbnailUrl: 'https://files.example/t.jpg',
  nativeTokenAddress: '0xFf8104251E7761163faC3211eF5583FB3F8583d6',
  nativeTokenSymbol: 'REPPO',
  nativeTokenDecimals: 18,
  accessFeeREPPO: 50,
  emissionsPerEpochREPPO: 500,
  emissionsPerEpochPrimaryToken: 0,
  status: 'ACTIVE',
  upVoteVolume: 9668144,
  downVoteVolume: 1568175,
  onboardingPublishers: 'Share your Hyperliquid perp trading data...',
  onboardingVoters: 'Score Pods 1-10...',
  isABTestingSubnet: false,
};

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

interface CommandLike {
  network: string | undefined;
  rpcUrl: string | undefined;
  json: boolean;
  datanet: string;
  for_: string | undefined;
}

function makeCmd(datanet: string): QueryDatanetCommand {
  const cmd = new QueryDatanetCommand() as unknown as CommandLike;
  cmd.network = undefined;
  cmd.rpcUrl = undefined;
  cmd.json = true;
  cmd.datanet = datanet;
  cmd.for_ = undefined;
  return cmd as unknown as QueryDatanetCommand;
}

async function run(cmd: QueryDatanetCommand): Promise<{ exitCode: number; stdout: string }> {
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

interface Result {
  datanetId: string;
  valid: boolean;
  currentEpoch: number | null;
  accessFeeREPPO: { formatted?: string } | { unavailable: string };
  accessFeePrimaryToken: { formatted?: string } | { unavailable: string };
  primaryToken?: { address: string; symbol: string; decimals: number };
  metadata: Record<string, unknown>;
}

beforeEach(() => {
  setOutputMode('json');
  primaryTokenAddr = NON_ZERO_PRIMARY;
  delete process.env.REPPO_NETWORK;
  delete process.env.REPPO_PRIVATE_KEY;
  delete process.env.REPPO_PUBLIC_API_URL;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('query datanet — metadata enrichment', () => {
  it('merges the catalog row matched by tokenId into output.metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(jsonResponse({ data: { subnets: [FULL_ROW, { tokenId: '12', subnetName: 'Other' }] } })),
    ));

    const r = await run(makeCmd('9'));
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Result;

    // On-chain answer intact.
    expect(out.valid).toBe(true);
    expect(out.currentEpoch).toBe(97);
    // Catalog metadata merged, numerics as strings.
    const m = out.metadata;
    expect(m.name).toBe('TradingGym AI');
    expect(m.description).toBe('RL gym for trading agents.');
    expect(m.emissionsPerEpochREPPO).toBe('500');
    expect(m.upVoteVolume).toBe('9668144');
    expect(m.subnetUuid).toBe('cmnhuowns000bic04e16t6735');
    expect((m.nativeToken as { decimals: number }).decimals).toBe(18);
    expect(m.onboardingPublishers).toContain('Hyperliquid');
    expect(m.onboardingVoters).toContain('Score Pods');
    // Primary-token access fee surfaced for non-REPPO-fee datanets.
    expect('formatted' in out.accessFeePrimaryToken ? out.accessFeePrimaryToken.formatted : null).toBe('25');
    expect(out.primaryToken?.address).toBe('0xEeEE000000000000000000000000000000000000');
    expect(out.primaryToken?.symbol).toBe('EXY');
    expect(out.primaryToken?.decimals).toBe(18);
  });

  it('omits primaryToken and reports "no primary token" when getSubnetPrimaryToken is the zero address', async () => {
    primaryTokenAddr = ZERO_ADDRESS;
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(jsonResponse({ data: { subnets: [FULL_ROW] } })),
    ));

    const r = await run(makeCmd('9'));
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Result;

    // On-chain REPPO answer still intact.
    expect(out.valid).toBe(true);
    expect('formatted' in out.accessFeeREPPO ? out.accessFeeREPPO.formatted : null).toBe('50');
    // No primary token: primaryToken omitted, fee marked unavailable with the
    // DISTINCT no-token wording (not the read-failure wording).
    expect(out.primaryToken).toBeUndefined();
    expect('unavailable' in out.accessFeePrimaryToken ? out.accessFeePrimaryToken.unavailable : null)
      .toBe('datanet has no primary token');
  });

  it('degrades to { unavailable } when the datanet is absent from the catalog', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(jsonResponse({ data: { subnets: [{ tokenId: '12', subnetName: 'Other' }] } })),
    ));

    const r = await run(makeCmd('9'));
    const out = JSON.parse(r.stdout) as Result;
    expect(out.valid).toBe(true); // on-chain survives
    expect(out.metadata).toHaveProperty('unavailable');
  });

  it('degrades to { unavailable } when the catalog fetch fails, on-chain answer survives', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ENOTFOUND'))));

    const r = await run(makeCmd('9'));
    const out = JSON.parse(r.stdout) as Result;
    expect(out.valid).toBe(true);
    expect('formatted' in out.accessFeeREPPO ? out.accessFeeREPPO.formatted : null).toBe('50');
    expect(out.metadata).toHaveProperty('unavailable');
    expect(String(out.metadata.unavailable)).toContain('catalog fetch failed');
  });
});
