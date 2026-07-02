/**
 * Tests for `reppo query voter-emissions-due` — voter-claimability pre-flight.
 * Chain reads are vi.mock'd (offline); per-test knobs control the voter's vote
 * counts and claimed flag. Errors go through fail() → process.exit, which is
 * spied and rethrown as ExitError (same harness as datanet.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let upVotes = 3n;
let downVotes = 0n;
let claimed = false;

vi.mock('../../chain/clients.js', () => ({
  createReadClient: vi.fn(() => ({
    readContract: ({ functionName }: { functionName: string }) => {
      if (functionName === 'getVotersUpVotesForPodInEpoch') return Promise.resolve(upVotes);
      if (functionName === 'getVotersDownVotesForPodInEpoch') return Promise.resolve(downVotes);
      if (functionName === 'hasUserClaimedEmissions') return Promise.resolve(claimed);
      return Promise.resolve(undefined);
    },
  })),
}));

import { QueryVoterEmissionsDueCommand } from './voter-emissions-due.js';
import { setOutputMode } from '../../output/format.js';

const VOTER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

function captureStream(stream: NodeJS.WriteStream): { restore: () => void; read: () => string } {
  const chunks: string[] = [];
  const orig = stream.write.bind(stream);
  stream.write = ((c: string | Uint8Array) => {
    chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
    return true;
  });
  return { restore: () => { stream.write = orig; }, read: () => chunks.join('') };
}

class ExitError extends Error { constructor(public exitCode: number) { super(`exit ${exitCode}`); } }

interface Result {
  podId: string; epoch: number; voter: string;
  upVotes: string; downVotes: string;
  voted: boolean; claimed: boolean; claimable: boolean;
}

// clipanion Option fields hold descriptors until the CLI parses argv — in unit
// tests every field must be overwritten explicitly (same pattern as datanet.test.ts).
interface CommandLike {
  network: string | undefined;
  rpcUrl: string | undefined;
  json: boolean;
  pod: string;
  epoch: string;
  voter: string | undefined;
}

function makeCmd(pod: string, epoch: string, voter?: string): QueryVoterEmissionsDueCommand {
  const cmd = new QueryVoterEmissionsDueCommand() as unknown as CommandLike;
  cmd.network = undefined;
  cmd.rpcUrl = undefined;
  cmd.json = true;
  cmd.pod = pod;
  cmd.epoch = epoch;
  cmd.voter = voter;
  return cmd as unknown as QueryVoterEmissionsDueCommand;
}

async function run(cmd: QueryVoterEmissionsDueCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const out = captureStream(process.stdout);
  const errOut = captureStream(process.stderr);
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
    return { exitCode, stdout: out.read(), stderr: errOut.read() };
  } finally {
    out.restore();
    errOut.restore();
    exitSpy.mockRestore();
  }
}

function errorCode(stderr: string): string {
  return (JSON.parse(stderr) as { error: { code: string } }).error.code;
}

beforeEach(() => {
  setOutputMode('json');
  upVotes = 3n; downVotes = 0n; claimed = false;
  delete process.env.REPPO_NETWORK;
  delete process.env.REPPO_PRIVATE_KEY;
  delete process.env.REPPO_VOTER_PRIVATE_KEY;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('query voter-emissions-due', () => {
  it('claimable when the voter voted and has not claimed', async () => {
    const r = await run(makeCmd('34', '101', VOTER));
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Result;
    expect(out.voted).toBe(true);
    expect(out.claimed).toBe(false);
    expect(out.claimable).toBe(true);
    expect(out.upVotes).toBe('3');
  });

  it('not claimable when already claimed', async () => {
    claimed = true;
    const r = await run(makeCmd('34', '101', VOTER));
    const out = JSON.parse(r.stdout) as Result;
    expect(out.claimed).toBe(true);
    expect(out.claimable).toBe(false);
  });

  it('not claimable when the voter never voted on the pod that epoch', async () => {
    upVotes = 0n; downVotes = 0n;
    const r = await run(makeCmd('34', '101', VOTER));
    const out = JSON.parse(r.stdout) as Result;
    expect(out.voted).toBe(false);
    expect(out.claimable).toBe(false);
  });

  it('downvotes alone also count as voted (voters earn on both directions)', async () => {
    upVotes = 0n; downVotes = 2n;
    const r = await run(makeCmd('34', '101', VOTER));
    const out = JSON.parse(r.stdout) as Result;
    expect(out.voted).toBe(true);
    expect(out.claimable).toBe(true);
  });

  it('rejects a non-numeric pod id with INVALID_POD_ID', async () => {
    const r = await run(makeCmd('abc', '101', VOTER));
    expect(r.exitCode).not.toBe(0);
    expect(errorCode(r.stderr)).toBe('INVALID_POD_ID');
  });

  it('rejects a non-numeric epoch with INVALID_EPOCH', async () => {
    const r = await run(makeCmd('34', 'abc', VOTER));
    expect(r.exitCode).not.toBe(0);
    expect(errorCode(r.stderr)).toBe('INVALID_EPOCH');
  });

  it('rejects a malformed --voter with INVALID_ADDRESS', async () => {
    const r = await run(makeCmd('34', '101', '0xnope'));
    expect(r.exitCode).not.toBe(0);
    expect(errorCode(r.stderr)).toBe('INVALID_ADDRESS');
  });

  it('requires a voter address when neither flag nor env keys are set', async () => {
    const r = await run(makeCmd('34', '101'));
    expect(r.exitCode).not.toBe(0);
    expect(errorCode(r.stderr)).toBe('VOTER_ADDRESS_REQUIRED');
  });

  it('derives the voter from REPPO_VOTER_PRIVATE_KEY when no --voter given', async () => {
    // anvil's canonical test key 0 — publicly known, never funded on mainnet.
    process.env.REPPO_VOTER_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const r = await run(makeCmd('34', '101'));
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Result;
    expect(out.voter.toLowerCase()).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  });
});
