/**
 * Idempotency layer. Two-phase write protocol so an agent retry that
 * fires *during* a transaction (after submit, before receipt) sees the
 * pending record and short-circuits instead of double-spending.
 *
 *   1. begin(key, command)              — write { status: 'pending' }
 *   2. markSubmitted(key, command, tx)  — write { status: 'submitted', txHash }
 *   3. markConfirmed(key, command, r)   — write { status: 'confirmed', result, txHash }
 *      OR
 *      markFailed(key, command, err)    — write { status: 'failed', result: { error } }
 *
 * Callers should pattern-match `getIdempotent(key)` BEFORE doing work:
 *   - null         → fresh, proceed
 *   - 'confirmed'  → return cached result
 *   - 'submitted'  → return cached txHash; the agent can poll the tx
 *   - 'pending'    → another invocation is mid-flight; refuse with code
 *   - 'failed'     → previous attempt failed; refuse OR allow retry under
 *                    a fresh key (caller policy)
 */
import {
  getIdempotent as readEntry,
  upsertIdempotent,
  type IdempotencyEntry,
  type IdempotencyStatus,
} from './db.js';

export type { IdempotencyEntry, IdempotencyStatus };

export async function getIdempotent(key: string, command: string): Promise<IdempotencyEntry | null> {
  const entry = await readEntry(key);
  if (!entry) return null;
  if (entry.command !== command) {
    throw Object.assign(
      new Error(
        `idempotency key "${key}" was previously used by command "${entry.command}", ` +
        `not "${command}". Use a unique key per (command, intent) pair.`,
      ),
      { code: 'IDEMPOTENCY_COMMAND_MISMATCH' },
    );
  }
  return entry;
}

export async function begin(key: string, command: string): Promise<void> {
  const now = Date.now();
  await upsertIdempotent(key, {
    command,
    status: 'pending',
    result: {},
    txHash: null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function markSubmitted(key: string, command: string, txHash: string): Promise<void> {
  const now = Date.now();
  await upsertIdempotent(key, {
    command,
    status: 'submitted',
    result: { txHash },
    txHash,
    createdAt: now,
    updatedAt: now,
  });
}

export async function markConfirmed(
  key: string,
  command: string,
  result: Record<string, unknown>,
  txHash: string,
): Promise<void> {
  const now = Date.now();
  await upsertIdempotent(key, {
    command,
    status: 'confirmed',
    result,
    txHash,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Mark an idempotency entry as failed. Pass `txHash` when the failure
 * happened *after* the tx was broadcast (e.g. on-chain revert, receipt
 * timeout) so the cached entry retains the hash for forensics + so the
 * "same-key retry on failed" guard in callers can distinguish pre-submit
 * failures (safe to retry) from post-submit failures (must not retry —
 * the tx already executed and may have side-effects).
 */
export async function markFailed(
  key: string,
  command: string,
  error: string,
  txHash: string | null = null,
): Promise<void> {
  const now = Date.now();
  await upsertIdempotent(key, {
    command,
    status: 'failed',
    result: txHash ? { error, txHash } : { error },
    txHash,
    createdAt: now,
    updatedAt: now,
  });
}
