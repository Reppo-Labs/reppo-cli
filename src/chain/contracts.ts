/**
 * Network-aware contract resolver. Returns `{ address, abi }` for each
 * contract so callers can't accidentally pair the wrong ABI with the
 * wrong address (the V1 vs V2 PodManager split is the most common
 * footgun: mainnet uses `mintPod(to, share)` while testnet uses
 * `mintPodWithREPPO(to, subnetId)`).
 *
 * Throws via requireAddress() if the network's address is the TBD
 * placeholder — fails loud rather than silently calling 0x0.
 */
import type { Address } from 'viem';
import { getAddresses, requireAddress, type Network } from './addresses.js';
import {
  POD_MANAGER_MAINNET_ABI,
  POD_MANAGER_TESTNET_ABI,
  SUBNET_MANAGER_ABI,
  VE_REPPO_ABI,
  ERC20_ABI,
} from './abis.js';

export interface Contract<TAbi> {
  address: Address;
  abi: TAbi;
}

export function podManager(network: Network): Contract<typeof POD_MANAGER_MAINNET_ABI | typeof POD_MANAGER_TESTNET_ABI> {
  const addrs = getAddresses(network);
  return {
    address: requireAddress(addrs.podManager, 'PodManager'),
    abi: network === 'mainnet' ? POD_MANAGER_MAINNET_ABI : POD_MANAGER_TESTNET_ABI,
  };
}

export function subnetManager(network: Network): Contract<typeof SUBNET_MANAGER_ABI> {
  const addrs = getAddresses(network);
  return {
    address: requireAddress(addrs.subnetManager, 'SubnetManager'),
    abi: SUBNET_MANAGER_ABI,
  };
}

export function veReppo(network: Network): Contract<typeof VE_REPPO_ABI> {
  const addrs = getAddresses(network);
  return {
    address: requireAddress(addrs.veReppo, 'veReppo'),
    abi: VE_REPPO_ABI,
  };
}

export function reppoToken(network: Network): Contract<typeof ERC20_ABI> {
  const addrs = getAddresses(network);
  return {
    address: requireAddress(addrs.reppoToken, 'REPPO Token'),
    abi: ERC20_ABI,
  };
}

export function usdcToken(network: Network): Contract<typeof ERC20_ABI> {
  const addrs = getAddresses(network);
  return {
    address: requireAddress(addrs.usdc, 'USDC'),
    abi: ERC20_ABI,
  };
}
