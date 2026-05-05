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
import { cliError } from '../output/format.js';

export type { IdempotencyEntry, IdempotencyStatus };

/**
 * Decision returned by `peekIdempotent` so write commands can decide what
 * to do *before* spending gas:
 *   - 'proceed'           — no cache hit (or pre-submit failure); do the work.
 *   - 'return-confirmed'  — cache has a final result; emit it and skip.
 *   - 'return-submitted'  — cache has a tx hash that hasn't confirmed yet;
 *                           emit it and tell the caller to poll the explorer.
 * Two terminal "do not retry" states (`pending`, `failed-after-broadcast`)
 * throw inside the helper because they never make sense to handle inline.
 */
export type CacheDecision<R> =
  | { kind: 'proceed' }
  | { kind: 'return-confirmed'; result: R; txHash: string | null }
  | { kind: 'return-submitted'; result: R; txHash: string | null };

/**
 * SHA-256 of the canonicalized JSON of the args object. Object keys are
 * sorted so {a:1,b:2} and {b:2,a:1} fingerprint identically; bigints
 * are stringified so they survive JSON.stringify; nested arrays/objects
 * recurse. The output is the only thing the cache compares — small
 * representation choices below matter for matching across runs.
 */
export function fingerprintArgs(args: Record<string, unknown>): string {
  const replacer = (_key: string, value: unknown): unknown => {
    if (typeof value === 'bigint') return value.toString();
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  };
  const canonical = JSON.stringify(args, replacer);
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

/**
 * Inspect the idempotency cache and decide whether the caller should
 * proceed with a write. Lifts the cache-decision logic that previously
 * lived inline in `vote.ts` so every write command shares the same
 * policy:
 *   - dry-run: never consult or mutate the cache (sim is read-only;
 *     persisting a "submitted" record would let a sim poison the cache
 *     for the next real call).
 *   - confirmed: short-circuit with the cached result.
 *   - submitted: short-circuit with the cached tx hash; user polls.
 *   - pending:   refuse — another invocation is mid-flight.
 *   - failed + txHash: refuse — re-broadcasting under the same key would
 *     pay gas for a second doomed attempt; force a fresh key.
 *   - failed + no txHash: pre-submit failure, safe to retry: 'proceed'.
 *
 * The result type `R` matches the shape the command stores via
 * `markConfirmed` (e.g. `{ txHash, podId, ..., basescanUrl }` for vote).
 * Cached results are typed as the caller's `R`; runtime shape is whatever
 * the original `markConfirmed` recorded.
 */
export async function peekIdempotent<R>(
  key: string | undefined,
  command: string,
  args: Record<string, unknown>,
  isDryRun: boolean,
): Promise<CacheDecision<R>> {
  if (!key || isDryRun) return { kind: 'proceed' };

  const cached = await getIdempotent(key, command, args);
  if (!cached) return { kind: 'proceed' };

  switch (cached.status) {
    case 'confirmed':
      return { kind: 'return-confirmed', result: cached.result as R, txHash: cached.txHash };
    case 'submitted':
      return { kind: 'return-submitted', result: cached.result as R, txHash: cached.txHash };
    case 'pending':
      throw cliError(
        'IDEMPOTENCY_IN_FLIGHT',
        `Idempotency key "${key}" is in 'pending' state — another invocation is mid-flight.`,
        'Wait for the in-flight invocation to finish, or use a fresh key.',
      );
    case 'failed':
      if (cached.txHash) {
        throw cliError(
          'IDEMPOTENCY_FAILED_AFTER_BROADCAST',
          `Idempotency key "${key}" previously broadcast tx ${cached.txHash} which failed. ` +
            `Refusing to re-broadcast under the same key.`,
          'Use a fresh --idempotency-key for the retry, and inspect the prior tx on the block explorer to understand the failure.',
        );
      }
      // Pre-submit failure (e.g. validation error). Safe to retry under
      // the same key; fall through.
      return { kind: 'proceed' };
  }
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
