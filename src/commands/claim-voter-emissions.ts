/**
 * `reppo claim-voter-emissions --pod <id> --epoch <n>` — claim the SIGNER's
 * voter emissions for a pod it up/down-voted in a given epoch.
 *
 * Counterpart to `claim-emissions` (which claims the POD OWNER's emissions via
 * claimPodOwnerEmissions). Voters earn a separate share of a pod's epoch pool
 * for curating it; that reward is claimed with claimVoterEmissions(voter, podId,
 * epoch) and was previously unclaimable through the CLI.
 *
 * Pre-flight (V2):
 *   1. INVALID_POD_ID, INVALID_EPOCH (parse)
 *   2. ALREADY_CLAIMED (hasUserClaimedEmissions(epoch, podId, voter) === true)
 *
 * No ownership check — the caller claims AS A VOTER, not the owner. PodManager
 * V2 exposes no per-(voter,pod) "due" view, so there is no NO_EMISSIONS_DUE
 * pre-flight: the contract reverts cleanly when nothing is due and the
 * structured decoder surfaces the code.
 *
 * Two-phase write protocol via peekIdempotent.
 * Args fingerprint: { podId, epoch } — re-using one --idempotency-key across
 * different (podId, epoch) is rejected with IDEMPOTENCY_ARGS_MISMATCH.
 */
import { Option } from 'clipanion';
import { BaseCommand } from './_base.js';
import { cliError, emit } from '../output/format.js';
import { createClients, nextNonce } from '../chain/clients.js';
import { podManager } from '../chain/contracts.js';
import { decodeRevert } from '../chain/errors.js';
import { handleSubmittedCacheDecision, basescanTxUrl } from './write-cache.js';
import { waitForWriteReceipt, receiptGasEth } from '../chain/receipt.js';
import { begin, markSubmitted, markConfirmed, markFailed, peekIdempotent } from '../state/idempotency.js';

const COMMAND = 'claim-voter-emissions';

export class ClaimVoterEmissionsCommand extends BaseCommand {
  static override paths = [['claim-voter-emissions']];

  static override usage = BaseCommand.Usage({
    description: 'Claim your voter emissions for a pod you voted on, for a given epoch.',
    examples: [
      ['Claim voter emissions for pod 34, epoch 3940',
        'reppo claim-voter-emissions --pod 34 --epoch 3940'],
      ['With idempotency key',
        'reppo claim-voter-emissions --pod 34 --epoch 3940 --idempotency-key claim-voter-34-3940'],
      ['Dry-run',
        'reppo claim-voter-emissions --pod 34 --epoch 3940 --dry-run'],
    ],
  });

  pod = Option.String('--pod', { required: true });
  epoch = Option.String('--epoch', { required: true });
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

      const args = { podId: podId.toString(), epoch: epoch.toString() };

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
          buildResult: () => ({
            podId: podId.toString(),
            epoch: epoch.toString(),
            amountClaimed: { unavailable: 'PodManager V2 does not expose a per-voter emissions-due view' },
          }),
        });
      }

      const clients = createClients({
        network: cfg.network,
        privateKey: pk,
        ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}),
      });
      const pm = podManager(cfg.network);
      const voter = clients.account.address;

      // Pre-flight: already-claimed by THIS voter for (epoch, pod). PodManager V2
      // exposes no per-(voter,pod) "due" view, so NO_EMISSIONS_DUE is not pre-
      // flighted — the contract reverts cleanly and the decoder surfaces the code.
      const alreadyClaimed = await clients.publicClient.readContract({
        address: pm.address, abi: pm.abi, functionName: 'hasUserClaimedEmissions', args: [epoch, podId, voter],
      });
      if (alreadyClaimed) {
        throw cliError(
          'ALREADY_CLAIMED',
          `Voter emissions for pod ${podId}, epoch ${epoch} have already been claimed by ${voter}.`,
          'Nothing to do — pick a different (pod, epoch).',
        );
      }

      if (this.dryRun) {
        const sim = await clients.publicClient.simulateContract({
          address: pm.address, abi: pm.abi, functionName: 'claimVoterEmissions',
          args: [voter, podId, epoch], account: clients.account,
        }).catch((e) => {
          const decoded = decodeRevert(e);
          throw cliError(decoded.code, 'Simulation reverted', decoded.hint);
        });
        emit({
          simulated: true,
          voter,
          podId: podId.toString(),
          epoch: epoch.toString(),
          amountDue: { unavailable: 'PodManager V2 does not expose a per-voter emissions-due view' },
          gas: sim.request.gas?.toString() ?? null,
        });
        return 0;
      }

      if (this.idempotencyKey) await begin(this.idempotencyKey, COMMAND, args);

      let tx: `0x${string}`;
      try {
        const nonce = await nextNonce(clients.publicClient, clients.account.address);
        tx = await clients.walletClient.writeContract({
          address: pm.address, abi: pm.abi, functionName: 'claimVoterEmissions',
          args: [voter, podId, epoch],
          chain: clients.walletClient.chain, account: clients.account, nonce,
        });
      } catch (e) {
        const decoded = decodeRevert(e);
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, decoded.code);
        throw cliError(decoded.code, 'claim-voter-emissions tx failed to submit', decoded.hint);
      }

      // markSubmitted BEFORE waitForReceipt — closes the retry-resend window.
      if (this.idempotencyKey) {
        await markSubmitted(this.idempotencyKey, COMMAND, args, tx, {
          podId: podId.toString(),
          epoch: epoch.toString(),
          amountClaimed: { unavailable: 'PodManager V2 does not expose a per-voter emissions-due view' },
        });
      }

      const receipt = await waitForWriteReceipt(clients.publicClient, tx);
      if (receipt.status === 'reverted') {
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, 'TX_REVERTED', tx);
        throw cliError('TX_REVERTED', `claim-voter-emissions tx reverted: ${tx}`);
      }

      const result = {
        txHash: tx,
        gasEth: receiptGasEth(receipt),
        voter,
        podId: podId.toString(),
        epoch: epoch.toString(),
        amountClaimed: { unavailable: 'PodManager V2 does not expose a per-voter emissions-due view' },
        block: receipt.blockNumber.toString(),
        basescanUrl: basescanTxUrl(cfg.network, tx),
      };
      if (this.idempotencyKey) await markConfirmed(this.idempotencyKey, COMMAND, args, result, tx);

      emit(result, [
        `✓ Claimed voter emissions for pod ${podId}, epoch ${epoch}`,
        `  amount: (unknown — V2 has no per-voter emissions-due view)`,
        `  tx: ${result.basescanUrl}`,
        `  block: ${receipt.blockNumber}`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}
