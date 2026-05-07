import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from './load.js';

// All env keys the loader reads. Cleared between tests so prior runs and
// the dev's own shell don't leak in.
const TRACKED_ENV = [
  'REPPO_NETWORK',
  'REPPO_RPC_URL',
  'REPPO_API_URL',
  'REPPO_API_KEY',
  'REPPO_PRIVATE_KEY',
  'REPPO_VOTER_PRIVATE_KEY',
] as const;

const ZEROES_PK = '0x' + '11'.repeat(32);
const BARE_PK = '22'.repeat(32);

const tmpRoot = mkdtempSync(join(tmpdir(), 'reppo-config-'));
const originalHome = process.env.HOME;

function freshTmp(): { cwd: string; home: string } {
  const slot = mkdtempSync(join(tmpRoot, 'slot-'));
  const cwd = join(slot, 'cwd');
  const home = join(slot, 'home');
  mkdirSync(cwd);
  mkdirSync(home);
  return { cwd, home };
}

function writeCwdConfig(cwd: string, body: Record<string, unknown>): void {
  writeFileSync(join(cwd, '.reppo.json'), JSON.stringify(body));
}

function writeHomeConfig(home: string, body: Record<string, unknown>): void {
  const dir = join(home, '.reppo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(body));
}

beforeEach(() => {
  for (const key of TRACKED_ENV) delete process.env[key];
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function pointAt(cwd: string, home: string): void {
  // Spy rather than chdir — process.chdir() messes with v8 coverage's
  // source-file path resolution, leaving covered statements unattributed.
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  process.env.HOME = home;
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadConfig — network precedence', () => {
  it('defaults to mainnet when nothing is set', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    expect(loadConfig().network).toBe('mainnet');
  });

  it('home config beats default', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    writeHomeConfig(home, { network: 'testnet' });
    expect(loadConfig().network).toBe('testnet');
  });

  it('cwd config beats home config', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    writeHomeConfig(home, { network: 'testnet' });
    writeCwdConfig(cwd, { network: 'mainnet' });
    expect(loadConfig().network).toBe('mainnet');
  });

  it('env REPPO_NETWORK beats cwd config', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    writeCwdConfig(cwd, { network: 'mainnet' });
    process.env.REPPO_NETWORK = 'testnet';
    expect(loadConfig().network).toBe('testnet');
  });

  it('overrides.network beats env', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    process.env.REPPO_NETWORK = 'testnet';
    expect(loadConfig({ network: 'mainnet' }).network).toBe('mainnet');
  });

  it('throws on invalid network value from env', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    process.env.REPPO_NETWORK = 'goerli';
    expect(() => loadConfig()).toThrow(/Invalid network "goerli"/);
  });

  it('attaches code=INVALID_NETWORK so agents can match it', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    process.env.REPPO_NETWORK = 'goerli';
    try {
      loadConfig();
      expect.fail('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('INVALID_NETWORK');
    }
  });
});

describe('loadConfig — apiUrl', () => {
  it('defaults to https://api.reppo.xyz on mainnet', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    expect(loadConfig().apiUrl).toBe('https://api.reppo.xyz');
  });

  it('returns undefined on testnet (no default API URL)', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    process.env.REPPO_NETWORK = 'testnet';
    expect(loadConfig().apiUrl).toBeUndefined();
  });

  it('strips trailing slashes', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    process.env.REPPO_API_URL = 'https://api.example.com/';
    expect(loadConfig().apiUrl).toBe('https://api.example.com');
  });

  it('strips multiple trailing slashes', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    process.env.REPPO_API_URL = 'https://api.example.com///';
    expect(loadConfig().apiUrl).toBe('https://api.example.com');
  });
});

describe('loadConfig — normalizePk', () => {
  it('accepts 0x-prefixed 64-hex private key', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    process.env.REPPO_PRIVATE_KEY = ZEROES_PK;
    expect(loadConfig().privateKey).toBe(ZEROES_PK);
  });

  it('accepts bare 64-hex and prepends 0x', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    process.env.REPPO_PRIVATE_KEY = BARE_PK;
    expect(loadConfig().privateKey).toBe(`0x${BARE_PK}`);
  });

  it('trims whitespace from the private key', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    process.env.REPPO_PRIVATE_KEY = `   ${ZEROES_PK}\n`;
    expect(loadConfig().privateKey).toBe(ZEROES_PK);
  });

  it('rejects too-short hex', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    process.env.REPPO_PRIVATE_KEY = '0xdeadbeef';
    expect(() => loadConfig()).toThrow(/32-byte hex/);
  });

  it('attaches code=INVALID_PRIVATE_KEY so agents can match it', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    process.env.REPPO_PRIVATE_KEY = '0xdeadbeef';
    try {
      loadConfig();
      expect.fail('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('INVALID_PRIVATE_KEY');
    }
  });

  it('rejects non-hex characters', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    process.env.REPPO_PRIVATE_KEY = 'g'.repeat(64);
    expect(() => loadConfig()).toThrow(/32-byte hex/);
  });

  it('returns undefined when REPPO_PRIVATE_KEY is unset', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    expect(loadConfig().privateKey).toBeUndefined();
  });

  it('reads voterPrivateKey separately from REPPO_VOTER_PRIVATE_KEY', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    process.env.REPPO_PRIVATE_KEY = ZEROES_PK;
    process.env.REPPO_VOTER_PRIVATE_KEY = `0x${BARE_PK}`;
    const cfg = loadConfig();
    expect(cfg.privateKey).toBe(ZEROES_PK);
    expect(cfg.voterPrivateKey).toBe(`0x${BARE_PK}`);
  });
});

describe('loadConfig — corrupt config files', () => {
  it('silently ignores a malformed cwd .reppo.json (does not throw)', () => {
    const { cwd, home } = freshTmp();
    pointAt(cwd, home);
    writeFileSync(join(cwd, '.reppo.json'), '{ this is not json');
    // Falls through to default — must not crash.
    expect(loadConfig().network).toBe('mainnet');
  });
});
