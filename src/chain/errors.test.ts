import { describe, it, expect } from 'vitest';
import { BaseError, ContractFunctionRevertedError } from 'viem';
import { decodeRevert } from './errors.js';

// Fixture: real viem ContractFunctionRevertedError with a chosen signature.
// The decoder pulls `signature` directly off this instance.
function revertedWith(signature: `0x${string}`): ContractFunctionRevertedError {
  const err = new ContractFunctionRevertedError({
    abi: [],
    functionName: 'vote',
  });
  // Inject the selector — `signature` is what decodeRevert reads.
  Object.assign(err, { signature });
  return err;
}

describe('decodeRevert', () => {
  describe('non-viem errors', () => {
    it('returns REVERT fallback for a plain Error', () => {
      const result = decodeRevert(new Error('something blew up'));
      expect(result.code).toBe('REVERT');
      expect(result.hint).toBe('something blew up');
    });

    it('returns REVERT fallback for a non-Error value', () => {
      const result = decodeRevert('a string');
      expect(result.code).toBe('REVERT');
    });
  });

  describe('viem BaseError without a ContractFunctionRevertedError', () => {
    // ── REGEX-REGRESSION GUARD ─────────────────────────────────────────
    // If decodeRevert ever regresses to scanning the message text for a
    // hex selector (instead of using BaseError.walk), the first 4 bytes of
    // an embedded contract address would be misread as a custom-error
    // selector. Pin the chosen behavior: this MUST fall through to REVERT,
    // not UNKNOWN_REVERT_0xcff05110 or similar address-derived nonsense.
    it('does NOT mistake an address embedded in the message for a selector', () => {
      const err = new BaseError(
        'Contract Call: address: 0xcfF0511089D0Fbe92E1788E4aFFF3E7930b3D47c failed',
      );
      const result = decodeRevert(err);
      expect(result.code).toBe('REVERT');
      expect(result.code).not.toMatch(/^UNKNOWN_REVERT_0xcff05110/i);
      expect(result.code).not.toMatch(/^UNKNOWN_REVERT_/);
    });

    it('uses the BaseError shortMessage as the hint', () => {
      const err = new BaseError('rpc node went away');
      const result = decodeRevert(err);
      expect(result.code).toBe('REVERT');
      expect(result.hint).toContain('rpc node went away');
    });
  });

  describe('viem ContractFunctionRevertedError', () => {
    it('maps a known selector to its code + hint', () => {
      const result = decodeRevert(revertedWith('0xcabeb655'));
      expect(result.code).toBe('INSUFFICIENT_VOTING_POWER');
      expect(result.hint).toContain('Lock REPPO');
    });

    it('maps another known selector', () => {
      const result = decodeRevert(revertedWith('0x5bdedc41'));
      expect(result.code).toBe('PUBLISHER_LACKS_SUBNET_ACCESS');
    });

    it('returns UNKNOWN_REVERT_<sel> for an unrecognized selector', () => {
      const result = decodeRevert(revertedWith('0xdeadbeef'));
      expect(result.code).toBe('UNKNOWN_REVERT_0xdeadbeef');
    });

    it('lowercases the selector for SELECTORS lookup', () => {
      // Selectors in the SELECTORS map are stored lowercase. An uppercased
      // selector from viem must still match.
      const result = decodeRevert(revertedWith('0xCABEB655'));
      expect(result.code).toBe('INSUFFICIENT_VOTING_POWER');
    });
  });
});
