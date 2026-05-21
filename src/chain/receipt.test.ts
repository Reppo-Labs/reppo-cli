import { describe, it, expect } from 'vitest';
import type { PublicClient } from 'viem';
import { WaitForTransactionReceiptTimeoutError } from 'viem';
import { waitForWriteReceipt } from './receipt.js';

describe('waitForWriteReceipt', () => {
  it('maps viem receipt timeout to TX_RECEIPT_TIMEOUT', async () => {
    const hash = '0xabc1234567890123456789012345678901234567890123456789012345678901234';
    const client = {
      waitForTransactionReceipt: async () => {
        throw new WaitForTransactionReceiptTimeoutError({ hash });
      },
    } as unknown as PublicClient;

    await expect(waitForWriteReceipt(client, hash, 1000)).rejects.toMatchObject({
      code: 'TX_RECEIPT_TIMEOUT',
    });
  });
});
