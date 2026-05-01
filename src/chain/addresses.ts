/**
 * Per-network contract bundles. Mainnet REPPO/PodManager/USDC are fixed and
 * verified. SubnetManager + veReppo mainnet addresses are TBD pending Reppo
 * docs — placeholders throw when accessed so we fail loudly instead of
 * silently sending to 0x0.
 */
import type { Address } from 'viem';

export type Network = 'mainnet' | 'testnet';

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
  podManager:    '0xcfF0511089D0Fbe92E1788E4aFFF3E7930b3D47c',
  subnetManager: TBD, // TODO: confirm mainnet SubnetManager address with Reppo
  reppoToken:    '0xFf8104251E7761163faC3211eF5583FB3F8583d6',
  veReppo:       TBD, // TODO: confirm mainnet veReppo address with Reppo
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

export function getAddresses(network: Network): AddressBundle {
  return network === 'mainnet' ? MAINNET : TESTNET;
}

/**
 * Throws if the address is the TBD placeholder. Use at the call site.
 * The thrown error carries `code: 'ADDRESS_NOT_CONFIGURED'` so agents
 * can distinguish "missing contract address for this network" from
 * generic INTERNAL_ERROR bugs.
 */
export function requireAddress(addr: Address, label: string): Address {
  if (addr === TBD) {
    throw Object.assign(
      new Error(
        `${label} address is not configured for this network yet. ` +
        `Edit src/chain/addresses.ts once Reppo publishes it.`,
      ),
      {
        code: 'ADDRESS_NOT_CONFIGURED',
        hint: `${label} has no address baked in for the selected network. Switch networks with --network, or wait for the address to be published.`,
      },
    );
  }
  return addr;
}
