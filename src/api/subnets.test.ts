/**
 * Unit tests for the shared datanet-catalog helpers. `fetch` is stubbed with
 * `vi.stubGlobal` so the suite runs offline.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  fetchSubnets,
  fetchSubnetByTokenId,
  numericToString,
  type RawSubnet,
} from './subnets.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ROWS: RawSubnet[] = [
  { id: 'cmnAAA', tokenId: '9', subnetName: 'TradingGym AI', nativeTokenSymbol: 'REPPO' },
  { id: 'cmnBBB', tokenId: '12', subnetName: 'Other', nativeTokenSymbol: 'USDC' },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('numericToString', () => {
  it('passes through numeric strings and trims', () => {
    expect(numericToString('500')).toBe('500');
    expect(numericToString('  42 ')).toBe('42');
  });
  it('truncates JS numbers to integers', () => {
    expect(numericToString(50)).toBe('50');
    expect(numericToString(9668144.9)).toBe('9668144');
  });
  it('renders missing/empty/non-finite as "0"', () => {
    expect(numericToString(undefined)).toBe('0');
    expect(numericToString('')).toBe('0');
    expect(numericToString(Number.NaN)).toBe('0');
    expect(numericToString(Infinity)).toBe('0');
  });
});

describe('fetchSubnets', () => {
  it('unwraps the { data: { subnets } } envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ data: { subnets: ROWS } }))));
    const subnets = await fetchSubnets('https://reppo.ai');
    expect(subnets).toHaveLength(2);
  });

  it('falls back to a top-level { subnets } envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ subnets: ROWS }))));
    const subnets = await fetchSubnets('https://reppo.ai');
    expect(subnets).toHaveLength(2);
  });

  it('returns [] when neither envelope is present', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({}))));
    expect(await fetchSubnets('https://reppo.ai')).toEqual([]);
  });

  it('throws PUBLIC_API_ERROR on a non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ error: 'down' }, 503))));
    await expect(fetchSubnets('https://reppo.ai')).rejects.toMatchObject({ code: 'PUBLIC_API_ERROR' });
  });
});

describe('fetchSubnetByTokenId', () => {
  it('matches the row whose on-chain tokenId equals the id', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ data: { subnets: ROWS } }))));
    const row = await fetchSubnetByTokenId('https://reppo.ai', '9');
    expect(row?.id).toBe('cmnAAA');
    expect(row?.subnetName).toBe('TradingGym AI');
  });

  it('returns null when no row has that tokenId', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ data: { subnets: ROWS } }))));
    expect(await fetchSubnetByTokenId('https://reppo.ai', '999')).toBeNull();
  });

  it('does not match the platform cuid against the numeric tokenId', async () => {
    // Guard against the inverse of the ISS-014 confusion: the numeric query
    // arg must match tokenId, NOT the cuid `id`.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ data: { subnets: ROWS } }))));
    expect(await fetchSubnetByTokenId('https://reppo.ai', 'cmnAAA')).toBeNull();
  });
});
