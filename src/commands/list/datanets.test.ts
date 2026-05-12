/**
 * Unit tests for `reppo list datanets`. The command is invoked directly
 * (not via the CLI binary) and `fetch` is stubbed with `vi.stubGlobal`
 * so the test runs offline and deterministically.
 *
 * Strategy:
 *   - Capture stdout/stderr writes so we can parse the JSON payload.
 *   - Intercept `process.exit` via `fail()` — when the command takes
 *     the error path, we re-throw instead of letting the test process
 *     die. The `code` field is asserted off the thrown exit-sentinel.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ListDatanetsCommand } from './datanets.js';
import { setOutputMode } from '../../output/format.js';

interface RawRow {
  id: string;
  subnetName: string;
  subnetDescription: string;
  thumbnailUrl: string;
  nativeTokenAddress: string;
  nativeTokenSymbol: string;
  nativeTokenDecimals: number;
  tokenId: string;
  accessFeeREPPO: number | string;
  emissionsPerEpochREPPO: number | string;
  emissionsPerEpochPrimaryToken: number | string;
  status: string;
  upVoteVolume: number | string;
  downVoteVolume: number | string;
  onboardingPublishers: string;
  onboardingVoters: string;
  createdByUserId: string;
  deleteScheduledAt: string | null;
  isABTestingSubnet: boolean;
}

// One realistic-shape fixture row covers most fields; helpers below
// produce variants for the status / token-symbol / volume cases.
function row(overrides: Partial<RawRow> = {}): RawRow {
  return {
    id: 'cmn6yva400001ld04a0vl9r2w',
    subnetName: 'Root Datanet',
    subnetDescription: '',
    thumbnailUrl: 'https://example.com/t.png',
    nativeTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    nativeTokenSymbol: 'USDC',
    nativeTokenDecimals: 6,
    tokenId: '1',
    accessFeeREPPO: 0,
    emissionsPerEpochREPPO: 0,
    emissionsPerEpochPrimaryToken: 0,
    status: 'ACTIVE',
    upVoteVolume: 813986,
    downVoteVolume: 41812,
    onboardingPublishers: '',
    onboardingVoters: '',
    createdByUserId: 'did:privy:abc',
    deleteScheduledAt: null,
    isABTestingSubnet: false,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Capture stdout writes for the duration of one test. */
function captureStdout(): { restore: () => void; read: () => string } {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => {
    chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
    return true;
  });
  return {
    restore: () => { process.stdout.write = orig; },
    read: () => chunks.join(''),
  };
}

function captureStderr(): { restore: () => void; read: () => string } {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string | Uint8Array) => {
    chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
    return true;
  });
  return {
    restore: () => { process.stderr.write = orig; },
    read: () => chunks.join(''),
  };
}

class ExitError extends Error {
  constructor(public exitCode: number) { super(`process.exit(${exitCode})`); }
}

/** Run `cmd.execute()` with stdout/stderr capture and process.exit trapping. */
async function runCommand(cmd: ListDatanetsCommand): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const out = captureStdout();
  const err = captureStderr();
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
    return { exitCode, stdout: out.read(), stderr: err.read() };
  } finally {
    out.restore();
    err.restore();
    exitSpy.mockRestore();
  }
}

/** Parse the structured error JSON written to stderr by `fail()`. */
function parseError(stderr: string): { code: string; message: string; hint?: string } {
  const lines = stderr.trim().split('\n').filter((l) => l.startsWith('{'));
  const last = lines[lines.length - 1];
  if (!last) throw new Error(`No JSON in stderr: ${stderr}`);
  return (JSON.parse(last) as { error: { code: string; message: string; hint?: string } }).error;
}

interface ResultShape {
  network: string;
  datanets: { id: string; name: string; status: string; nativeToken: { symbol: string } }[];
  count: number;
}

/**
 * Instantiate a ListDatanetsCommand without going through clipanion's
 * arg parser. Direct instantiation leaves clipanion's `Option.*` fields
 * holding sentinel objects rather than parsed values, so every option
 * field this test touches must be explicitly reset to a real value —
 * including BaseCommand's --network / --rpc-url, otherwise loadConfig
 * fires INVALID_NETWORK on the truthy sentinel.
 */
interface CommandLike {
  network: string | undefined;
  rpcUrl: string | undefined;
  json: boolean;
  status: string;
  tokenSymbol: string | undefined;
  limit: string | undefined;
}

function makeCmd(overrides: Partial<{ status: string; tokenSymbol: string; limit: string; json: boolean }> = {}): ListDatanetsCommand {
  const cmd = new ListDatanetsCommand() as unknown as CommandLike;
  cmd.network = undefined;
  cmd.rpcUrl = undefined;
  cmd.json = overrides.json ?? true;
  cmd.status = overrides.status ?? 'ACTIVE';
  cmd.tokenSymbol = overrides.tokenSymbol;
  cmd.limit = overrides.limit;
  return cmd as unknown as ListDatanetsCommand;
}

beforeEach(() => {
  setOutputMode('json');
  // No REPPO_* env leaks from the dev shell.
  delete process.env.REPPO_NETWORK;
  delete process.env.REPPO_PUBLIC_API_URL;
  delete process.env.REPPO_PRIVATE_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('list datanets — filtering', () => {
  it('filters out non-ACTIVE rows by default', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(jsonResponse({
        data: {
          subnets: [
            row({ tokenId: '1', subnetName: 'Live', status: 'ACTIVE' }),
            row({ tokenId: '2', subnetName: 'Dead', status: 'INACTIVE', deleteScheduledAt: '2026-01-01T00:00:00Z' }),
            row({ tokenId: '3', subnetName: 'Pending', status: 'PENDING' }),
          ],
        },
      })),
    ));

    const cmd = makeCmd();
    const r = await runCommand(cmd);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as ResultShape;
    expect(out.count).toBe(1);
    expect(out.datanets.map((d) => d.name)).toEqual(['Live']);
  });

  it('--status ALL includes deleted / non-active rows', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(jsonResponse({
        data: {
          subnets: [
            row({ tokenId: '1', subnetName: 'Live', status: 'ACTIVE' }),
            row({ tokenId: '2', subnetName: 'Dead', status: 'INACTIVE', deleteScheduledAt: '2026-01-01T00:00:00Z' }),
            row({ tokenId: '3', subnetName: 'Pending', status: 'PENDING' }),
          ],
        },
      })),
    ));

    const cmd = makeCmd({ status: 'ALL' });
    const r = await runCommand(cmd);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as ResultShape;
    expect(out.count).toBe(3);
    expect(out.datanets.map((d) => d.name).sort()).toEqual(['Dead', 'Live', 'Pending']);
  });

  it('--token-symbol REPPO is case-insensitive (matches "reppo", "RePPo")', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(jsonResponse({
        data: {
          subnets: [
            row({ tokenId: '1', subnetName: 'A', nativeTokenSymbol: 'REPPO' }),
            row({ tokenId: '2', subnetName: 'B', nativeTokenSymbol: 'reppo' }),
            row({ tokenId: '3', subnetName: 'C', nativeTokenSymbol: 'USDC' }),
            row({ tokenId: '4', subnetName: 'D', nativeTokenSymbol: 'RePPo' }),
          ],
        },
      })),
    ));

    const cmd = makeCmd({ tokenSymbol: 'reppo' });
    const r = await runCommand(cmd);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as ResultShape;
    expect(out.count).toBe(3);
    expect(out.datanets.every((d) => d.nativeToken.symbol.toLowerCase() === 'reppo')).toBe(true);
  });

  it('--limit 3 caps the result set at 3 rows', async () => {
    const subnets = Array.from({ length: 7 }, (_, i) =>
      row({ tokenId: String(i + 1), subnetName: `D${i + 1}`, status: 'ACTIVE' }),
    );
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ data: { subnets } }))));

    const cmd = makeCmd({ limit: '3' });
    const r = await runCommand(cmd);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as ResultShape;
    expect(out.count).toBe(3);
    expect(out.datanets).toHaveLength(3);
  });

  it('emits numeric fields as strings (BigInt-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(jsonResponse({
        data: {
          subnets: [row({ tokenId: '1', accessFeeREPPO: 42, upVoteVolume: 999999 })],
        },
      })),
    ));

    const cmd = makeCmd();
    const r = await runCommand(cmd);
    const parsed = JSON.parse(r.stdout) as {
      datanets: { accessFeeREPPO: unknown; upVoteVolume: unknown }[];
    };
    expect(parsed.datanets[0]?.accessFeeREPPO).toBe('42');
    expect(parsed.datanets[0]?.upVoteVolume).toBe('999999');
  });
});

describe('list datanets — error paths', () => {
  it('exits with PUBLIC_API_ERROR on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'internal' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })),
    ));

    const cmd = makeCmd();
    const r = await runCommand(cmd);
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('PUBLIC_API_ERROR');
  });

  it('exits with INVALID_STATUS on garbage --status value', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const cmd = makeCmd({ status: 'bogus' });
    const r = await runCommand(cmd);
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_STATUS');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('exits with INVALID_LIMIT on non-numeric --limit', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const cmd = makeCmd({ limit: 'abc' });
    const r = await runCommand(cmd);
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_LIMIT');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
