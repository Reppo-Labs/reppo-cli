/**
 * Idempotency layer. Two-phase write protocol so an agent retry that
 * fires *during* a transaction (after submit, before receipt) sees the
 * pending record and short-circuits instead of double-spending.
 *
 *   1. begin(key, command, args)            — write { status: 'pending' }
 *   2. markSubmitted(key, command, args, tx)— write { status: 'submitted', txHash }
 *   3. markConfirmed(key, command, args, r) — write { status: 'confirmed', result, txHash }
 *      OR
 *      markFailed(key, command, args, err)  — write { status: 'failed', result: { error } }
 *
 * Every helper takes the full args object so a deterministic fingerprint
 * can be stored on first write. Re-using one --idempotency-key with a
 * different intent (e.g. vote pod 39 like → vote pod 41 dislike) is
 * rejected with `IDEMPOTENCY_ARGS_MISMATCH` instead of silently
 * returning the wrong cached result.
 *
 * Callers should pattern-match `getIdempotent(key, command, args)`
 * BEFORE doing work:
 *   - null         → fresh, proceed
 *   - 'confirmed'  → return cached result
 *   - 'submitted'  → return cached txHash; the agent can poll the tx
 *   - 'pending'    → another invocation is mid-flight; refuse with code
 *   - 'failed'     → previous attempt failed; refuse OR allow retry under
 *                    a fresh key (caller policy)
 */
import { createHash } from 'node:crypto';
import {
  getIdempotent as readEntry,
  upsertIdempotent,
  type IdempotencyEntry,
  type IdempotencyStatus,
} from './db.js';

export type { IdempotencyEntry, IdempotencyStatus };

/**
 * SHA-256 of the canonicalized JSON of the args object. Object keys are
 * sorted so {a:1,b:2} and {b:2,a:1} fingerprint identically; bigints
 * are stringified so they survive JSON.stringify; nested arrays/objects
 * recurse. The output is the only thing the cache compares — small
 * representation choices below matter for matching across runs.
 */
export function fingerprintArgs(args: Record<string, unknown>): string {
  const canonical = JSON.stringify(args, (_key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export async function getIdempotent(
  key: string,
  command: string,
  args: Record<string, unknown>,
): Promise<IdempotencyEntry | null> {
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
  const fp = fingerprintArgs(args);
  // Pre-v0.2 cache entries lack argsFingerprint. Refuse with a clear
  // migration error rather than silently treating any args as a match.
  if (!entry.argsFingerprint) {
    throw Object.assign(
      new Error(
        `idempotency key "${key}" predates v0.2's args-fingerprint check and cannot be safely re-used.`,
      ),
      {
        code: 'IDEMPOTENCY_LEGACY_ENTRY',
        hint: 'Delete ~/.reppo/cli-state.json (or set REPPO_STATE_PATH to a fresh file) to clear the legacy cache, then retry with a new --idempotency-key.',
      },
    );
  }
  if (entry.argsFingerprint !== fp) {
    throw Object.assign(
      new Error(
        `idempotency key "${key}" was previously used with different args ` +
        `(fingerprint ${entry.argsFingerprint.slice(0, 12)}…) and is now being read with new args ` +
        `(fingerprint ${fp.slice(0, 12)}…).`,
      ),
      {
        code: 'IDEMPOTENCY_ARGS_MISMATCH',
        hint: 'A given idempotency key represents a single intent. Use a fresh key when the args change.',
      },
    );
  }
  return entry;
}

export async function begin(
  key: string,
  command: string,
  args: Record<string, unknown>,
): Promise<void> {
  const now = Date.now();
  await upsertIdempotent(key, {
    command,
    argsFingerprint: fingerprintArgs(args),
    status: 'pending',
    result: {},
    txHash: null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function markSubmitted(
  key: string,
  command: string,
  args: Record<string, unknown>,
  txHash: string,
): Promise<void> {
  const now = Date.now();
  await upsertIdempotent(key, {
    command,
    argsFingerprint: fingerprintArgs(args),
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
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  txHash: string,
): Promise<void> {
  const now = Date.now();
  await upsertIdempotent(key, {
    command,
    argsFingerprint: fingerprintArgs(args),
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
  args: Record<string, unknown>,
  error: string,
  txHash: string | null = null,
): Promise<void> {
  const now = Date.now();
  await upsertIdempotent(key, {
    command,
    argsFingerprint: fingerprintArgs(args),
    status: 'failed',
    result: txHash ? { error, txHash } : { error },
    txHash,
    createdAt: now,
    updatedAt: now,
  });
}
