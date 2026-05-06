/**
 * Pre-flight error-path tests for every command. These test the
 * structured-error contract that agents rely on: code+message+hint
 * shape, plus the specific error codes raised for each invalid input.
 *
 * Strategy: spawn the CLI binary via tsx and assert against stderr
 * JSON. Pre-flight errors fire BEFORE any chain call, so these tests
 * don't need a mock RPC. The few error codes that require a chain
 * read to surface (e.g. NOT_LOCKUP_OWNER, ACCESS_ALREADY_GRANTED)
 * belong to integration tests, not here.
 *
 * Pin the public contract: code values are stable; messages can drift.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Synthetic pk: 32 zero bytes (well, 32× 0x11). Never derives a funded address.
const FAKE_PK = '0x' + '11'.repeat(32);

interface CliResult { stdout: string; stderr: string; exitCode: number }

async function runCli(args: string[], envOverrides: Record<string, string | undefined> = {}): Promise<CliResult> {
  // Build env: parent env minus REPPO_* keys (so dev shell doesn't leak in),
  // then layer in any explicit overrides.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('REPPO_')) env[k] = v;
  }
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v !== undefined) env[k] = v;
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      'npx', ['tsx', 'src/bin.ts', ...args],
      { cwd: REPO_ROOT, env, timeout: 15_000 },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code ?? 1 };
  }
}

/**
 * Parse the structured error JSON that `fail()` writes to stderr.
 * stderr may also have a non-JSON friendly line in human mode, so
 * pick the last line that starts with `{`.
 */
function parseError(stderr: string): { code: string; message: string; hint?: string } {
  const lines = stderr.trim().split('\n').filter((l) => l.startsWith('{'));
  const last = lines[lines.length - 1];
  if (!last) throw new Error(`No JSON line found in stderr: ${stderr}`);
  return (JSON.parse(last) as { error: { code: string; message: string; hint?: string } }).error;
}

// All these tests assume --json so structured output is parseable.
const JSON_FLAG = ['--json'];

describe('vote', () => {
  it('rejects neither --like nor --dislike with INVALID_VOTE', async () => {
    const r = await runCli(['vote', '--pod', '34', '--subnet', '19', ...JSON_FLAG], { REPPO_PRIVATE_KEY: FAKE_PK });
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_VOTE');
  });

  it('rejects both --like AND --dislike with INVALID_VOTE', async () => {
    const r = await runCli(['vote', '--pod', '34', '--subnet', '19', '--like', '--dislike', ...JSON_FLAG], { REPPO_PRIVATE_KEY: FAKE_PK });
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_VOTE');
  });

  it('rejects missing private key with MISSING_PRIVATE_KEY', async () => {
    const r = await runCli(['vote', '--pod', '34', '--subnet', '19', '--like', ...JSON_FLAG]);
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('MISSING_PRIVATE_KEY');
  });
});

describe('lock', () => {
  it('rejects non-numeric amount with INVALID_AMOUNT', async () => {
    const r = await runCli(['lock', 'abc', '--duration', '7200', ...JSON_FLAG], { REPPO_PRIVATE_KEY: FAKE_PK, REPPO_NETWORK: 'testnet' });
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_AMOUNT');
  });

  it('rejects zero amount with INVALID_AMOUNT', async () => {
    const r = await runCli(['lock', '0', '--duration', '7200', ...JSON_FLAG], { REPPO_PRIVATE_KEY: FAKE_PK, REPPO_NETWORK: 'testnet' });
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_AMOUNT');
  });

  it('rejects non-numeric duration with INVALID_DURATION', async () => {
    const r = await runCli(['lock', '1000', '--duration', 'forever', ...JSON_FLAG], { REPPO_PRIVATE_KEY: FAKE_PK, REPPO_NETWORK: 'testnet' });
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_DURATION');
  });

  it('rejects missing private key with MISSING_PRIVATE_KEY', async () => {
    const r = await runCli(['lock', '1000', '--duration', '7200', ...JSON_FLAG], { REPPO_NETWORK: 'testnet' });
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('MISSING_PRIVATE_KEY');
  });
});

// `unlock` tests are added when PR #23 merges — the command isn't on main yet.

describe('extend-lock', () => {
  it('rejects non-numeric lockupId with INVALID_LOCKUP_ID', async () => {
    const r = await runCli(['extend-lock', 'abc', '--duration', '7200', ...JSON_FLAG], { REPPO_PRIVATE_KEY: FAKE_PK, REPPO_NETWORK: 'testnet' });
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_LOCKUP_ID');
  });

  it('rejects zero duration with INVALID_DURATION', async () => {
    const r = await runCli(['extend-lock', '7', '--duration', '0', ...JSON_FLAG], { REPPO_PRIVATE_KEY: FAKE_PK, REPPO_NETWORK: 'testnet' });
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_DURATION');
  });

  it('rejects missing key with MISSING_PRIVATE_KEY', async () => {
    const r = await runCli(['extend-lock', '7', '--duration', '7200', ...JSON_FLAG]);
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('MISSING_PRIVATE_KEY');
  });
});

describe('grant-access', () => {
  it('rejects non-numeric --datanet with INVALID_DATANET_ID', async () => {
    const r = await runCli(['grant-access', '--datanet', 'abc', ...JSON_FLAG], { REPPO_PRIVATE_KEY: FAKE_PK, REPPO_NETWORK: 'testnet' });
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_DATANET_ID');
  });

  it('rejects malformed --to with INVALID_ADDRESS', async () => {
    const r = await runCli(['grant-access', '--datanet', '19', '--to', '0xnotanaddress', ...JSON_FLAG], { REPPO_PRIVATE_KEY: FAKE_PK, REPPO_NETWORK: 'testnet' });
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_ADDRESS');
  });

  it('rejects missing key with MISSING_PRIVATE_KEY', async () => {
    const r = await runCli(['grant-access', '--datanet', '19', ...JSON_FLAG], { REPPO_NETWORK: 'testnet' });
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('MISSING_PRIVATE_KEY');
  });
});

describe('claim-emissions', () => {
  it('rejects non-numeric --pod with INVALID_POD_ID', async () => {
    const r = await runCli(['claim-emissions', '--pod', 'abc', '--epoch', '1', ...JSON_FLAG], { REPPO_PRIVATE_KEY: FAKE_PK, REPPO_NETWORK: 'testnet' });
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_POD_ID');
  });

  it('rejects non-numeric --epoch with INVALID_EPOCH', async () => {
    const r = await runCli(['claim-emissions', '--pod', '34', '--epoch', 'xyz', ...JSON_FLAG], { REPPO_PRIVATE_KEY: FAKE_PK, REPPO_NETWORK: 'testnet' });
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_EPOCH');
  });

  it('rejects missing key with MISSING_PRIVATE_KEY', async () => {
    const r = await runCli(['claim-emissions', '--pod', '34', '--epoch', '1', ...JSON_FLAG]);
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('MISSING_PRIVATE_KEY');
  });
});

describe('mint-pod', () => {
  it('rejects mainnet (V1 unimplemented) with NETWORK_NOT_SUPPORTED', async () => {
    const r = await runCli(['mint-pod', '--datanet', '19', ...JSON_FLAG], { REPPO_PRIVATE_KEY: FAKE_PK, REPPO_NETWORK: 'mainnet' });
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('NETWORK_NOT_SUPPORTED');
  });

  it('rejects unknown --token with INVALID_TOKEN', async () => {
    const r = await runCli(['mint-pod', '--datanet', '19', '--token', 'bogus', ...JSON_FLAG], { REPPO_PRIVATE_KEY: FAKE_PK, REPPO_NETWORK: 'testnet' });
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_TOKEN');
  });

  it('rejects non-numeric --datanet with INVALID_DATANET_ID', async () => {
    const r = await runCli(['mint-pod', '--datanet', 'abc', ...JSON_FLAG], { REPPO_PRIVATE_KEY: FAKE_PK, REPPO_NETWORK: 'testnet' });
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_DATANET_ID');
  });

  it('rejects missing key with MISSING_PRIVATE_KEY', async () => {
    const r = await runCli(['mint-pod', '--datanet', '19', ...JSON_FLAG], { REPPO_NETWORK: 'testnet' });
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('MISSING_PRIVATE_KEY');
  });
});

describe('query balance', () => {
  it('rejects malformed address with INVALID_ADDRESS', async () => {
    const r = await runCli(['query', 'balance', '0xnotanaddress', ...JSON_FLAG, '--network', 'mainnet']);
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_ADDRESS');
  });

  it('rejects no address + no key with MISSING_ADDRESS', async () => {
    const r = await runCli(['query', 'balance', ...JSON_FLAG, '--network', 'mainnet']);
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('MISSING_ADDRESS');
  });
});

describe('query voting-power', () => {
  it('rejects malformed address with INVALID_ADDRESS', async () => {
    const r = await runCli(['query', 'voting-power', '0xnotanaddress', ...JSON_FLAG, '--network', 'mainnet']);
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_ADDRESS');
  });
});

describe('query datanet', () => {
  it('rejects non-numeric subnetId with INVALID_DATANET_ID', async () => {
    const r = await runCli(['query', 'datanet', 'abc', ...JSON_FLAG, '--network', 'mainnet']);
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_DATANET_ID');
  });

  it('rejects malformed --for with INVALID_ADDRESS', async () => {
    const r = await runCli(['query', 'datanet', '19', '--for', '0xbogus', ...JSON_FLAG, '--network', 'testnet']);
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_ADDRESS');
  });
});

describe('query pod', () => {
  it('rejects non-numeric podId with INVALID_POD_ID', async () => {
    const r = await runCli(['query', 'pod', 'abc', ...JSON_FLAG, '--network', 'mainnet']);
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_POD_ID');
  });
});
