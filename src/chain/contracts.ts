/**
 * Network-aware contract resolver. Returns `{ address, abi }` for each
 * contract so callers can't accidentally pair the wrong ABI with the
 * wrong address.
 *
 * As of PodManager V2 (CLI 0.3.0+), mainnet and testnet share the same
 * PodManager ABI. The pre-V2 mainnet-specific `mintPod(to, share)` /
 * `publishingFee()` shape is gone; both networks use
 * `mintPodWithREPPO(to, subnetId)` and `vote(podId, votes, upVote)`.
 *
 * Throws via requireAddress() if the network's address is the TBD
 * placeholder — fails loud rather than silently calling 0x0.
 */
import type { Address } from 'viem';
import { getAddresses, requireAddress, type Network } from './addresses.js';
import {
  POD_MANAGER_ABI,
  SUBNET_MANAGER_ABI,
  VE_REPPO_ABI,
  ERC20_ABI,
} from './abis.js';

export interface Contract<TAbi> {
  address: Address;
  abi: TAbi;
}

export function podManager(network: Network): Contract<typeof POD_MANAGER_ABI> {
  const addrs = getAddresses(network);
  return {
    address: requireAddress(addrs.podManager, 'PodManager'),
    abi: POD_MANAGER_ABI,
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

/**
 * Generic ERC20 resolver for a token whose address is discovered at runtime
 * (e.g. a datanet's primary token via getSubnetPrimaryToken), not pinned in
 * addresses.ts. No TBD check — the caller already holds a concrete address.
 */
export function erc20(address: Address): Contract<typeof ERC20_ABI> {
  return { address, abi: ERC20_ABI };
}

// ── Non-throwing variants ──────────────────────────────────────────────
//
// Read commands (e.g. `query balance`) need to render an `unavailable`
// marker for contracts whose address is still TBD on the chosen network,
// rather than throwing. The `tryX()` helpers return null in that case so
// callers can decide policy without re-implementing the TBD check.

const TBD_PLACEHOLDER = '0x0000000000000000000000000000000000000000';

function tryAddress(addr: Address): Address | null {
  return addr === TBD_PLACEHOLDER ? null : addr;
}

export function tryPodManager(
  network: Network,
): Contract<typeof POD_MANAGER_ABI> | null {
  const a = tryAddress(getAddresses(network).podManager);
  if (!a) return null;
  return { address: a, abi: POD_MANAGER_ABI };
}

export function trySubnetManager(network: Network): Contract<typeof SUBNET_MANAGER_ABI> | null {
  const a = tryAddress(getAddresses(network).subnetManager);
  return a ? { address: a, abi: SUBNET_MANAGER_ABI } : null;
}

export function tryVeReppo(network: Network): Contract<typeof VE_REPPO_ABI> | null {
  const a = tryAddress(getAddresses(network).veReppo);
  return a ? { address: a, abi: VE_REPPO_ABI } : null;
}

export function tryReppoToken(network: Network): Contract<typeof ERC20_ABI> | null {
  const a = tryAddress(getAddresses(network).reppoToken);
  return a ? { address: a, abi: ERC20_ABI } : null;
}

export function tryUsdcToken(network: Network): Contract<typeof ERC20_ABI> | null {
  const a = tryAddress(getAddresses(network).usdc);
  return a ? { address: a, abi: ERC20_ABI } : null;
}
