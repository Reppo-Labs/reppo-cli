import { describe, it, expect } from 'vitest';
import { cliError } from './format.js';

describe('cliError', () => {
  it('returns an Error with code attached', () => {
    const err = cliError('FOO', 'something went wrong');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('something went wrong');
    expect(err.code).toBe('FOO');
    expect(err.hint).toBeUndefined();
  });

  it('attaches hint when provided', () => {
    const err = cliError('BAR', 'msg', 'try X first');
    expect(err.code).toBe('BAR');
    expect(err.hint).toBe('try X first');
  });

  it('omits hint property entirely when not provided (not undefined)', () => {
    // exactOptionalPropertyTypes distinguishes "no key" from "key: undefined".
    // fail() only renders the hint when the key is actually present.
    const err = cliError('BAZ', 'msg');
    expect(Object.prototype.hasOwnProperty.call(err, 'hint')).toBe(false);
  });

  it('preserves stack trace from new Error()', () => {
    const err = cliError('STACK', 'msg');
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('msg');
  });
});
