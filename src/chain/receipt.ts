/**
 * Shared receipt helpers for write commands. Classifies viem receipt-wait
 * failures so agents get stable error codes instead of INTERNAL_ERROR.
 */
import type { Address, Hash, TransactionReceipt } from 'viem';
import { WaitForTransactionReceiptTimeoutError, formatEther } from 'viem';
import { cliError } from '../output/format.js';

type ReceiptWaitClient = {
  waitForTransactionReceipt(args: {
    hash: Hash;
    timeout?: number;
  }): Promise<TransactionReceipt>;
};

/**
 * Gas cost of a confirmed tx in ETH, as a decimal string: gasUsed ×
 * effectiveGasPrice (wei) → ether. Surfaced in write-command JSON so consumers
 * (e.g. budget accounting) can track on-chain spend without re-deriving it.
 */
export function receiptGasEth(receipt: TransactionReceipt): string {
  return formatEther(receipt.gasUsed * receipt.effectiveGasPrice);
}

// keccak256("Transfer(address,address,uint256)") — the ERC20 Transfer topic.
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Actual REPPO paid in a confirmed tx, as a decimal-ether string: sums the
 * token's Transfer events where `from` is the caller. Surfaced in write-command
 * JSON (like gasEth) so consumers can reconcile budget accounting to ACTUAL
 * fees instead of estimates. Returns "0" when no transfer from caller exists.
 */
export function reppoFeeFromReceipt(receipt: TransactionReceipt, reppoToken: Address, caller: Address): string {
  const token = reppoToken.toLowerCase();
  const from = caller.toLowerCase().slice(2).padStart(64, '0');
  let total = 0n;
  for (const log of receipt.logs ?? []) {
    if (log.address.toLowerCase() !== token) continue;
    if ((log.topics?.[0] ?? '').toLowerCase() !== TRANSFER_TOPIC) continue;
    if ((log.topics?.[1] ?? '').toLowerCase().slice(2) !== from) continue;
    try { total += BigInt(log.data); } catch { /* malformed log data — skip */ }
  }
  return formatEther(total);
}

export async function waitForWriteReceipt(
  publicClient: ReceiptWaitClient,
  hash: Hash,
  timeoutMs = 120_000,
): Promise<TransactionReceipt> {
  try {
    return await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs });
  } catch (err) {
    if (err instanceof WaitForTransactionReceiptTimeoutError) {
      throw cliError(
        'TX_RECEIPT_TIMEOUT',
        `Timed out after ${timeoutMs / 1000}s waiting for receipt: ${hash}`,
        'The tx may still confirm. Re-run with the same --idempotency-key to reconcile once it lands.',
      );
    }
    throw err;
  }
}
