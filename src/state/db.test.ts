import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, statSync, chmodSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { upsertIdempotent, getIdempotent, type IdempotencyEntry } from './db.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'reppo-db-'));

function freshStatePath(): string {
  const slot = mkdtempSync(join(tmpRoot, 'slot-'));
  return join(slot, '.reppo', 'cli-state.json');
}

function entry(overrides: Partial<IdempotencyEntry> = {}): IdempotencyEntry {
  const now = Date.now();
  return {
    command: 'vote',
    argsFingerprint: 'a'.repeat(64),
    status: 'pending',
    result: {},
    txHash: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.REPPO_STATE_PATH = freshStatePath();
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('db: ensureFile creates state with secure perms', () => {
  it('creates the parent directory at 0o700 and the file at 0o600', async () => {
    const path = process.env.REPPO_STATE_PATH!;
    await upsertIdempotent('k1', entry());
    expect(existsSync(path)).toBe(true);

    const fileMode = statSync(path).mode & 0o777;
    expect(fileMode).toBe(0o600);

    const dirMode = statSync(dirname(path)).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });

  it('re-asserts 0o600 on an existing file with looser perms', async () => {
    const path = process.env.REPPO_STATE_PATH!;
    await upsertIdempotent('k1', entry());
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);

    // Any subsequent read goes through ensureFile → re-asserts 0o600.
    await getIdempotent('k1');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('db: corrupt-state quarantine', () => {
  it('moves a corrupt state file to <path>.corrupt-<ts> and starts fresh', async () => {
    const path = process.env.REPPO_STATE_PATH!;
    // Seed a valid file first so ensureFile doesn't recreate it as empty.
    await upsertIdempotent('seed', entry());
    // Now corrupt it.
    writeFileSync(path, '{ this is not json', { mode: 0o600 });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await getIdempotent('anything');
    expect(result).toBeNull(); // fresh empty state

    // Quarantine file exists and has 0o600.
    const dir = dirname(path);
    const quarantined = readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    expect(quarantined.length).toBe(1);
    expect(statSync(join(dir, quarantined[0]!)).mode & 0o777).toBe(0o600);

    // Warning surfaced to stderr (not silently swallowed — that would
    // defeat the idempotency contract).
    const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allWrites).toMatch(/state file .* was corrupt/);
    expect(allWrites).toMatch(/Idempotency cache reset/);
    stderrSpy.mockRestore();
  });
});

describe('db: upsertIdempotent allowed-transition guards', () => {
  it('rejects cross-command reuse with IDEMPOTENCY_COMMAND_MISMATCH', async () => {
    await upsertIdempotent('shared', entry({ command: 'vote' }));
    await expect(
      upsertIdempotent('shared', entry({ command: 'mint-pod' })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_COMMAND_MISMATCH' });
  });

  it('rejects same-command different-args with IDEMPOTENCY_ARGS_MISMATCH', async () => {
    await upsertIdempotent('argkey', entry({ argsFingerprint: 'a'.repeat(64) }));
    await expect(
      upsertIdempotent('argkey', entry({ argsFingerprint: 'b'.repeat(64) })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_ARGS_MISMATCH' });
  });

  it('rejects writes after confirmed (terminal state) with IDEMPOTENCY_TERMINAL_STATE', async () => {
    await upsertIdempotent('done', entry({ status: 'pending' }));
    await upsertIdempotent('done', entry({ status: 'submitted', txHash: '0xabc' }));
    await upsertIdempotent('done', entry({ status: 'confirmed', txHash: '0xabc', result: { ok: true } }));
    // Now confirmed — any further write must be rejected.
    await expect(
      upsertIdempotent('done', entry({ status: 'failed', txHash: '0xabc' })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_TERMINAL_STATE' });
  });

  it('allows transitions through pending → submitted → confirmed under same key', async () => {
    await upsertIdempotent('flow', entry({ status: 'pending' }));
    await upsertIdempotent('flow', entry({ status: 'submitted', txHash: '0x1', result: { txHash: '0x1' } }));
    await upsertIdempotent('flow', entry({ status: 'confirmed', txHash: '0x1', result: { txHash: '0x1', ok: true } }));
    const final = await getIdempotent('flow');
    expect(final?.status).toBe('confirmed');
    expect(final?.txHash).toBe('0x1');
  });
});

describe('db: withLockedState serializes concurrent writes', () => {
  it('two parallel upserts to different keys both persist', async () => {
    await Promise.all([
      upsertIdempotent('a', entry({ argsFingerprint: 'a'.repeat(64) })),
      upsertIdempotent('b', entry({ argsFingerprint: 'b'.repeat(64) })),
    ]);
    expect(await getIdempotent('a')).not.toBeNull();
    expect(await getIdempotent('b')).not.toBeNull();
  });
});
