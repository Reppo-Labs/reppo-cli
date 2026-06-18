/**
 * Auto-approval helper for write commands that pull an ERC20 (lock → veREPPO,
 * grant-access → SubnetManager).
 *
 * Pre-alpha these commands threw INSUFFICIENT_ALLOWANCE and told the operator to
 * "send approve() manually, e.g. via cast" — a real onboarding blocker for
 * non-technical node operators. `ensureAllowance` now sends an unlimited approve()
 * and waits for its receipt whenever the current allowance is short, so the spend
 * just works. An allowance that already covers the amount is a no-op (no tx) — which
 * keeps the command idempotent on retry: a re-run after the approve landed simply
 * sees a sufficient allowance and proceeds.
 *
 * Unlimited (MaxUint256) matches `reppo approve`'s default and the one-time-approve
 * pattern agents expect; a bounded approval would force a fresh approve tx on every
 * fee change. The spender is always a Reppo protocol contract the caller already
 * consented to interact with by running the command.
 */
import { maxUint256, type Address } from 'viem';
import type { Clients } from './clients.js';
import { nextNonce } from './clients.js';
import { erc20 } from './contracts.js';
import { decodeRevert } from './errors.js';
import { cliError } from '../output/format.js';

export interface EnsureAllowanceResult {
  /** True when an approve() tx was sent (allowance was short); false on a no-op. */
  approved: boolean;
  /** The approve tx hash, present only when `approved` is true. */
  approveTx?: `0x${string}`;
}

/**
 * Ensure the caller has approved `spender` for at least `needed` of `token`.
 * Sends an unlimited approve() + waits for the receipt when short; no-op otherwise.
 * Pass `knownAllowance` to reuse an allowance the caller already read (avoids a
 * second RPC round-trip).
 */
export async function ensureAllowance(
  clients: Clients,
  token: Address,
  spender: Address,
  needed: bigint,
  knownAllowance?: bigint,
): Promise<EnsureAllowanceResult> {
  const t = erc20(token);
  const allowance = knownAllowance ?? (await clients.publicClient.readContract({
    address: t.address, abi: t.abi, functionName: 'allowance',
    args: [clients.account.address, spender],
  }));
  if (allowance >= needed) return { approved: false };

  let approveTx: `0x${string}`;
  try {
    const nonce = await nextNonce(clients.publicClient, clients.account.address);
    approveTx = await clients.walletClient.writeContract({
      address: t.address, abi: t.abi, functionName: 'approve',
      args: [spender, maxUint256],
      chain: clients.walletClient.chain, account: clients.account, nonce,
    });
  } catch (e) {
    const decoded = decodeRevert(e);
    throw cliError(decoded.code, 'auto-approve tx failed to submit', decoded.hint);
  }

  // Wait so the on-chain nonce advances before the caller's own write (the next
  // nextNonce returns approveNonce+1) and so a revert fails loud, not silently.
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 120_000 });
  if (receipt.status === 'reverted') {
    throw cliError('APPROVE_REVERTED', `auto-approve tx reverted: ${approveTx}`,
      'The approve() transaction reverted on-chain. Check the token contract and that the wallet holds gas.');
  }
  return { approved: true, approveTx };
}
