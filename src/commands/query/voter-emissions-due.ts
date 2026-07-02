/**
 * `reppo query voter-emissions-due --pod <id> --epoch <n> [--voter <addr>]` —
 * is the voter's emissions share for a pod/epoch still claimable?
 *
 * PodManager V2 exposes no per-(voter, pod) due-AMOUNT view — the exact payout
 * is computed inside claimVoterEmissions. What IS readable on-chain:
 *   - getVotersUpVotesForPodInEpoch / getVotersDownVotesForPodInEpoch
 *     (did this voter vote on this pod in this epoch, and with what weight)
 *   - hasUserClaimedEmissions (has the voter already claimed this pod/epoch)
 *
 * So this command answers CLAIMABILITY, not amount:
 *   claimable = (upVotes + downVotes) > 0 && !claimed
 * That is the exact pre-flight `claim-voter-emissions` lacks — without it, the
 * only way to discover "nothing due" is an on-chain revert that burns gas.
 * `amount` is intentionally absent from the output rather than estimated: pool
 * math lives in the contract and replicating it here would silently drift.
 *
 * Voter resolution mirrors query datanet's --for:
 *   1. --voter <addr>                       (explicit, no key needed)
 *   2. REPPO_VOTER_PRIVATE_KEY              (the vote command's signer)
 *   3. REPPO_PRIVATE_KEY                    (single-wallet setups)
 */
import { Option } from 'clipanion';
import { isAddress, type Address } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { BaseCommand } from '../_base.js';
import { cliError, emit } from '../../output/format.js';
import { createReadClient } from '../../chain/clients.js';
import { tryPodManager } from '../../chain/contracts.js';

export class QueryVoterEmissionsDueCommand extends BaseCommand {
  static override paths = [['query', 'voter-emissions-due']];

  static override usage = BaseCommand.Usage({
    description: 'Check whether voter emissions for a pod/epoch are still claimable (pre-flight for claim-voter-emissions).',
    examples: [
      ['Check pod 34, epoch 101, for the env-configured voter',
        'reppo query voter-emissions-due --pod 34 --epoch 101'],
      ['Check for an explicit address (no key needed)',
        'reppo query voter-emissions-due --pod 34 --epoch 101 --voter 0x726c…E31d'],
      ['JSON output for an agent',
        'reppo query voter-emissions-due --pod 34 --epoch 101 --json'],
    ],
  });

  pod = Option.String('--pod', { required: true, description: 'Pod id the voter voted on' });
  epoch = Option.String('--epoch', { required: true, description: 'Epoch the votes were cast in' });
  voter = Option.String('--voter', { description: 'Voter address (defaults to REPPO_VOTER_PRIVATE_KEY, then REPPO_PRIVATE_KEY)' });

  async execute(): Promise<number> {
    try {
      const cfg = this.loadConfig();

      let podId: bigint;
      try {
        podId = BigInt(this.pod);
      } catch {
        throw cliError('INVALID_POD_ID', `Pod id must be a non-negative integer; got "${this.pod}".`);
      }
      let epoch: bigint;
      try {
        epoch = BigInt(this.epoch);
      } catch {
        throw cliError('INVALID_EPOCH', `Epoch must be a non-negative integer; got "${this.epoch}".`);
      }

      const voter = this.resolveVoter();
      if (!voter) {
        throw cliError(
          'VOTER_ADDRESS_REQUIRED',
          'No voter address available.',
          'Pass --voter <address>, or set REPPO_VOTER_PRIVATE_KEY / REPPO_PRIVATE_KEY.',
        );
      }

      const client = createReadClient({ network: cfg.network, ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}) });
      const pm = tryPodManager(cfg.network);
      if (!pm) {
        const reason = `PodManager address not configured for ${cfg.network}.`;
        emit(
          {
            podId: podId.toString(), epoch: Number(epoch), voter, network: cfg.network,
            claimable: { unavailable: reason },
          },
          [
            `Pod:       ${podId}`,
            `Epoch:     ${epoch}`,
            `Voter:     ${voter}`,
            `(unavailable: ${reason})`,
          ],
        );
        return 0;
      }

      const [upVotes, downVotes, claimed] = await Promise.all([
        client.readContract({ ...pm, functionName: 'getVotersUpVotesForPodInEpoch', args: [epoch, podId, voter] }),
        client.readContract({ ...pm, functionName: 'getVotersDownVotesForPodInEpoch', args: [epoch, podId, voter] }),
        client.readContract({ ...pm, functionName: 'hasUserClaimedEmissions', args: [epoch, podId, voter] }),
      ]);

      const voted = upVotes + downVotes > 0n;
      const claimable = voted && !claimed;

      const result = {
        podId: podId.toString(),
        epoch: Number(epoch),
        voter,
        network: cfg.network,
        upVotes: upVotes.toString(),
        downVotes: downVotes.toString(),
        voted,
        claimed,
        claimable,
        // The exact payout is computed inside claimVoterEmissions; V2 exposes no
        // due-amount view. Stated explicitly so agents don't wait for a field
        // that will never appear.
        note: 'claimable = voted && !claimed; the payout amount is only known at claim time',
      };

      emit(result, [
        `Pod:       ${podId}`,
        `Epoch:     ${epoch}`,
        `Voter:     ${voter}`,
        `Votes:     ${upVotes}↑ / ${downVotes}↓`,
        `Claimed:   ${claimed}`,
        `Claimable: ${claimable}${claimable ? ' — run `reppo claim-voter-emissions --pod ' + podId + ' --epoch ' + epoch + '`' : ''}`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }

  private resolveVoter(): Address | undefined {
    if (this.voter) {
      if (!isAddress(this.voter)) {
        throw cliError('INVALID_ADDRESS', `Invalid --voter address: ${this.voter}`);
      }
      return this.voter;
    }
    const pk = (process.env.REPPO_VOTER_PRIVATE_KEY ?? process.env.REPPO_PRIVATE_KEY) as `0x${string}` | undefined;
    if (pk) return privateKeyToAddress(pk);
    return undefined;
  }
}
