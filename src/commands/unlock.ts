/**
 * `reppo unlock <lockupId> [--to <address>]` — withdraw an expired
 * veREPPO lockup, returning the locked REPPO to `--to` (default: caller).
 *
 * On-chain function: `withdraw(uint256 tokenId, address to)`. The CLI
 * surface uses "unlock" because that's the user-facing concept; the
 * contract uses "withdraw" because it transfers the underlying REPPO.
 *
 * Pre-flight checks (all surface error codes BEFORE the cache write,
 * so retries under the same --idempotency-key are safe):
 *   1. INVALID_LOCKUP_ID  (parse)
 *   2. INVALID_ADDRESS    (--to)
 *   3. LOCKUP_NOT_FOUND   (ownerOf reverts — token doesn't exist)
 *   4. NOT_LOCKUP_OWNER   (ownerOf !== caller)
 *   5. LOCKUP_NOT_EXPIRED (expiresAt > current block timestamp)
 *
 * Two-phase write protocol via peekIdempotent.
 *
 * Args fingerprint: { lockupId, to } — re-using one --idempotency-key
 * across different (lockupId, to) is rejected with IDEMPOTENCY_ARGS_MISMATCH.
 */
import { Option } from 'clipanion';
import { formatUnits, isAddress, type Address } from 'viem';
import { BaseCommand } from './_base.js';
import { cliError, emit } from '../output/format.js';
import { createClients, nextNonce } from '../chain/clients.js';
import { veReppo } from '../chain/contracts.js';
import { decodeRevert } from '../chain/errors.js';
import { begin, markSubmitted, markConfirmed, markFailed, peekIdempotent } from '../state/idempotency.js';

const COMMAND = 'unlock';

export class UnlockCommand extends BaseCommand {
  static override paths = [['unlock']];

  static override usage = BaseCommand.Usage({
    description: 'Withdraw an expired veREPPO lockup, returning the locked REPPO.',
    examples: [
      ['Withdraw lockup 7 to the caller',
        'reppo unlock 7'],
      ['Withdraw to a different address',
        'reppo unlock 7 --to 0x726c…E31d'],
      ['With idempotency key',
        'reppo unlock 7 --idempotency-key unlock-7'],
      ['Dry-run',
        'reppo unlock 7 --dry-run'],
    ],
  });

  lockupId = Option.String({ required: true });
  to = Option.String('--to', { description: 'Address to receive the unlocked REPPO (defaults to caller)' });
  idempotencyKey = Option.String('--idempotency-key');
  dryRun = Option.Boolean('--dry-run', false);

  async execute(): Promise<number> {
    try {
      const cfg = this.loadConfig();
      const pk = cfg.privateKey;
      if (!pk) {
        throw cliError(
          'MISSING_PRIVATE_KEY',
          'No signing key available.',
          'Set REPPO_PRIVATE_KEY in env.',
        );
      }

      let lockupId: bigint;
      try {
        lockupId = BigInt(this.lockupId);
      } catch {
        throw cliError('INVALID_LOCKUP_ID', `Lockup id must be a non-negative integer; got "${this.lockupId}".`);
      }

      const clients = createClients({
        network: cfg.network,
        privateKey: pk,
        ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}),
      });

      const target: Address = this.to
        ? (isAddress(this.to)
            ? this.to
            : (() => { throw cliError('INVALID_ADDRESS', `Invalid --to address: ${this.to}`); })())
        : clients.account.address;

      const args = { lockupId: lockupId.toString(), to: target.toLowerCase() };

      const decision = await peekIdempotent<Record<string, unknown>>(
        this.idempotencyKey, COMMAND, args, this.dryRun,
      );
      if (decision.kind === 'return-confirmed') {
        emit({ ...decision.result, idempotent: true, status: 'confirmed' },
          [`(cached, confirmed) tx: ${decision.txHash ?? 'n/a'}`]);
        return 0;
      }
      if (decision.kind === 'return-submitted') {
        emit({ ...decision.result, idempotent: true, status: 'submitted' },
          [`(cached, submitted but not confirmed yet) tx: ${decision.txHash ?? 'n/a'}`,
           `Re-run after the tx confirms, or check the explorer.`]);
        return 0;
      }

      // Throwing variant — write commands must fail loud on TBD.
      const vr = veReppo(cfg.network);

      // Pre-flight: ownership
      const owner = await clients.publicClient.readContract({
        address: vr.address, abi: vr.abi, functionName: 'ownerOf', args: [lockupId],
      }).catch(() => {
        throw cliError(
          'LOCKUP_NOT_FOUND',
          `Lockup ${lockupId} does not exist on ${cfg.network}.`,
          'Verify the lockupId; check `reppo query voting-power` to find your active lockups.',
        );
      });
      if (owner.toLowerCase() !== clients.account.address.toLowerCase()) {
        throw cliError(
          'NOT_LOCKUP_OWNER',
          `Lockup ${lockupId} is owned by ${owner}, not by the configured signer ${clients.account.address}.`,
          'Use the private key of the lockup owner.',
        );
      }

      // Pre-flight: expiry. Reading lockupData + current block timestamp in
      // parallel — withdraw() reverts if called before expiresAt, so we
      // surface LOCKUP_NOT_EXPIRED as a structured error instead of letting
      // gas burn on a doomed tx.
      const [lockup, latestBlock] = await Promise.all([
        clients.publicClient.readContract({
          address: vr.address, abi: vr.abi, functionName: 'lockupData', args: [lockupId],
        }),
        clients.publicClient.getBlock({ blockTag: 'latest' }),
      ]);
      const [amount, expiresAt] = lockup;
      const now = latestBlock.timestamp;
      if (expiresAt > now) {
        const remaining = expiresAt - now;
        throw cliError(
          'LOCKUP_NOT_EXPIRED',
          `Lockup ${lockupId} expires at ${expiresAt} (${remaining}s remaining); current block timestamp is ${now}.`,
          `Wait until block timestamp ≥ ${expiresAt}, or use \`reppo extend-lock\` if you want to keep voting power.`,
        );
      }

      if (this.dryRun) {
        const sim = await clients.publicClient.simulateContract({
          address: vr.address, abi: vr.abi, functionName: 'withdraw',
          args: [lockupId, target], account: clients.account,
        }).catch((e) => {
          const decoded = decodeRevert(e);
          throw cliError(decoded.code, 'Simulation reverted', decoded.hint);
        });
        emit({
          simulated: true,
          lockupId: lockupId.toString(),
          to: target,
          amount: { raw: amount.toString(), formatted: formatUnits(amount, 18) },
          expiresAt: expiresAt.toString(),
          gas: sim.request.gas?.toString() ?? null,
        });
        return 0;
      }

      if (this.idempotencyKey) await begin(this.idempotencyKey, COMMAND, args);

      let tx: `0x${string}`;
      try {
        const nonce = await nextNonce(clients.publicClient, clients.account.address);
        tx = await clients.walletClient.writeContract({
          address: vr.address, abi: vr.abi, functionName: 'withdraw',
          args: [lockupId, target],
          chain: clients.walletClient.chain, account: clients.account, nonce,
        });
      } catch (e) {
        const decoded = decodeRevert(e);
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, decoded.code);
        throw cliError(decoded.code, 'unlock tx failed to submit', decoded.hint);
      }

      // markSubmitted BEFORE waitForReceipt — closes the retry-resend window.
      if (this.idempotencyKey) await markSubmitted(this.idempotencyKey, COMMAND, args, tx);

      const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
      if (receipt.status === 'reverted') {
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, 'TX_REVERTED', tx);
        throw cliError('TX_REVERTED', `unlock tx reverted: ${tx}`);
      }

      const result = {
        txHash: tx,
        lockupId: lockupId.toString(),
        to: target,
        amount: { raw: amount.toString(), formatted: formatUnits(amount, 18) },
        block: receipt.blockNumber.toString(),
        basescanUrl: cfg.network === 'mainnet'
          ? `https://basescan.org/tx/${tx}`
          : `https://sepolia.basescan.org/tx/${tx}`,
      };
      if (this.idempotencyKey) await markConfirmed(this.idempotencyKey, COMMAND, args, result, tx);

      emit(result, [
        `✓ Unlocked lockup ${lockupId}`,
        `  ${formatUnits(amount, 18)} REPPO returned to ${target}`,
        `  tx: ${result.basescanUrl}`,
        `  block: ${receipt.blockNumber}`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}
