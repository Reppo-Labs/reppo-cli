/**
 * Per-network viem client factory.
 *
 * Single-process CLI: each invocation runs one command, so we don't need
 * an in-process tx mutex. Self-collision is prevented by always reading
 * the next nonce with `blockTag: 'pending'` (see `nextNonce`). If the CLI
 * ever grows a multi-command-per-process driver, reintroduce a mutex
 * around `writeContract` then.
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
  defineChain,
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

// Robinhood Chain mainnet (Arbitrum Orbit). Defined locally because the
// pinned viem release has no chain-4663 definition; chain id verified via
// eth_chainId against the RPC below (0x1237 = 4663).
const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: {
    default: { name: 'Robinhood Explorer', url: 'https://explorer.mainnet.chain.robinhood.com' },
  },
}) as Chain;

const CHAINS: Record<Network, Chain> = {
  mainnet: base,
  testnet: baseSepolia,
  robinhood,
};

export type ReadClient = ReturnType<typeof createPublicClient>;
export type SignerClient = ReturnType<typeof createWalletClient>;

export interface Clients {
  network: Network;
  account: ReturnType<typeof privateKeyToAccount>;
  publicClient: ReadClient;
  walletClient: SignerClient;
}

export function createClients(opts: {
  network: Network;
  privateKey: `0x${string}`;
  rpcUrl?: string;
}): Clients {
  const account = privateKeyToAccount(opts.privateKey);
  const chain = CHAINS[opts.network];
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
  return createPublicClient({ chain: CHAINS[opts.network], transport: http(opts.rpcUrl) });
}

/**
 * Get the next pending nonce for an address. Use `pending` block tag
 * always — `latest` returns confirmed-only and causes nonce collisions
 * when two writes go out within the same block.
 */
export async function nextNonce(client: ReadClient, addr: Address): Promise<number> {
  return client.getTransactionCount({ address: addr, blockTag: 'pending' });
}
