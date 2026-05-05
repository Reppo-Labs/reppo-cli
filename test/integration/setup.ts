import { spawn, type ChildProcess } from 'node:child_process';
import { createPublicClient, http } from 'viem';

const ANVIL_PORT = Number(process.env.ANVIL_PORT ?? 8545);
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const FORK_URL = process.env.BASE_RPC_URL;
const FORK_BLOCK = process.env.BASE_FORK_BLOCK;

let anvilProc: ChildProcess | null = null;

async function waitForRpc(url: string, timeoutMs = 15_000): Promise<void> {
  const client = createPublicClient({ transport: http(url) });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await client.getChainId();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`anvil did not accept RPC at ${url} within ${timeoutMs}ms`);
}

export async function setup(): Promise<void> {
  if (!FORK_URL) {
    throw new Error(
      'BASE_RPC_URL must be set for integration tests (a Base mainnet RPC, e.g. from Alchemy or Infura).',
    );
  }

  const args = ['--fork-url', FORK_URL, '--port', String(ANVIL_PORT), '--silent'];
  if (FORK_BLOCK) args.push('--fork-block-number', FORK_BLOCK);

  anvilProc = spawn('anvil', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  anvilProc.on('error', (err) => {
    throw new Error(`failed to spawn anvil — is foundry installed? (${err.message})`);
  });

  await waitForRpc(ANVIL_URL);

  // Point the CLI at the fork. Individual tests can still override via --rpc-url.
  process.env.REPPO_RPC_URL = ANVIL_URL;
}

export async function teardown(): Promise<void> {
  if (anvilProc && !anvilProc.killed) {
    anvilProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (!anvilProc.killed) anvilProc.kill('SIGKILL');
  }
  anvilProc = null;
}
