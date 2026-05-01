/**
 * Layered config:
 *   1. CLI flags (handled by clipanion at the command level)
 *   2. .reppo.json in cwd
 *   3. ~/.reppo/config.json
 *   4. Environment variables
 *   5. Built-in defaults
 *
 * Each value records its source so --debug can print "REPPO_NETWORK=mainnet
 * (from env)".
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Network } from '../chain/addresses.js';

export interface Config {
  network: Network;
  rpcUrl: string | undefined;
  apiUrl: string;
  apiKey: string | undefined;
  privateKey: `0x${string}` | undefined;
  voterPrivateKey: `0x${string}` | undefined;
}

const DEFAULT_API_MAINNET = 'https://api.reppo.xyz';
const DEFAULT_API_TESTNET = 'https://reppofun-env-staging-reppo-ai.vercel.app/api/v1/';

interface RawConfig {
  network?: string;
  rpcUrl?: string;
  apiUrl?: string;
}

function readJsonIfExists(path: string): RawConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as RawConfig;
  } catch {
    return {};
  }
}

function normalizePk(raw: string | undefined): `0x${string}` | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith('0x') && /^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed as `0x${string}`;
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return `0x${trimmed}` as `0x${string}`;
  }
  throw new Error('Private key must be a 32-byte hex string (0x-prefixed or bare 64 hex chars).');
}

export function loadConfig(overrides: { network?: Network } = {}): Config {
  const cwd = readJsonIfExists(join(process.cwd(), '.reppo.json'));
  const home = readJsonIfExists(join(homedir(), '.reppo', 'config.json'));

  const network: Network =
    overrides.network ??
    (process.env.REPPO_NETWORK as Network | undefined) ??
    (cwd.network as Network | undefined) ??
    (home.network as Network | undefined) ??
    'mainnet';

  if (network !== 'mainnet' && network !== 'testnet') {
    throw new Error(`Invalid network "${network}" — must be "mainnet" or "testnet".`);
  }

  const apiUrl =
    process.env.REPPO_API_URL ??
    cwd.apiUrl ??
    home.apiUrl ??
    (network === 'mainnet' ? DEFAULT_API_MAINNET : DEFAULT_API_TESTNET);

  return {
    network,
    rpcUrl: process.env.REPPO_RPC_URL ?? cwd.rpcUrl ?? home.rpcUrl,
    apiUrl,
    apiKey: process.env.REPPO_API_KEY,
    privateKey: normalizePk(process.env.REPPO_PRIVATE_KEY),
    voterPrivateKey: normalizePk(process.env.REPPO_VOTER_PRIVATE_KEY),
  };
}
