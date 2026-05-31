/**
 * Shared receipt helpers for write commands. Classifies viem receipt-wait
 * failures so agents get stable error codes instead of INTERNAL_ERROR.
 */
import type { Hash, TransactionReceipt } from 'viem';
import { WaitForTransactionReceiptTimeoutError } from 'viem';
import { cliError } from '../output/format.js';

type ReceiptWaitClient = {
  waitForTransactionReceipt(args: {
    hash: Hash;
    timeout?: number;
  }): Promise<TransactionReceipt>;
};

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
