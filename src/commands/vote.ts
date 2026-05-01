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
 */
import { Option } from 'clipanion';
import { BaseCommand } from './_base.js';
import { emit } from '../output/format.js';
import { createClients, withTxLock, nextNonce } from '../chain/clients.js';
import { getAddresses } from '../chain/addresses.js';
import { POD_MANAGER_TESTNET_ABI, VE_REPPO_ABI, SUBNET_MANAGER_ABI } from '../chain/abis.js';
import { decodeRevert } from '../chain/errors.js';
import { getIdempotent, saveIdempotent } from '../state/idempotency.js';

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

      const command = 'vote';
      if (this.idempotencyKey) {
        const cached = await getIdempotent(this.idempotencyKey, command);
        if (cached) {
          emit({ ...cached.result, idempotent: true }, ['(cached) tx: ' + cached.txHash]);
          return 0;
        }
      }

      const podId = BigInt(this.pod);
      const subnetId = BigInt(this.subnet);
      const likeBool = this.like;

      const clients = createClients({ network: cfg.network, privateKey: pk, ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}) });
      const addrs = getAddresses(cfg.network);

      const power = (await clients.publicClient.readContract({
        address: addrs.veReppo, abi: VE_REPPO_ABI, functionName: 'votingPowerOf', args: [clients.account.address],
      })) as bigint;
      if (power === 0n) {
        throw Object.assign(
          new Error('Voter has zero voting power.'),
          { code: 'INSUFFICIENT_VOTING_POWER', hint: 'Run `reppo lock <amount> --duration 7200` first.' },
        );
      }

      const hasAccess = (await clients.publicClient.readContract({
        address: addrs.subnetManager, abi: SUBNET_MANAGER_ABI, functionName: 'hasSubnetAccess', args: [subnetId, clients.account.address],
      })) as boolean;
      if (!hasAccess) {
        throw Object.assign(
          new Error(`Voter lacks subnet ${subnetId} access.`),
          { code: 'VOTER_LACKS_SUBNET_ACCESS', hint: `Run \`reppo grant-access --subnet ${subnetId}\` first.` },
        );
      }

      if (this.dryRun) {
        const sim = await clients.publicClient.simulateContract({
          address: addrs.podManager, abi: POD_MANAGER_TESTNET_ABI, functionName: 'vote',
          args: [podId, subnetId, likeBool], account: clients.account,
        }).catch((e) => { throw Object.assign(new Error('Simulation reverted'), decodeRevert(e)); });
        emit({ simulated: true, podId: podId.toString(), subnetId: subnetId.toString(), like: likeBool, voterPower: power.toString(), gas: sim.request.gas?.toString() ?? null });
        return 0;
      }

      const tx = await withTxLock(async () => {
        const nonce = await nextNonce(clients.publicClient, clients.account.address);
        return clients.walletClient.writeContract({
          address: addrs.podManager, abi: POD_MANAGER_TESTNET_ABI, functionName: 'vote',
          args: [podId, subnetId, likeBool], chain: clients.walletClient.chain, account: clients.account, nonce,
        });
      }).catch((e) => { throw Object.assign(new Error('Vote tx failed to submit'), decodeRevert(e)); });

      const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
      if (receipt.status === 'reverted') {
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
      if (this.idempotencyKey) await saveIdempotent(this.idempotencyKey, command, result, tx);
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
