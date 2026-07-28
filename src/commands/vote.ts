/**
 * `reppo vote --pod <id> --votes <n> --like|--dislike` — cast an
 * on-chain vote against a creative pod. Uses REPPO_VOTER_PRIVATE_KEY
 * if set (separates voter and publisher EOAs since publishers cannot
 * vote on their own pods), else falls back to REPPO_PRIVATE_KEY.
 *
 * On PodManager V2 the second arg to `vote(podId, votes, upVote)` is
 * the amount of voting power to spend, NOT a subnetId. The caller's
 * subnet access is enforced inside the contract via the pod's parent
 * subnet — the CLI no longer needs a subnetId here; if the voter
 * lacks access the contract reverts with `VoterLacksSubnetAccess` and
 * the decoder surfaces a structured hint.
 *
 * Pre-flight checks (read-only) before sending:
 *   1. Pod is valid for the current epoch (PodManager.podValid)
 *   2. Voter has at least `--votes` voting power (veREPPO)
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
import { podManager, veReppo } from '../chain/contracts.js';
import { decodeRevert } from '../chain/errors.js';
import { handleSubmittedCacheDecision, basescanTxUrl } from './write-cache.js';
import { waitForWriteReceipt, receiptGasEth } from '../chain/receipt.js';
import { begin, markSubmitted, markConfirmed, markFailed, peekIdempotent } from '../state/idempotency.js';

const COMMAND = 'vote';

export class VoteCommand extends BaseCommand {
  static override paths = [['vote']];

  static override usage = BaseCommand.Usage({
    description: 'Cast a vote on a Reppo pod, spending voting power.',
    examples: [
      ['Like pod 34 with 100 voting power',
        'reppo vote --pod 34 --votes 100 --like'],
      ['Dislike with idempotency key',
        'reppo vote --pod 35 --votes 50 --dislike --idempotency-key job-3858-B'],
      ['Dry-run (simulate only)',
        'reppo vote --pod 34 --votes 100 --like --dry-run'],
    ],
  });

  pod = Option.String('--pod', { required: true, description: 'Pod token ID' });
  votes = Option.String('--votes', { required: true, description: 'Voting power to spend (positive integer)' });
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

      let votes: bigint;
      try {
        votes = BigInt(this.votes);
      } catch {
        throw cliError(
          'INVALID_VOTES',
          `--votes must be a positive integer; got "${this.votes}".`,
        );
      }
      if (votes <= 0n) {
        throw cliError(
          'INVALID_VOTES',
          `--votes must be >= 1; got "${this.votes}".`,
        );
      }
      const likeBool = this.like;

      // Args fingerprint baked into the cache so re-using one key with
      // different (--pod, --votes, --like) is rejected with
      // IDEMPOTENCY_ARGS_MISMATCH instead of silently returning the
      // wrong cached result.
      const args = { podId: podId.toString(), votes: votes.toString(), like: likeBool };

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
              const voterPower = await clients.publicClient.readContract({
                address: vrLocal.address, abi: vrLocal.abi, functionName: 'votingPowerOf', args: [clients.account.address],
              });
              return { podId: args.podId, votes: args.votes, like: args.like, voterPower: voterPower.toString() };
            } catch {
              return { podId: args.podId, votes: args.votes, like: args.like };
            }
          },
        });
      }

      const clients = createClients({
        network: cfg.network,
        privateKey: pk,
        ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}),
      });
      const pm = podManager(cfg.network);
      const vr = veReppo(cfg.network);

      // Pre-flight: pod must be valid for the current epoch. Cheaper
      // to fail here than to send a tx that will revert with
      // PodNotValidForEpoch.
      const podOk = await clients.publicClient.readContract({
        address: pm.address, abi: pm.abi, functionName: 'podValid', args: [podId],
      });
      if (!podOk) {
        throw cliError(
          'POD_NOT_VALID_FOR_EPOCH',
          `Pod ${podId} is not valid for the current voting epoch.`,
          'Check `reppo query pod <id>` to verify validity; pod publishers may need to republish.',
        );
      }

      // Pre-flight: voting power must cover `--votes`.
      const power = await clients.publicClient.readContract({
        address: vr.address, abi: vr.abi, functionName: 'votingPowerOf', args: [clients.account.address],
      });
      if (power < votes) {
        throw cliError(
          'INSUFFICIENT_VOTING_POWER',
          `Voter has ${power} voting power but --votes is ${votes}.`,
          'Lock more REPPO with `reppo lock <amount> --duration <seconds>` to increase voting power, or pass a smaller --votes.',
        );
      }

      if (this.dryRun) {
        const sim = await clients.publicClient.simulateContract({
          address: pm.address, abi: pm.abi, functionName: 'vote',
          args: [podId, votes, likeBool], account: clients.account,
        }).catch((e) => {
          const decoded = decodeRevert(e);
          throw cliError(decoded.code, 'Simulation reverted', decoded.hint);
        });
        emit({
          simulated: true,
          podId: podId.toString(),
          votes: votes.toString(),
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
          args: [podId, votes, likeBool],
          chain: clients.walletClient.chain, account: clients.account, nonce,
        });
      } catch (e) {
        const decoded = decodeRevert(e);
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, decoded.code);
        throw cliError(decoded.code, 'Vote tx failed to submit', decoded.hint);
      }

      // Persist 'submitted' BEFORE waiting for the receipt — that's the
      // window where an agent retry could otherwise re-send.
      if (this.idempotencyKey) {
        await markSubmitted(this.idempotencyKey, COMMAND, args, tx, {
          podId: podId.toString(),
          votes: votes.toString(),
          like: likeBool,
          voterPower: power.toString(),
        });
      }

      const receipt = await waitForWriteReceipt(clients.publicClient, tx);
      if (receipt.status === 'reverted') {
        // Pass tx hash so the cached failed entry retains it for forensics
        // AND so the same-key-retry guard (above) refuses re-broadcast.
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, 'TX_REVERTED', tx);
        throw cliError('TX_REVERTED', `Vote tx reverted: ${tx}`);
      }

      const result = {
        txHash: tx,
        gasEth: receiptGasEth(receipt),
        podId: podId.toString(),
        votes: votes.toString(),
        like: likeBool,
        voterPower: power.toString(),
        block: receipt.blockNumber.toString(),
        basescanUrl: basescanTxUrl(cfg.network, tx),
      };
      if (this.idempotencyKey) await markConfirmed(this.idempotencyKey, COMMAND, args, result, tx);

      emit(result, [
        `✓ Voted on pod ${podId} (${likeBool ? 'like' : 'dislike'}, ${votes} votes)`,
        `  tx: ${result.basescanUrl}`,
        `  block: ${receipt.blockNumber}`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}
