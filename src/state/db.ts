/**
 * Tiny JSON-file store at ~/.reppo/cli-state.json. Used for the
 * idempotency cache and platform-API session tokens. Pure JS — no native
 * deps. Concurrent CLI invocations are serialized via proper-lockfile.
 *
 * Schema:
 *   {
 *     idempotency: { [key]: { command, status, result, txHash, createdAt, updatedAt } },
 *     sessions:    { [`${network}:${name}`]: { agentId, accessToken, walletAddress, createdAt } }
 *   }
 *
 * Concurrency model: every read-modify-write goes through `withLockedState`
 * which acquires a proper-lockfile lock on the state file path BEFORE the
 * read. Concurrent invocations queue. The state file is touched (created
 * empty) under the same lock to avoid the lockfile-on-nonexistent-file
 * footgun.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import lockfile from 'proper-lockfile';

export type IdempotencyStatus = 'pending' | 'submitted' | 'confirmed' | 'failed';

export interface IdempotencyEntry {
  command: string;
  status: IdempotencyStatus;
  result: Record<string, unknown>;
  txHash: string | null;
  createdAt: number;
  updatedAt: number;
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

function emptyState(): State {
  return { idempotency: {}, sessions: {} };
}

/**
 * Ensure the state file exists with 0o600 perms. Idempotent. The
 * proper-lockfile library refuses to lock a non-existent path, so we
 * have to create it before requesting the lock.
 */
function ensureFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(emptyState()), { mode: 0o600 });
    return;
  }
  // Re-assert 0o600 on every access. `mode` in writeFileSync only takes
  // effect on creation; if a user ever chmodded the file, this fixes it.
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

function readUnsafe(path: string): State {
  const raw = readFileSync(path, 'utf-8');
  try {
    const parsed = JSON.parse(raw) as Partial<State>;
    return {
      idempotency: parsed.idempotency ?? {},
      sessions: parsed.sessions ?? {},
    };
  } catch (err) {
    // Corrupt state — quarantine the bad file and start fresh, but
    // surface the corruption to the user. Silently dropping records
    // would defeat the whole idempotency contract.
    const quarantine = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, quarantine); } catch { /* best-effort */ }
    process.stderr.write(
      `[reppo-cli] WARNING: state file ${path} was corrupt and has been ` +
      `moved to ${quarantine}. Idempotency cache reset. Original error: ${(err as Error).message}\n`,
    );
    return emptyState();
  }
}

function writeUnsafe(path: string, s: State): void {
  writeFileSync(path, JSON.stringify(s, null, 2), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

/**
 * Acquire the state-file lock, run `mutator(currentState)`, persist its
 * return value, release the lock. The mutator runs inside the critical
 * section so reads + decisions + writes are atomic.
 */
async function withLockedState<T>(
  mutator: (s: State) => { state: State; result: T } | Promise<{ state: State; result: T }>,
): Promise<T> {
  const path = statePath();
  ensureFile(path);
  const release = await lockfile.lock(path, {
    retries: { retries: 10, minTimeout: 50, maxTimeout: 500, factor: 2 },
    stale: 10_000,
  });
  try {
    const current = readUnsafe(path);
    const next = await mutator(current);
    writeUnsafe(path, next.state);
    return next.result;
  } finally {
    await release();
  }
}

/** Read-only state access. Acquires the lock briefly. */
async function readLocked(): Promise<State> {
  return withLockedState((s) => ({ state: s, result: s }));
}

// ── Idempotency API ────────────────────────────────────────────────────

export async function getIdempotent(key: string): Promise<IdempotencyEntry | null> {
  const s = await readLocked();
  return s.idempotency[key] ?? null;
}

/**
 * Insert OR update an idempotency entry under the lock. Allowed
 * transitions:
 *   - first write (no prior entry): always allowed
 *   - same command, status progression (pending → submitted → confirmed,
 *     pending → failed): allowed
 *   - different command for the same key: rejected (caller bug)
 *   - confirmed → anything: rejected (final state)
 */
export async function upsertIdempotent(key: string, entry: IdempotencyEntry): Promise<void> {
  await withLockedState((s) => {
    const prior = s.idempotency[key];
    if (prior) {
      if (prior.command !== entry.command) {
        throw new Error(
          `idempotency key "${key}" was previously used by command "${prior.command}", ` +
          `not "${entry.command}". Use a unique key per (command, intent) pair.`,
        );
      }
      if (prior.status === 'confirmed') {
        throw new Error(
          `idempotency key "${key}" is already in terminal state "confirmed"; ` +
          `refusing to overwrite. Use a new key for a new attempt.`,
        );
      }
    }
    s.idempotency[key] = { ...entry, updatedAt: Date.now() };
    return { state: s, result: undefined };
  });
}

// ── Session API ────────────────────────────────────────────────────────

export async function getSession(network: string, name: string): Promise<SessionEntry | null> {
  const s = await readLocked();
  return s.sessions[`${network}:${name}`] ?? null;
}

export async function saveSession(network: string, name: string, entry: SessionEntry): Promise<void> {
  await withLockedState((s) => {
    s.sessions[`${network}:${name}`] = entry;
    return { state: s, result: undefined };
  });
}
