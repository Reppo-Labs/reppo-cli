/**
 * Per-network contract bundles. Mainnet contracts are fully wired
 * (PodManager V2, SubnetManager, veReppo, REPPO, USDC, Uniswap). The
 * V1 PodManager 0xcfF051... is intentionally not supported.
 *
 * Testnet USDC remains a TBD placeholder. The placeholder throws on
 * access so we fail loudly instead of silently sending to 0x0.
 */
import type { Address } from 'viem';
import { cliError } from '../output/format.js';

export type Network = 'mainnet' | 'testnet' | 'robinhood';

export interface AddressBundle {
  podManager: Address;
  subnetManager: Address;
  reppoToken: Address;
  veReppo: Address;
  usdc: Address;
  uniswapRouter: Address | null;
  uniswapQuoter: Address | null;
  chainId: number;
}

const TBD = '0x0000000000000000000000000000000000000000' as const;

const MAINNET: AddressBundle = {
  podManager:    '0x5C563f853eb4db33005A5C1aD9290e8560254A80', // PodManager V2 (V1 0xcfF051... deprecated, not supported)
  subnetManager: '0x2629A8083065938B533b117704935D727270eE7A',
  reppoToken:    '0xFf8104251E7761163faC3211eF5583FB3F8583d6',
  veReppo:       '0x0EFBE19Cb7B07D934D01990a8989E9CaA98b9009',
  usdc:          '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  uniswapRouter: '0x2626664c2603336E57B271c5C0b26F421741e481',
  uniswapQuoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  chainId: 8453,
};

const TESTNET: AddressBundle = {
  podManager:    '0x113CcFEcdc8Fb1662fCebd195D9573D1c5e5DFD3',
  subnetManager: '0x33c70A9f578Dc22012AEab40A10758f026004A27',
  reppoToken:    '0xE224a711e18212Cf08EF3808dfa39ccBBd2f18c6',
  veReppo:       '0x76b4Ee62fF835142B3b29D9F91867697657b556D',
  usdc:          TBD, // testnet USDC via faucet — set when needed
  uniswapRouter: null, // no V3 deployment on Sepolia for the REPPO/USDC pool
  uniswapQuoter: null,
  chainId: 84532,
};

// Robinhood Chain mainnet (4663) runs the RBV1 contract variant: fees are paid
// in each subnet's own ERC-20 (no REPPO/USDC on this chain), voting power is
// mirrored from Base veREPPO by robinhood.reppo.ai (no on-chain staking).
// Addresses from robinhood.reppo.ai production config, 2026-07-27.
const ROBINHOOD: AddressBundle = {
  podManager:    '0xeAd1A577B02829b7F634aD7eE30Fbbc2CDF7e478', // PodManagerRBV1
  subnetManager: '0xDAd72306b2ee410B20795D353cF7913AA7Eb15aa', // SubnetManagerRBV1
  reppoToken:    TBD, // no REPPO token on Robinhood Chain
  veReppo:       '0x15949C1727076a546eB055e9AB9E5bD32f069Db2', // VeReppoRBV1 (read-only mirror, no staking)
  usdc:          TBD, // no USDC on Robinhood Chain
  uniswapRouter: null,
  uniswapQuoter: null,
  chainId: 4663,
};

const BUNDLES: Record<Network, AddressBundle> = {
  mainnet: MAINNET,
  testnet: TESTNET,
  robinhood: ROBINHOOD,
};

export function getAddresses(network: Network): AddressBundle {
  return BUNDLES[network];
}

/**
 * Throws if the address is the TBD placeholder. Use at the call site.
 * The thrown error carries `code: 'ADDRESS_NOT_CONFIGURED'` so agents
 * can distinguish "missing contract address for this network" from
 * generic INTERNAL_ERROR bugs.
 */
export function requireAddress(addr: Address, label: string): Address {
  if (addr === TBD) {
    throw cliError(
      'ADDRESS_NOT_CONFIGURED',
      `${label} address is not configured for this network yet. ` +
        `Edit src/chain/addresses.ts once Reppo publishes it.`,
      `${label} has no address baked in for the selected network. Switch networks with --network, or wait for the address to be published.`,
    );
  }
  return addr;
}
