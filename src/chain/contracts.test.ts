import { describe, it, expect } from 'vitest';
import {
  tryPodManager,
  trySubnetManager,
  tryVeReppo,
  tryReppoToken,
  tryUsdcToken,
  erc20,
} from './contracts.js';
import { SUBNET_MANAGER_ABI } from './abis.js';

describe('tryX() non-throwing contract helpers', () => {
  describe('mainnet', () => {
    it('tryPodManager returns the mainnet ABI bound to the mainnet address', () => {
      const c = tryPodManager('mainnet');
      expect(c).not.toBeNull();
      expect(c?.address).toBe('0x5C563f853eb4db33005A5C1aD9290e8560254A80');
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

    it('tryVeReppo returns the live mainnet veReppo address', () => {
      expect(tryVeReppo('mainnet')?.address).toBe('0x0EFBE19Cb7B07D934D01990a8989E9CaA98b9009');
    });

    it('trySubnetManager returns the live mainnet SubnetManager address', () => {
      expect(trySubnetManager('mainnet')?.address).toBe('0x2629A8083065938B533b117704935D727270eE7A');
    });
  });

  describe('testnet', () => {
    it('tryPodManager returns the testnet ABI', () => {
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

describe('SUBNET_MANAGER_ABI — primary-token access surface', () => {
  const fnNames = SUBNET_MANAGER_ABI.filter((e) => e.type === 'function').map((e) => e.name);

  it('includes accessSubnetWithPrimaryTokenFee', () => {
    expect(fnNames).toContain('accessSubnetWithPrimaryTokenFee');
  });
  it('includes getAccessFeePrimaryToken', () => {
    expect(fnNames).toContain('getAccessFeePrimaryToken');
  });
  it('includes getSubnetPrimaryToken', () => {
    expect(fnNames).toContain('getSubnetPrimaryToken');
  });
});

describe('erc20(address) — generic ERC20 resolver', () => {
  it('binds the ERC20 ABI to an arbitrary token address', () => {
    const addr = '0x1234567890123456789012345678901234567890' as const;
    const c = erc20(addr);
    expect(c.address).toBe(addr);
    expect(c.abi.some((e) => e.type === 'function' && e.name === 'decimals')).toBe(true);
    expect(c.abi.some((e) => e.type === 'function' && e.name === 'balanceOf')).toBe(true);
    expect(c.abi.some((e) => e.type === 'function' && e.name === 'allowance')).toBe(true);
  });
});
