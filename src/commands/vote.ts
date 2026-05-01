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
import { emit } from '../output/format.js';
import { createClients, nextNonce } from '../chain/clients.js';
import { podManager, subnetManager, veReppo } from '../chain/contracts.js';
import { decodeRevert } from '../chain/errors.js';
import { getIdempotent, begin, markSubmitted, markConfirmed, markFailed } from '../state/idempotency.js';

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
        throw Object.assign(
          new Error('Pass exactly one of --like or --dislike.'),
          { code: 'INVALID_VOTE', hint: '--like and --dislike are mutually exclusive and one is required.' },
        );
      }
      const cfg = this.loadConfig();
      const pk = cfg.voterPrivateKey ?? cfg.privateKey;
      if (!pk) {
        throw Object.assign(
          new Error('No signing key available.'),
          { code: 'MISSING_PRIVATE_KEY', hint: 'Set REPPO_VOTER_PRIVATE_KEY (preferred) or REPPO_PRIVATE_KEY in env.' },
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
      // the subsequent real call. Handle dry-run inline below, after
      // pre-flight reads (so it still surfaces revert reasons).
      if (this.idempotencyKey && !this.dryRun) {
        const cached = await getIdempotent(this.idempotencyKey, COMMAND, args);
        if (cached) {
          if (cached.status === 'confirmed') {
            emit({ ...cached.result, idempotent: true, status: 'confirmed' },
              [`(cached, confirmed) tx: ${cached.txHash ?? 'n/a'}`]);
            return 0;
          }
          if (cached.status === 'submitted') {
            emit({ ...cached.result, idempotent: true, status: 'submitted' },
              [`(cached, submitted but not confirmed yet) tx: ${cached.txHash ?? 'n/a'}`,
               `Re-run after the tx confirms, or check the explorer.`]);
            return 0;
          }
          if (cached.status === 'pending') {
            throw Object.assign(
              new Error(`Idempotency key "${this.idempotencyKey}" is in 'pending' state — another invocation is mid-flight.`),
              { code: 'IDEMPOTENCY_IN_FLIGHT', hint: 'Wait for the in-flight invocation to finish, or use a fresh key.' },
            );
          }
          if (cached.status === 'failed' && cached.txHash) {
            // The previous attempt with this key broadcast a tx that
            // then reverted (or timed out post-submit). Re-using the
            // same key would re-broadcast and pay gas for a second
            // doomed attempt — exactly what idempotency is supposed
            // to prevent. Force the caller to a fresh key.
            throw Object.assign(
              new Error(
                `Idempotency key "${this.idempotencyKey}" previously broadcast tx ${cached.txHash} which failed. ` +
                `Refusing to re-broadcast under the same key.`,
              ),
              {
                code: 'IDEMPOTENCY_FAILED_AFTER_BROADCAST',
                hint: 'Use a fresh --idempotency-key for the retry, and inspect the prior tx on the block explorer to understand the failure.',
              },
            );
          }
          // cached.status === 'failed' && !cached.txHash → pre-submit
          // failure (e.g. validation error). Safe to retry under the
          // same key; fall through.
        }
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
      })) as bigint;
      if (power === 0n) {
        throw Object.assign(
          new Error('Voter has zero voting power.'),
          { code: 'INSUFFICIENT_VOTING_POWER', hint: 'Run `reppo lock <amount> --duration <seconds>` first.' },
        );
      }

      // Pre-flight: subnet access
      const hasAccess = (await clients.publicClient.readContract({
        address: sm.address, abi: sm.abi, functionName: 'hasSubnetAccess', args: [subnetId, clients.account.address],
      })) as boolean;
      if (!hasAccess) {
        throw Object.assign(
          new Error(`Voter lacks subnet ${subnetId} access.`),
          { code: 'VOTER_LACKS_SUBNET_ACCESS', hint: `Run \`reppo grant-access --subnet ${subnetId}\` first.` },
        );
      }

      if (this.dryRun) {
        const sim = await clients.publicClient.simulateContract({
          address: pm.address, abi: pm.abi, functionName: 'vote',
          args: [podId, subnetId, likeBool], account: clients.account,
        }).catch((e) => { throw Object.assign(new Error('Simulation reverted'), decodeRevert(e)); });
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
        throw Object.assign(new Error('Vote tx failed to submit'), decoded);
      }

      // Persist 'submitted' BEFORE waiting for the receipt — that's the
      // window where an agent retry could otherwise re-send.
      if (this.idempotencyKey) await markSubmitted(this.idempotencyKey, COMMAND, args, tx);

      const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
      if (receipt.status === 'reverted') {
        // Pass tx hash so the cached failed entry retains it for forensics
        // AND so the same-key-retry guard (above) refuses re-broadcast.
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, 'TX_REVERTED', tx);
        throw Object.assign(new Error(`Vote tx reverted: ${tx}`), { code: 'TX_REVERTED' });
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
