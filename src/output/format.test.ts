import { describe, it, expect, beforeEach } from 'vitest';
import { setOutputMode, getOutputMode } from './format.js';

describe('output/format', () => {
  beforeEach(() => {
    setOutputMode('human');
  });

  it('defaults to human mode', () => {
    expect(getOutputMode()).toBe('human');
  });

  it('round-trips json mode through setOutputMode', () => {
    setOutputMode('json');
    expect(getOutputMode()).toBe('json');
    setOutputMode('human');
    expect(getOutputMode()).toBe('human');
  });
});
