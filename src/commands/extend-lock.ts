/**
 * `reppo extend-lock <lockupId> --duration <seconds>` — extend an
 * existing veREPPO lockup's expiry by `duration` more seconds.
 *
 * Pre-flight checks (read-only) before sending:
 *   1. Caller owns the lockup (ownerOf(lockupId) === caller address)
 *   2. Duration is within [minStakeDuration, maxStakeDuration]
 *   3. Capture lockupData(lockupId) for before/after state in the result
 *
 * Idempotency two-phase write protocol:
 *   begin → submit tx → markSubmitted → wait receipt → markConfirmed
 *
 * Args fingerprint: { lockupId, duration } — re-using one --idempotency-key
 * with a different lockupId or duration is rejected with
 * IDEMPOTENCY_ARGS_MISMATCH.
 */
import { Option } from 'clipanion';
import { BaseCommand } from './_base.js';
import { cliError, emit } from '../output/format.js';
import { createClients, nextNonce } from '../chain/clients.js';
import { veReppo } from '../chain/contracts.js';
import { decodeRevert } from '../chain/errors.js';
import { handleSubmittedCacheDecision, basescanTxUrl } from './write-cache.js';
import { waitForWriteReceipt, receiptGasEth } from '../chain/receipt.js';
import { begin, markSubmitted, markConfirmed, markFailed, peekIdempotent } from '../state/idempotency.js';

const COMMAND = 'extend-lock';

export class ExtendLockCommand extends BaseCommand {
  static override paths = [['extend-lock']];

  static override usage = BaseCommand.Usage({
    description: 'Extend an existing veREPPO lockup by `duration` more seconds.',
    examples: [
      ['Extend lockup 7 by 1 day',
        'reppo extend-lock 7 --duration 86400'],
      ['With idempotency key',
        'reppo extend-lock 7 --duration 86400 --idempotency-key extend-7-1d'],
      ['Dry-run (simulate only)',
        'reppo extend-lock 7 --duration 86400 --dry-run'],
    ],
  });

  lockupId = Option.String({ required: true });
  duration = Option.String('--duration', { required: true, description: 'Seconds to add to the lockup' });
  idempotencyKey = Option.String('--idempotency-key');
  dryRun = Option.Boolean('--dry-run', false);

  async execute(): Promise<number> {
    try {
      const cfg = this.loadConfig();
      this.requireStakingNetwork(cfg.network);
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

      let duration: bigint;
      try {
        duration = BigInt(this.duration);
      } catch {
        throw cliError('INVALID_DURATION', `Duration must be a non-negative integer (seconds); got "${this.duration}".`);
      }
      if (duration <= 0n) {
        throw cliError('INVALID_DURATION', 'Duration must be greater than 0 seconds.');
      }

      const args = { lockupId: lockupId.toString(), duration: duration.toString() };

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
          buildResult: async () => {
            try {
              const vrLocal = veReppo(cfg.network);
              const lockupAfter = await clients.publicClient.readContract({
                address: vrLocal.address, abi: vrLocal.abi, functionName: 'lockupData', args: [lockupId],
              });
              return {
                lockupId: lockupId.toString(),
                durationAdded: duration.toString(),
                lockupAfter: {
                  amount: lockupAfter[0].toString(),
                  expiresAt: lockupAfter[1].toString(),
                  votingPower: lockupAfter[3].toString(),
                },
              };
            } catch {
              return { lockupId: lockupId.toString(), durationAdded: duration.toString() };
            }
          },
        });
      }

      const clients = createClients({
        network: cfg.network,
        privateKey: pk,
        ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}),
      });
      const vr = veReppo(cfg.network); // throws ADDRESS_NOT_CONFIGURED on TBD networks

      // Pre-flight: ownership
      const owner = await clients.publicClient.readContract({
        address: vr.address, abi: vr.abi, functionName: 'ownerOf', args: [lockupId],
      }).catch(() => {
        // Lockup doesn't exist (ownerOf reverts per ERC-721).
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
          'Use the private key of the lockup owner, or pass an idempotency key derived from a different intent.',
        );
      }

      // Pre-flight: duration bounds
      const [minDur, maxDur] = await Promise.all([
        clients.publicClient.readContract({
          address: vr.address, abi: vr.abi, functionName: 'minStakeDuration', args: [],
        }),
        clients.publicClient.readContract({
          address: vr.address, abi: vr.abi, functionName: 'maxStakeDuration', args: [],
        }),
      ]);
      if (duration < minDur || duration > maxDur) {
        throw cliError(
          'DURATION_OUT_OF_BOUNDS',
          `Duration ${duration}s is outside the allowed range [${minDur}, ${maxDur}].`,
          `Pass --duration with a value in seconds between ${minDur} and ${maxDur}.`,
        );
      }

      // Capture before-state for the result payload (also surfaces in dry-run).
      const lockupBefore = await clients.publicClient.readContract({
        address: vr.address, abi: vr.abi, functionName: 'lockupData', args: [lockupId],
      });

      if (this.dryRun) {
        const sim = await clients.publicClient.simulateContract({
          address: vr.address, abi: vr.abi, functionName: 'extendLock',
          args: [lockupId, duration], account: clients.account,
        }).catch((e) => {
          const decoded = decodeRevert(e);
          throw cliError(decoded.code, 'Simulation reverted', decoded.hint);
        });
        emit({
          simulated: true,
          lockupId: lockupId.toString(),
          durationAdded: duration.toString(),
          owner,
          lockupBefore: {
            amount: lockupBefore[0].toString(),
            expiresAt: lockupBefore[1].toString(),
            votingPower: lockupBefore[3].toString(),
          },
          gas: sim.request.gas?.toString() ?? null,
        });
        return 0;
      }

      if (this.idempotencyKey) await begin(this.idempotencyKey, COMMAND, args);

      let tx: `0x${string}`;
      try {
        const nonce = await nextNonce(clients.publicClient, clients.account.address);
        tx = await clients.walletClient.writeContract({
          address: vr.address, abi: vr.abi, functionName: 'extendLock',
          args: [lockupId, duration],
          chain: clients.walletClient.chain, account: clients.account, nonce,
        });
      } catch (e) {
        const decoded = decodeRevert(e);
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, decoded.code);
        throw cliError(decoded.code, 'extend-lock tx failed to submit', decoded.hint);
      }

      // markSubmitted BEFORE waitForReceipt — closes the retry-resend window.
      if (this.idempotencyKey) {
        await markSubmitted(this.idempotencyKey, COMMAND, args, tx, {
          lockupId: lockupId.toString(),
          durationAdded: duration.toString(),
          lockupBefore: {
            amount: lockupBefore[0].toString(),
            expiresAt: lockupBefore[1].toString(),
            votingPower: lockupBefore[3].toString(),
          },
        });
      }

      const receipt = await waitForWriteReceipt(clients.publicClient, tx);
      if (receipt.status === 'reverted') {
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, 'TX_REVERTED', tx);
        throw cliError('TX_REVERTED', `extend-lock tx reverted: ${tx}`);
      }

      // Read the new state for the result payload.
      const lockupAfter = await clients.publicClient.readContract({
        address: vr.address, abi: vr.abi, functionName: 'lockupData', args: [lockupId],
      });

      const result = {
        lockupId: lockupId.toString(),
        durationAdded: duration.toString(),
        txHash: tx,
        gasEth: receiptGasEth(receipt),
        block: receipt.blockNumber.toString(),
        basescanUrl: basescanTxUrl(cfg.network, tx),
        lockupBefore: {
          amount: lockupBefore[0].toString(),
          expiresAt: lockupBefore[1].toString(),
          votingPower: lockupBefore[3].toString(),
        },
        lockupAfter: {
          amount: lockupAfter[0].toString(),
          expiresAt: lockupAfter[1].toString(),
          votingPower: lockupAfter[3].toString(),
        },
      };
      if (this.idempotencyKey) await markConfirmed(this.idempotencyKey, COMMAND, args, result, tx);

      emit(result, [
        `✓ Extended lockup ${lockupId} by ${duration}s`,
        `  expiresAt:   ${lockupBefore[1]} → ${lockupAfter[1]}`,
        `  votingPower: ${lockupBefore[3]} → ${lockupAfter[3]}`,
        `  tx: ${result.basescanUrl}`,
        `  block: ${receipt.blockNumber}`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}
