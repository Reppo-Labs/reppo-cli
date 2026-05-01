/**
 * Tiny JSON-file store at ~/.reppo/cli-state.json. Used for the
 * idempotency cache and platform-API session tokens. Pure JS — no native
 * deps. Concurrent CLI invocations are serialized via proper-lockfile.
 *
 * Schema:
 *   {
 *     idempotency: { [key]: { command, result, txHash, createdAt } },
 *     sessions:    { [`${network}:${name}`]: { agentId, accessToken, walletAddress, createdAt } }
 *   }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import lockfile from 'proper-lockfile';

interface IdempotencyEntry {
  command: string;
  result: Record<string, unknown>;
  txHash: string | null;
  createdAt: number;
}

interface SessionEntry {
  agentId: string;
  accessToken: string;
  walletAddress: string | null;
  createdAt: number;
}

interface State {
  idempotency: Record<string, IdempotencyEntry>;
  sessions: Record<string, SessionEntry>;
}

function statePath(): string {
  return process.env.REPPO_STATE_PATH ?? `${homedir()}/.reppo/cli-state.json`;
}

function readState(): State {
  const path = statePath();
  if (!existsSync(path)) return { idempotency: {}, sessions: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as State;
  } catch {
    return { idempotency: {}, sessions: {} };
  }
}

async function writeState(s: State): Promise<void> {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, JSON.stringify({ idempotency: {}, sessions: {} }), { mode: 0o600 });
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 50, maxTimeout: 500 } });
  try {
    writeFileSync(path, JSON.stringify(s, null, 2), { mode: 0o600 });
  } finally {
    await release();
  }
}

export async function getIdempotent(key: string): Promise<IdempotencyEntry | null> {
  const s = readState();
  return s.idempotency[key] ?? null;
}

export async function saveIdempotent(key: string, entry: IdempotencyEntry): Promise<void> {
  const s = readState();
  if (s.idempotency[key]) return;
  s.idempotency[key] = entry;
  await writeState(s);
}

export async function getSession(network: string, name: string): Promise<SessionEntry | null> {
  const s = readState();
  return s.sessions[`${network}:${name}`] ?? null;
}

export async function saveSession(network: string, name: string, entry: SessionEntry): Promise<void> {
  const s = readState();
  s.sessions[`${network}:${name}`] = entry;
  await writeState(s);
}
