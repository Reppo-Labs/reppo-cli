/**
 * Tests for `reppo query epoch`. The chain read client is vi.mock'd so the
 * suite runs offline:
 *   - `currentEpoch` / `epochLength` / `epochEnd` return deterministic values;
 *   - `getBlock` returns a fixed latest-block timestamp.
 *
 * Focus: the epoch number is authoritative, the timing fields are derived
 * correctly from epochEnd/epochLength, and a revert on the timing getters
 * degrades only the timing fields (epoch survives).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Tunable per-test behaviour for the timing getters.
let timingThrows = false;

const EPOCH = 97n;
const EPOCH_LENGTH = 172800n; // 48h
const EPOCH_END = 1780665961n; // unix seconds at end of epoch 97
const NOW = 1780586571n; // latest block timestamp (mid-epoch)

vi.mock('../../chain/clients.js', () => ({
  createReadClient: vi.fn(() => ({
    readContract: ({ functionName }: { functionName: string }) => {
      if (functionName === 'currentEpoch') return Promise.resolve(EPOCH);
      if (timingThrows) return Promise.reject(new Error('execution reverted'));
      if (functionName === 'epochLength') return Promise.resolve(EPOCH_LENGTH);
      if (functionName === 'epochEnd') return Promise.resolve(EPOCH_END);
      return Promise.resolve(undefined);
    },
    getBlock: () => {
      if (timingThrows) return Promise.reject(new Error('execution reverted'));
      return Promise.resolve({ timestamp: NOW });
    },
  })),
}));

import { QueryEpochCommand } from './epoch.js';
import { setOutputMode } from '../../output/format.js';

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
}

function makeCmd(network?: string): QueryEpochCommand {
  const cmd = new QueryEpochCommand() as unknown as CommandLike;
  cmd.network = network;
  cmd.rpcUrl = undefined;
  cmd.json = true;
  return cmd as unknown as QueryEpochCommand;
}

async function run(cmd: QueryEpochCommand): Promise<{ exitCode: number; stdout: string }> {
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
  network: string;
  epoch: number | null;
  epochStart: number | null;
  epochDurationSeconds: number | null;
  secondsRemaining: number | null;
}

beforeEach(() => {
  setOutputMode('json');
  timingThrows = false;
  delete process.env.REPPO_NETWORK;
  delete process.env.REPPO_PRIVATE_KEY;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('query epoch', () => {
  it('returns the epoch and timing fields derived from epochEnd/epochLength', async () => {
    const r = await run(makeCmd());
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Result;

    expect(out.network).toBe('mainnet'); // default
    expect(out.epoch).toBe(97);
    expect(out.epochDurationSeconds).toBe(172800);
    // epochStart = epochEnd - epochLength
    expect(out.epochStart).toBe(Number(EPOCH_END - EPOCH_LENGTH));
    // secondsRemaining = epochEnd - now
    expect(out.secondsRemaining).toBe(Number(EPOCH_END - NOW));
    // sanity: now lies within [start, end)
    expect(out.epochStart! <= Number(NOW)).toBe(true);
    expect(Number(NOW) < EPOCH_END).toBe(true);
  });

  it('degrades timing fields to null when the timing getters revert, epoch survives', async () => {
    timingThrows = true;
    const r = await run(makeCmd());
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Result;

    expect(out.epoch).toBe(97); // authoritative read survives
    expect(out.epochStart).toBeNull();
    expect(out.epochDurationSeconds).toBeNull();
    expect(out.secondsRemaining).toBeNull();
  });
});
