import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fingerprintArgs,
  peekIdempotent,
  begin,
  markSubmitted,
  markConfirmed,
  markFailed,
} from './idempotency.js';

// Each test points REPPO_STATE_PATH at a fresh tmp file so concurrent
// runs and prior leftovers can't pollute assertions.
const tmpRoot = mkdtempSync(join(tmpdir(), 'reppo-idem-'));
let stateFile = '';

beforeEach(() => {
  stateFile = join(tmpRoot, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  process.env.REPPO_STATE_PATH = stateFile;
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('fingerprintArgs', () => {
  it('is deterministic regardless of key order', () => {
    const a = fingerprintArgs({ podId: '1', subnetId: '2', like: true });
    const b = fingerprintArgs({ like: true, subnetId: '2', podId: '1' });
    expect(a).toBe(b);
  });

  it('differs when any value changes', () => {
    const base = fingerprintArgs({ podId: '1', like: true });
    expect(fingerprintArgs({ podId: '2', like: true })).not.toBe(base);
    expect(fingerprintArgs({ podId: '1', like: false })).not.toBe(base);
  });

  it('handles bigint via toString()', () => {
    const a = fingerprintArgs({ amount: 1000n });
    const b = fingerprintArgs({ amount: '1000' });
    expect(a).toBe(b);
  });

  it('sorts nested object keys', () => {
    const a = fingerprintArgs({ outer: { a: 1, b: 2 } });
    const b = fingerprintArgs({ outer: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  it('returns 64-char hex (sha256)', () => {
    expect(fingerprintArgs({ k: 'v' })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('peekIdempotent', () => {
  const COMMAND = 'vote';
  const args = { podId: '34', subnetId: '19', like: true };

  it("returns 'proceed' when key is undefined", async () => {
    const d = await peekIdempotent(undefined, COMMAND, args, false);
    expect(d.kind).toBe('proceed');
  });

  it("returns 'proceed' when isDryRun=true (never consults cache)", async () => {
    await begin('k1', COMMAND, args);
    await markConfirmed('k1', COMMAND, args, { txHash: '0xabc' }, '0xabc');
    const d = await peekIdempotent('k1', COMMAND, args, true);
    expect(d.kind).toBe('proceed');
  });

  it("returns 'proceed' when no cache entry exists", async () => {
    const d = await peekIdempotent('fresh-key', COMMAND, args, false);
    expect(d.kind).toBe('proceed');
  });

  it("returns 'return-confirmed' with cached result + txHash", async () => {
    await begin('k2', COMMAND, args);
    await markConfirmed('k2', COMMAND, args, { txHash: '0xdef', podId: '34' }, '0xdef');
    const d = await peekIdempotent<{ txHash: string; podId: string }>('k2', COMMAND, args, false);
    expect(d.kind).toBe('return-confirmed');
    if (d.kind === 'return-confirmed') {
      expect(d.txHash).toBe('0xdef');
      expect(d.result.txHash).toBe('0xdef');
      expect(d.result.podId).toBe('34');
    }
  });

  it("returns 'return-submitted' for tx that hasn't confirmed yet", async () => {
    await begin('k3', COMMAND, args);
    await markSubmitted('k3', COMMAND, args, '0xpend');
    const d = await peekIdempotent('k3', COMMAND, args, false);
    expect(d.kind).toBe('return-submitted');
    if (d.kind === 'return-submitted') {
      expect(d.txHash).toBe('0xpend');
    }
  });

  it("throws IDEMPOTENCY_IN_FLIGHT for 'pending' status", async () => {
    await begin('k4', COMMAND, args);
    await expect(peekIdempotent('k4', COMMAND, args, false)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_FLIGHT',
    });
  });

  it("throws IDEMPOTENCY_FAILED_AFTER_BROADCAST for 'failed' with txHash", async () => {
    await begin('k5', COMMAND, args);
    await markFailed('k5', COMMAND, args, 'TX_REVERTED', '0xbad');
    await expect(peekIdempotent('k5', COMMAND, args, false)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_FAILED_AFTER_BROADCAST',
    });
  });

  it("returns 'proceed' for 'failed' WITHOUT txHash (pre-submit failure)", async () => {
    await begin('k6', COMMAND, args);
    await markFailed('k6', COMMAND, args, 'PRE_SUBMIT_VALIDATION');
    const d = await peekIdempotent('k6', COMMAND, args, false);
    expect(d.kind).toBe('proceed');
  });

  it('rejects key reuse across different commands (via underlying getIdempotent)', async () => {
    await begin('shared', 'vote', args);
    await markConfirmed('shared', 'vote', args, { ok: true }, '0x1');
    await expect(peekIdempotent('shared', 'mint-pod', args, false)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_COMMAND_MISMATCH',
    });
  });

  it('rejects key reuse with different args under same command', async () => {
    await begin('argkey', COMMAND, { podId: '1', subnetId: '1', like: true });
    await markConfirmed('argkey', COMMAND, { podId: '1', subnetId: '1', like: true }, { ok: 1 }, '0x1');
    await expect(
      peekIdempotent('argkey', COMMAND, { podId: '2', subnetId: '1', like: true }, false),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_ARGS_MISMATCH' });
  });

  it("returns 'proceed' for stale pending (crashed mid-flight)", async () => {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { PENDING_STALE_MS } = await import('./idempotency.js');
    await begin('stale-p', COMMAND, args);
    const path = process.env.REPPO_STATE_PATH!;
    const state = JSON.parse(readFileSync(path, 'utf8')) as {
      idempotency: Record<string, { updatedAt: number }>;
    };
    state.idempotency['stale-p'].updatedAt = Date.now() - PENDING_STALE_MS - 1000;
    writeFileSync(path, JSON.stringify(state));
    const d = await peekIdempotent('stale-p', COMMAND, args, false);
    expect(d.kind).toBe('proceed');
  });
});
