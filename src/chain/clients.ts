/**
 * Per-network viem client factory. Wraps writeContract through a tx-lock
 * mutex so concurrent commands using the same EOA don't collide on nonces
 * (carried over from reppo-x-agent's chain.ts pattern).
 *
 * NOTE: viem's PublicClient/WalletClient generic signatures drift across
 * minor versions and across `viem/chains` re-exports. Returning the
 * inferred type from createPublicClient/createWalletClient (rather than
 * naming the alias) sidesteps the "two unrelated types with the same
 * name" error TS2719.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Chain,
} from 'viem';
import { base as _base, baseSepolia as _baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import type { Network } from './addresses.js';

// Cast to plain Chain to escape viem's opstack/deposit-tx generic widening
// — that widening is what produces the TS2322 "two unrelated types"
// errors when we try to declare ReadClient/SignerClient aliases.
const base = _base as Chain;
const baseSepolia = _baseSepolia as Chain;

export type ReadClient = ReturnType<typeof createPublicClient>;
export type SignerClient = ReturnType<typeof createWalletClient>;

export interface Clients {
  network: Network;
  account: ReturnType<typeof privateKeyToAccount>;
  publicClient: ReadClient;
  walletClient: SignerClient;
}

let _txLock: Promise<void> = Promise.resolve();
export function withTxLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _txLock;
  let release: () => void;
  _txLock = new Promise<void>((r) => { release = r; });
  return prev.then(fn).finally(() => release!());
}

export function createClients(opts: {
  network: Network;
  privateKey: `0x${string}`;
  rpcUrl?: string;
}): Clients {
  const account = privateKeyToAccount(opts.privateKey);
  const chain = opts.network === 'mainnet' ? base : baseSepolia;
  const transport = http(opts.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });
  return { network: opts.network, account, publicClient, walletClient };
}

/**
 * Read-only client (no signing key required). Used by `reppo query …`
 * commands that don't need a wallet.
 */
export function createReadClient(opts: { network: Network; rpcUrl?: string }): ReadClient {
  const chain = opts.network === 'mainnet' ? base : baseSepolia;
  return createPublicClient({ chain, transport: http(opts.rpcUrl) });
}

/**
 * Get the next pending nonce for an address. Use `pending` block tag
 * always — `latest` returns confirmed-only and causes nonce collisions
 * when two writes go out within the same block.
 */
export async function nextNonce(client: ReadClient, addr: Address): Promise<number> {
  return client.getTransactionCount({ address: addr, blockTag: 'pending' });
}
