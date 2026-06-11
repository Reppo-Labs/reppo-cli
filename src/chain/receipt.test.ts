import { describe, it, expect } from 'vitest';
import type { PublicClient, TransactionReceipt } from 'viem';
import { WaitForTransactionReceiptTimeoutError } from 'viem';
import { waitForWriteReceipt, receiptGasEth, reppoFeeFromReceipt } from './receipt.js';

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

describe('reppoFeeFromReceipt', () => {
  const TOKEN = '0xFf8104251E7761163faC3211eF5583FB3F8583d6' as const;
  const CALLER = '0x726c000000000000000000000000000000000000' as const;
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const topicFor = (addr: string) => '0x' + addr.toLowerCase().slice(2).padStart(64, '0');
  const log = (over: Record<string, unknown> = {}) => ({
    address: TOKEN, data: '0x' + (100n * 10n ** 18n).toString(16).padStart(64, '0'),
    topics: [TRANSFER, topicFor(CALLER), topicFor('0x' + 'b'.repeat(40))], ...over,
  });

  it('sums REPPO Transfer events from the caller (decimal ether string)', () => {
    const receipt = { logs: [log(), log()] } as unknown as TransactionReceipt;
    expect(reppoFeeFromReceipt(receipt, TOKEN, CALLER)).toBe('200');
  });

  it('ignores other tokens, other topics, and transfers from other addresses', () => {
    const receipt = { logs: [
      log({ address: '0x' + '1'.repeat(40) }),                       // different token
      log({ topics: ['0x' + 'f'.repeat(64), topicFor(CALLER)] }),    // not Transfer
      log({ topics: [TRANSFER, topicFor('0x' + 'c'.repeat(40))] }),  // from someone else
    ] } as unknown as TransactionReceipt;
    expect(reppoFeeFromReceipt(receipt, TOKEN, CALLER)).toBe('0');
  });

  it('returns "0" for a tx with no logs', () => {
    expect(reppoFeeFromReceipt({ logs: [] } as unknown as TransactionReceipt, TOKEN, CALLER)).toBe('0');
  });
});
