/**
 * Happy-path unit tests for `register-agent`, run in-process with the
 * global fetch stubbed (offline). Error paths (empty --name/--description)
 * live in src/__tests__/command-error-paths.test.ts, which spawns the
 * binary — they never reach fetch, so they don't belong here.
 *
 * Pins the platform request contract: what the command PUTS ON THE WIRE
 * for /agents/register — in particular the optional isOrquestra flag
 * (see https://docs.reppo.ai/api/agent/custom-agents). Orquestra nodes
 * must register with isOrquestra:true or the platform treats them as
 * custom agents and rejects on-chain pod ids on the /votes endpoint
 * (404 "Pod not found").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import { Cli } from 'clipanion';
import { RegisterAgentCommand } from './register-agent.js';

function sink(): Writable {
  return new Writable({ write(_chunk, _enc, cb) { cb(); } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function runRegister(args: string[]): Promise<number> {
  const cli = new Cli({ binaryName: 'reppo', enableCapture: false });
  cli.register(RegisterAgentCommand);
  return cli.run(['register-agent', ...args], {
    stdin: process.stdin,
    stdout: sink(),
    stderr: sink(),
  });
}

describe('register-agent request body', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(() =>
      Promise.resolve(jsonResponse({ data: { id: 'agent_test', apiKey: 'agent_key' } })),
    );
    vi.stubGlobal('fetch', fetchSpy);
    // emit() writes to process.stdout directly (not the clipanion context) —
    // silence it so the runner output stays clean.
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function sentBody(): Record<string, unknown> {
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  it('sends isOrquestra:true when --is-orquestra is passed', async () => {
    const code = await runRegister(['--name', 'node-a', '--description', 'swarm node', '--is-orquestra', '--json']);
    expect(code).toBe(0);
    expect(sentBody()).toEqual({ name: 'node-a', description: 'swarm node', isOrquestra: true });
  });

  it('omits isOrquestra when the flag is not passed (platform default: false)', async () => {
    const code = await runRegister(['--name', 'node-a', '--description', 'swarm node', '--json']);
    expect(code).toBe(0);
    expect(sentBody()).toEqual({ name: 'node-a', description: 'swarm node' });
  });
});
