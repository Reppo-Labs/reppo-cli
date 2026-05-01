/**
 * Idempotency cache. Agents that retry on transient failure must not
 * double-spend (mint twice, vote twice, etc.). They pass --idempotency-key
 * <stable-string>; we cache (key → result_json) on the first successful
 * call, and short-circuit subsequent calls with the cached result.
 *
 * Keys are scoped per command name to prevent cross-command collisions.
 */
import { getIdempotent as readEntry, saveIdempotent as writeEntry } from './db.js';

interface CachedResult {
  command: string;
  result: Record<string, unknown>;
  txHash: string | null;
  createdAt: number;
}

export async function getIdempotent(key: string, command: string): Promise<CachedResult | null> {
  const entry = await readEntry(key);
  if (!entry) return null;
  if (entry.command !== command) {
    throw new Error(
      `idempotency key "${key}" was previously used by command "${entry.command}", ` +
      `not "${command}". Use a unique key per (command, intent) pair.`,
    );
  }
  return entry;
}

export async function saveIdempotent(
  key: string,
  command: string,
  result: Record<string, unknown>,
  txHash: string | null,
): Promise<void> {
  await writeEntry(key, { command, result, txHash, createdAt: Date.now() });
}
