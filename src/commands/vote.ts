/**
 * `reppo vote --pod <id> --subnet <id> --like|--dislike` — cast an
 * on-chain vote against a creative pod. Uses REPPO_VOTER_PRIVATE_KEY
 * if set (separates voter and publisher EOAs since publishers cannot
 * vote on their own pods), else falls back to REPPO_PRIVATE_KEY.
 *
 * Pre-flight checks (read-only) before sending:
 *   1. Voter has voting power (veREPPO > 0)
 *   2. Voter has subnet access
 * Both produce structured errors with recovery hints.
 *
 * Idempotency two-phase write protocol:
 *   begin → submit tx → markSubmitted → wait receipt → markConfirmed
 * A retry that fires after submit but before receipt will see the
 * 'submitted' record and short-circuit with the cached txHash.
 */
import { Option } from 'clipanion';
import { BaseCommand } from './_base.js';
import { cliError, emit } from '../output/format.js';
import { createClients, nextNonce } from '../chain/clients.js';
import { podManager, subnetManager, veReppo } from '../chain/contracts.js';
import { decodeRevert } from '../chain/errors.js';
import { begin, markSubmitted, markConfirmed, markFailed, peekIdempotent } from '../state/idempotency.js';

const COMMAND = 'vote';

export class VoteCommand extends BaseCommand {
  static override paths = [['vote']];

  static override usage = BaseCommand.Usage({
    description: 'Cast a vote on a Reppo pod (testnet or mainnet).',
    examples: [
      ['Like pod 34 in subnet 19',
        'reppo vote --pod 34 --subnet 19 --like'],
      ['Dislike with idempotency key',
        'reppo vote --pod 35 --subnet 19 --dislike --idempotency-key job-3858-B'],
      ['Dry-run (simulate only)',
        'reppo vote --pod 34 --subnet 19 --like --dry-run'],
    ],
  });

  pod = Option.String('--pod', { required: true, description: 'Pod token ID' });
  subnet = Option.String('--subnet', { required: true, description: 'Subnet ID' });
  like = Option.Boolean('--like', false);
  dislike = Option.Boolean('--dislike', false);
  idempotencyKey = Option.String('--idempotency-key');
  dryRun = Option.Boolean('--dry-run', false);

  async execute(): Promise<number> {
    try {
      if (this.like === this.dislike) {
        throw cliError(
          'INVALID_VOTE',
          'Pass exactly one of --like or --dislike.',
          '--like and --dislike are mutually exclusive and one is required.',
        );
      }
      const cfg = this.loadConfig();
      const pk = cfg.voterPrivateKey ?? cfg.privateKey;
      if (!pk) {
        throw cliError(
          'MISSING_PRIVATE_KEY',
          'No signing key available.',
          'Set REPPO_VOTER_PRIVATE_KEY (preferred) or REPPO_PRIVATE_KEY in env.',
        );
      }

      const podId = BigInt(this.pod);
      const subnetId = BigInt(this.subnet);
      const likeBool = this.like;

      // Args fingerprint baked into the cache so re-using one key with
      // different (--pod, --subnet, --like) is rejected with
      // IDEMPOTENCY_ARGS_MISMATCH instead of silently returning the
      // wrong cached result.
      const args = { podId: podId.toString(), subnetId: subnetId.toString(), like: likeBool };

      // Dry-run NEVER consults or mutates the idempotency cache. A
      // simulation is read-only by definition; returning a cached real
      // tx hash with `simulated: true` would be a lie, and writing
      // pending/submitted records would let a sim poison the cache for
      // the subsequent real call. peekIdempotent enforces that policy
      // (4th arg: isDryRun) and centralizes the pending/failed-after-
      // broadcast guards so future commands share the same rules.
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

      const clients = createClients({
        network: cfg.network,
        privateKey: pk,
        ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}),
      });
      const pm = podManager(cfg.network);
      const sm = subnetManager(cfg.network);
      const vr = veReppo(cfg.network);

      // Pre-flight: voting power
      const power = (await clients.publicClient.readContract({
        address: vr.address, abi: vr.abi, functionName: 'votingPowerOf', args: [clients.account.address],
      }));
      if (power === 0n) {
        throw cliError(
          'INSUFFICIENT_VOTING_POWER',
          'Voter has zero voting power.',
          'Run `reppo lock <amount> --duration <seconds>` first.',
        );
      }

      // Pre-flight: subnet access
      const hasAccess = (await clients.publicClient.readContract({
        address: sm.address, abi: sm.abi, functionName: 'hasSubnetAccess', args: [subnetId, clients.account.address],
      }));
      if (!hasAccess) {
        throw cliError(
          'VOTER_LACKS_SUBNET_ACCESS',
          `Voter lacks subnet ${subnetId} access.`,
          `Run \`reppo grant-access --subnet ${subnetId}\` first.`,
        );
      }

      if (this.dryRun) {
        const sim = await clients.publicClient.simulateContract({
          address: pm.address, abi: pm.abi, functionName: 'vote',
          args: [podId, subnetId, likeBool], account: clients.account,
        }).catch((e) => {
          const decoded = decodeRevert(e);
          throw cliError(decoded.code, 'Simulation reverted', decoded.hint);
        });
        emit({
          simulated: true,
          podId: podId.toString(),
          subnetId: subnetId.toString(),
          like: likeBool,
          voterPower: power.toString(),
          gas: sim.request.gas?.toString() ?? null,
        });
        return 0;
      }

      // Two-phase write: begin → submit → markSubmitted → wait → markConfirmed.
      if (this.idempotencyKey) await begin(this.idempotencyKey, COMMAND, args);

      let tx: `0x${string}`;
      try {
        const nonce = await nextNonce(clients.publicClient, clients.account.address);
        tx = await clients.walletClient.writeContract({
          address: pm.address, abi: pm.abi, functionName: 'vote',
          args: [podId, subnetId, likeBool],
          chain: clients.walletClient.chain, account: clients.account, nonce,
        });
      } catch (e) {
        const decoded = decodeRevert(e);
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, decoded.code);
        throw cliError(decoded.code, 'Vote tx failed to submit', decoded.hint);
      }

      // Persist 'submitted' BEFORE waiting for the receipt — that's the
      // window where an agent retry could otherwise re-send.
      if (this.idempotencyKey) await markSubmitted(this.idempotencyKey, COMMAND, args, tx);

      const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
      if (receipt.status === 'reverted') {
        // Pass tx hash so the cached failed entry retains it for forensics
        // AND so the same-key-retry guard (above) refuses re-broadcast.
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, 'TX_REVERTED', tx);
        throw cliError('TX_REVERTED', `Vote tx reverted: ${tx}`);
      }

      const result = {
        txHash: tx,
        podId: podId.toString(),
        subnetId: subnetId.toString(),
        like: likeBool,
        voterPower: power.toString(),
        block: receipt.blockNumber.toString(),
        basescanUrl: cfg.network === 'mainnet'
          ? `https://basescan.org/tx/${tx}`
          : `https://sepolia.basescan.org/tx/${tx}`,
      };
      if (this.idempotencyKey) await markConfirmed(this.idempotencyKey, COMMAND, args, result, tx);

      emit(result, [
        `✓ Voted on pod ${podId} (${likeBool ? 'like' : 'dislike'})`,
        `  tx: ${result.basescanUrl}`,
        `  block: ${receipt.blockNumber}`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}
