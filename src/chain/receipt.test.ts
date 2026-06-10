import { describe, it, expect } from 'vitest';
import type { PublicClient, TransactionReceipt } from 'viem';
import { WaitForTransactionReceiptTimeoutError } from 'viem';
import { waitForWriteReceipt, receiptGasEth } from './receipt.js';

describe('receiptGasEth', () => {
  it('computes gasUsed × effectiveGasPrice in ether as a decimal string', () => {
    // 21000 gas × 2 gwei = 4.2e13 wei = 0.000042 ETH
    const receipt = { gasUsed: 21000n, effectiveGasPrice: 2_000_000_000n } as TransactionReceipt;
    expect(receiptGasEth(receipt)).toBe('0.000042');
  });

  it('returns "0" when gas price is zero (gasless/sponsored tx)', () => {
    const receipt = { gasUsed: 50000n, effectiveGasPrice: 0n } as TransactionReceipt;
    expect(receiptGasEth(receipt)).toBe('0');
  });
});

describe('waitForWriteReceipt', () => {
  it('maps viem receipt timeout to TX_RECEIPT_TIMEOUT', async () => {
    const hash = '0xabc1234567890123456789012345678901234567890123456789012345678901234';
    const client = {
      waitForTransactionReceipt: () =>
        Promise.reject(new WaitForTransactionReceiptTimeoutError({ hash })),
    } as unknown as PublicClient;

    await expect(waitForWriteReceipt(client, hash, 1000)).rejects.toMatchObject({
      code: 'TX_RECEIPT_TIMEOUT',
    });
  });
});
