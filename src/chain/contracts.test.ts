import { describe, it, expect } from 'vitest';
import {
  tryPodManager,
  trySubnetManager,
  tryVeReppo,
  tryReppoToken,
  tryUsdcToken,
} from './contracts.js';

describe('tryX() non-throwing contract helpers', () => {
  describe('mainnet', () => {
    it('tryPodManager returns the V1 ABI bound to the mainnet address', () => {
      const c = tryPodManager('mainnet');
      expect(c).not.toBeNull();
      expect(c?.address).toBe('0xcfF0511089D0Fbe92E1788E4aFFF3E7930b3D47c');
      expect(c?.abi).toBeDefined();
    });

    it('tryReppoToken returns the ERC20 contract', () => {
      const c = tryReppoToken('mainnet');
      expect(c?.address).toBe('0xFf8104251E7761163faC3211eF5583FB3F8583d6');
    });

    it('tryUsdcToken returns the canonical Base USDC', () => {
      const c = tryUsdcToken('mainnet');
      expect(c?.address).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    });

    it('returns null for contracts whose address is the TBD placeholder', () => {
      // SubnetManager + veReppo are TBD on mainnet today.
      expect(trySubnetManager('mainnet')).toBeNull();
      expect(tryVeReppo('mainnet')).toBeNull();
    });
  });

  describe('testnet', () => {
    it('tryPodManager returns the V2 ABI', () => {
      const c = tryPodManager('testnet');
      expect(c?.address).toBe('0x113CcFEcdc8Fb1662fCebd195D9573D1c5e5DFD3');
    });

    it('returns real veReppo + subnetManager on testnet', () => {
      expect(tryVeReppo('testnet')?.address).toBe('0x76b4Ee62fF835142B3b29D9F91867697657b556D');
      expect(trySubnetManager('testnet')?.address).toBe('0x33c70A9f578Dc22012AEab40A10758f026004A27');
    });

    it('returns null for USDC (TBD on testnet)', () => {
      expect(tryUsdcToken('testnet')).toBeNull();
    });
  });
});
