import { describe, it, expect } from 'vitest';
import { runCli } from './helpers/run-cli.js';

// Base mainnet USDC contract — pinned address from src/chain/addresses.ts.
// Stable, always-deployed, has non-zero ETH balance from mint/admin txs.
const USDC_ON_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

describe('integration: reppo query balance', () => {
  it('returns structured balances for a known mainnet address against the fork', async () => {
    const { stdout, stderr, exitCode } = await runCli([
      'query', 'balance', USDC_ON_BASE,
      '--json',
      '--network', 'mainnet',
    ]);

    expect(exitCode, `stderr was: ${stderr}`).toBe(0);
    const result = JSON.parse(stdout) as {
      address: string;
      network: string;
      balances: {
        eth: { raw: string; formatted: string };
        reppo: { raw: string; formatted: string } | { unavailable: string };
        veReppo: { raw: string; formatted: string } | { unavailable: string };
        usdc: { raw: string; formatted: string } | { unavailable: string };
      };
    };

    expect(result.address.toLowerCase()).toBe(USDC_ON_BASE.toLowerCase());
    expect(result.network).toBe('mainnet');
    // ETH is the one balance that should always be queryable, even if other
    // contract addresses are TBD.
    expect(result.balances.eth.raw).toMatch(/^\d+$/);
    expect(typeof result.balances.eth.formatted).toBe('string');
    // REPPO has a real mainnet address — we expect a numeric balance, not
    // an `unavailable` marker.
    expect('raw' in result.balances.reppo).toBe(true);
  });

  it('returns INVALID_ADDRESS for malformed input', async () => {
    const { stderr, exitCode } = await runCli([
      'query', 'balance', '0xnotanaddress',
      '--json',
      '--network', 'mainnet',
    ]);

    expect(exitCode).not.toBe(0);
    const errLine = stderr.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? '';
    const parsed = JSON.parse(errLine) as { error: { code: string } };
    expect(parsed.error.code).toBe('INVALID_ADDRESS');
  });
});
