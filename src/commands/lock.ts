/**
 * `reppo lock <amount> --duration <seconds>` — lock REPPO into veREPPO
 * for `duration` seconds. Returns voting power proportional to the
 * (amount, duration) curve.
 *
 * Pre-flight checks (all surface error codes BEFORE the cache write so
 * retries under the same --idempotency-key are safe):
 *   1. INVALID_AMOUNT / INVALID_DURATION (parse)
 *   2. DURATION_OUT_OF_BOUNDS  (min/maxStakeDuration)
 *   3. INSUFFICIENT_REPPO_BALANCE
 *   4. INSUFFICIENT_ALLOWANCE  (caller → veReppo)
 *   5. previewPoints captures the predicted voting-power-gained for the
 *      result payload; also surfaces in dry-run.
 *
 * Two-phase write protocol via peekIdempotent.
 *
 * Args fingerprint: { amount, duration } — re-using one --idempotency-key
 * with different (amount, duration) is rejected with IDEMPOTENCY_ARGS_MISMATCH.
 *
 * Note: the new lockupId is NOT decoded from the receipt in this alpha
 * (would require adding the ERC-721 Transfer event to VE_REPPO_ABI).
 * Use `reppo query voting-power` after this command to find the new
 * lockupId — it'll be the highest-numbered token the caller owns.
 */
import { Option } from 'clipanion';
import { formatUnits, parseUnits } from 'viem';
import { BaseCommand } from './_base.js';
import { cliError, emit } from '../output/format.js';
import { createClients, nextNonce } from '../chain/clients.js';
import { veReppo, reppoToken } from '../chain/contracts.js';
import { decodeRevert } from '../chain/errors.js';
import { handleSubmittedCacheDecision } from './write-cache.js';
import { waitForWriteReceipt } from '../chain/receipt.js';
import { begin, markSubmitted, markConfirmed, markFailed, peekIdempotent } from '../state/idempotency.js';

const COMMAND = 'lock';

export class LockCommand extends BaseCommand {
  static override paths = [['lock']];

  static override usage = BaseCommand.Usage({
    description: 'Lock REPPO into veREPPO for `duration` seconds to gain voting power.',
    examples: [
      ['Lock 1000 REPPO for 2 hours (testnet minimum)',
        'reppo lock 1000 --duration 7200'],
      ['With idempotency key',
        'reppo lock 1000 --duration 7200 --idempotency-key lock-1000-2h'],
      ['Dry-run',
        'reppo lock 1000 --duration 7200 --dry-run'],
    ],
  });

  amount = Option.String({ required: true });
  duration = Option.String('--duration', { required: true, description: 'Lock duration in seconds' });
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

      // Parse amount as a REPPO-denominated value (18 decimals).
      let amount: bigint;
      try {
        amount = parseUnits(this.amount, 18);
      } catch {
        throw cliError('INVALID_AMOUNT', `Amount must be a numeric REPPO value; got "${this.amount}".`);
      }
      if (amount <= 0n) {
        throw cliError('INVALID_AMOUNT', 'Amount must be greater than 0 REPPO.');
      }

      let duration: bigint;
      try {
        duration = BigInt(this.duration);
      } catch {
        throw cliError('INVALID_DURATION', `Duration must be a non-negative integer (seconds); got "${this.duration}".`);
      }
      if (duration <= 0n) {
        throw cliError('INVALID_DURATION', 'Duration must be greater than 0 seconds.');
      }

      const args = { amount: amount.toString(), duration: duration.toString() };

      const decision = await peekIdempotent<Record<string, unknown>>(
        this.idempotencyKey, COMMAND, args, this.dryRun,
      );
      if (decision.kind === 'return-confirmed') {
        emit({ ...decision.result, idempotent: true, status: 'confirmed' },
          [`(cached, confirmed) tx: ${decision.txHash ?? 'n/a'}`]);
        return 0;
      }
      if (decision.kind === 'return-submitted') {
        const clients = createClients({
          network: cfg.network,
          privateKey: pk,
          ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}),
        });
        return handleSubmittedCacheDecision(decision, {
          idempotencyKey: this.idempotencyKey,
          command: COMMAND,
          args,
          network: cfg.network,
          publicClient: clients.publicClient,
          buildResult: () => ({ amount: { raw: amount.toString(), formatted: formatUnits(amount, 18) }, duration: duration.toString() }),
        });
      }

      const clients = createClients({
        network: cfg.network,
        privateKey: pk,
        ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}),
      });

      // Throwing variants — write commands must fail loud on TBD.
      const vr = veReppo(cfg.network);
      const reppo = reppoToken(cfg.network);

      // Pre-flight in parallel: 5 reads → 1 round-trip.
      const [minDur, maxDur, balance, allowance, preview] = await Promise.all([
        clients.publicClient.readContract({ address: vr.address, abi: vr.abi, functionName: 'minStakeDuration', args: [] }),
        clients.publicClient.readContract({ address: vr.address, abi: vr.abi, functionName: 'maxStakeDuration', args: [] }),
        clients.publicClient.readContract({ address: reppo.address, abi: reppo.abi, functionName: 'balanceOf', args: [clients.account.address] }),
        clients.publicClient.readContract({ address: reppo.address, abi: reppo.abi, functionName: 'allowance', args: [clients.account.address, vr.address] }),
        clients.publicClient.readContract({ address: vr.address, abi: vr.abi, functionName: 'previewPoints', args: [amount, duration] }),
      ]);
      const [previewPower, previewEnd] = preview;

      if (duration < minDur || duration > maxDur) {
        throw cliError(
          'DURATION_OUT_OF_BOUNDS',
          `Duration ${duration}s is outside the allowed range [${minDur}, ${maxDur}].`,
          `Pass --duration with a value in seconds between ${minDur} and ${maxDur}.`,
        );
      }

      if (balance < amount) {
        throw cliError(
          'INSUFFICIENT_REPPO_BALANCE',
          `Caller has ${formatUnits(balance, 18)} REPPO but requested to lock ${formatUnits(amount, 18)} REPPO.`,
          'Acquire more REPPO before locking.',
        );
      }

      if (allowance < amount) {
        throw cliError(
          'INSUFFICIENT_ALLOWANCE',
          `REPPO allowance from ${clients.account.address} to veReppo is ${formatUnits(allowance, 18)}, ` +
          `below the lock amount of ${formatUnits(amount, 18)} REPPO.`,
          `Approve veReppo (${vr.address}) for at least ${formatUnits(amount, 18)} REPPO. ` +
          `Auto-approval lands in v0.2; for the alpha, send the approve() tx manually.`,
        );
      }

      if (this.dryRun) {
        const sim = await clients.publicClient.simulateContract({
          address: vr.address, abi: vr.abi, functionName: 'stake',
          args: [amount, duration], account: clients.account,
        }).catch((e) => {
          const decoded = decodeRevert(e);
          throw cliError(decoded.code, 'Simulation reverted', decoded.hint);
        });
        emit({
          simulated: true,
          amount: { raw: amount.toString(), formatted: formatUnits(amount, 18) },
          duration: duration.toString(),
          predictedLockupId: sim.result.toString(),
          votingPowerGained: { raw: previewPower.toString(), formatted: formatUnits(previewPower, 18) },
          predictedExpiresAt: previewEnd.toString(),
          gas: sim.request.gas?.toString() ?? null,
        });
        return 0;
      }

      if (this.idempotencyKey) await begin(this.idempotencyKey, COMMAND, args);

      let tx: `0x${string}`;
      try {
        const nonce = await nextNonce(clients.publicClient, clients.account.address);
        tx = await clients.walletClient.writeContract({
          address: vr.address, abi: vr.abi, functionName: 'stake',
          args: [amount, duration],
          chain: clients.walletClient.chain, account: clients.account, nonce,
        });
      } catch (e) {
        const decoded = decodeRevert(e);
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, decoded.code);
        throw cliError(decoded.code, 'lock tx failed to submit', decoded.hint);
      }

      // markSubmitted BEFORE waitForReceipt — closes the retry-resend window.
      if (this.idempotencyKey) await markSubmitted(this.idempotencyKey, COMMAND, args, tx);

      const receipt = await waitForWriteReceipt(clients.publicClient, tx);
      if (receipt.status === 'reverted') {
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, 'TX_REVERTED', tx);
        throw cliError('TX_REVERTED', `lock tx reverted: ${tx}`);
      }

      const result = {
        txHash: tx,
        amount: { raw: amount.toString(), formatted: formatUnits(amount, 18) },
        duration: duration.toString(),
        votingPowerGained: { raw: previewPower.toString(), formatted: formatUnits(previewPower, 18) },
        expiresAt: previewEnd.toString(),
        block: receipt.blockNumber.toString(),
        basescanUrl: cfg.network === 'mainnet'
          ? `https://basescan.org/tx/${tx}`
          : `https://sepolia.basescan.org/tx/${tx}`,
        // Note: the new lockupId is not decoded here. Use
        // `reppo query voting-power` to see the new lockupCount.
      };
      if (this.idempotencyKey) await markConfirmed(this.idempotencyKey, COMMAND, args, result, tx);

      emit(result, [
        `✓ Locked ${formatUnits(amount, 18)} REPPO for ${duration}s`,
        `  voting power gained: ${formatUnits(previewPower, 18)}`,
        `  tx: ${result.basescanUrl}`,
        `  block: ${receipt.blockNumber}`,
        `  (new lockupId: run \`reppo query voting-power\` to see updated count)`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}
