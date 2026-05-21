/**
 * Idempotency helpers for on-chain write commands. Promotes submitted
 * cache entries to confirmed when the tx already landed on-chain.
 */
import type { PublicClient, TransactionReceipt } from 'viem';
import { TransactionReceiptNotFoundError } from 'viem';
import type { Network } from '../chain/addresses.js';
import { markConfirmed, markFailed } from '../state/idempotency.js';
import { cliError, emit } from '../output/format.js';
import type { CacheDecision } from '../state/idempotency.js';

export function basescanTxUrl(network: Network, tx: string): string {
  return network === 'mainnet'
    ? `https://basescan.org/tx/${tx}`
    : `https://sepolia.basescan.org/tx/${tx}`;
}

export async function reconcileSubmittedCache(
  publicClient: Pick<PublicClient, 'getTransactionReceipt'>,
  network: Network,
  key: string,
  command: string,
  args: Record<string, unknown>,
  txHash: `0x${string}`,
  buildResult: (receipt: TransactionReceipt) => Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  let receipt: TransactionReceipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  } catch (err) {
    if (err instanceof TransactionReceiptNotFoundError) return null;
    throw err;
  }

  if (receipt.status === 'reverted') {
    await markFailed(key, command, args, 'TX_REVERTED', txHash);
    throw cliError(
      'TX_REVERTED',
      `Tx reverted on-chain: ${txHash}`,
      `Inspect ${basescanTxUrl(network, txHash)}`,
    );
  }

  const result = {
    ...buildResult(receipt),
    txHash,
    block: receipt.blockNumber.toString(),
    basescanUrl: basescanTxUrl(network, txHash),
  };
  await markConfirmed(key, command, args, result, txHash);
  return result;
}

export async function handleSubmittedCacheDecision(
  decision: Extract<CacheDecision<Record<string, unknown>>, { kind: 'return-submitted' }>,
  opts: {
    idempotencyKey: string | undefined;
    command: string;
    args: Record<string, unknown>;
    network: Network;
    publicClient: Pick<PublicClient, 'getTransactionReceipt'>;
    buildResult: (receipt: TransactionReceipt) => Record<string, unknown>;
  },
): Promise<number> {
  const txHash = decision.txHash;
  if (!txHash) {
    emit(
      { ...decision.result, idempotent: true, status: 'submitted' },
      ['(cached, submitted) tx hash missing from cache'],
    );
    return 0;
  }

  if (opts.idempotencyKey) {
    const reconciled = await reconcileSubmittedCache(
      opts.publicClient,
      opts.network,
      opts.idempotencyKey,
      opts.command,
      opts.args,
      txHash as `0x${string}`,
      opts.buildResult,
    );
    if (reconciled) {
      emit(
        { ...reconciled, idempotent: true, status: 'confirmed' },
        [`(cached, reconciled to confirmed) tx: ${reconciled.basescanUrl ?? txHash}`],
      );
      return 0;
    }
  }

  emit(
    { ...decision.result, idempotent: true, status: 'submitted' },
    [
      `(cached, submitted but not confirmed yet) tx: ${txHash}`,
      'Re-run after the tx confirms, or check the explorer.',
    ],
  );
  return 0;
}
