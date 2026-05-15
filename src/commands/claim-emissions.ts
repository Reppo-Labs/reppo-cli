/**
 * `reppo claim-emissions --pod <id> --epoch <n>` — claim a pod's
 * emissions for a given epoch.
 *
 * Pre-flight (V2, both networks):
 *   1. INVALID_POD_ID, INVALID_EPOCH (parse)
 *   2. NOT_POD_OWNER (ownerOf(podId) !== caller)
 *   3. ALREADY_CLAIMED (hasPodOwnerClaimedEmissions(epoch, podId) === true)
 *
 * PodManager V2 does not expose a per-pod "emissions due" view, so the
 * legacy NO_EMISSIONS_DUE pre-flight is gone — if there's nothing to
 * claim the contract reverts and the structured decoder surfaces the
 * code.
 *
 * Two-phase write protocol via peekIdempotent.
 *
 * Args fingerprint: { podId, epoch } — re-using one --idempotency-key
 * across different (podId, epoch) is rejected with IDEMPOTENCY_ARGS_MISMATCH.
 */
import { Option } from 'clipanion';
import { BaseCommand } from './_base.js';
import { cliError, emit } from '../output/format.js';
import { createClients, nextNonce } from '../chain/clients.js';
import { podManager } from '../chain/contracts.js';
import { decodeRevert } from '../chain/errors.js';
import { begin, markSubmitted, markConfirmed, markFailed, peekIdempotent } from '../state/idempotency.js';

const COMMAND = 'claim-emissions';

export class ClaimEmissionsCommand extends BaseCommand {
  static override paths = [['claim-emissions']];

  static override usage = BaseCommand.Usage({
    description: 'Claim a pod\'s emissions for a given epoch.',
    examples: [
      ['Claim emissions for pod 34, epoch 3940',
        'reppo claim-emissions --pod 34 --epoch 3940'],
      ['With idempotency key',
        'reppo claim-emissions --pod 34 --epoch 3940 --idempotency-key claim-34-3940'],
      ['Dry-run',
        'reppo claim-emissions --pod 34 --epoch 3940 --dry-run'],
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

      // Pre-flight: ownership (both networks support ownerOf).
      const owner = await clients.publicClient.readContract({
        address: pm.address, abi: pm.abi, functionName: 'ownerOf', args: [podId],
      }).catch(() => {
        throw cliError(
          'POD_NOT_FOUND',
          `Pod ${podId} does not exist on ${cfg.network}.`,
          'Verify the podId; check `reppo query pod <id>` first.',
        );
      });
      if (owner.toLowerCase() !== clients.account.address.toLowerCase()) {
        throw cliError(
          'NOT_POD_OWNER',
          `Pod ${podId} is owned by ${owner}, not by the configured signer ${clients.account.address}.`,
          'Use the private key of the pod owner.',
        );
      }

      // Pre-flight: already-claimed check. PodManager V2 does not
      // expose a per-pod "emissions due" view, so we no longer pre-
      // flight NO_EMISSIONS_DUE — the contract reverts cleanly if
      // there's nothing to claim and the decoder surfaces the code.
      const alreadyClaimed = await clients.publicClient.readContract({
        address: pm.address, abi: pm.abi, functionName: 'hasPodOwnerClaimedEmissions', args: [epoch, podId],
      });
      if (alreadyClaimed) {
        throw cliError(
          'ALREADY_CLAIMED',
          `Pod ${podId} emissions for epoch ${epoch} have already been claimed.`,
          'Nothing to do — pick a different epoch.',
        );
      }

      if (this.dryRun) {
        const sim = await clients.publicClient.simulateContract({
          address: pm.address, abi: pm.abi, functionName: 'claimPodOwnerEmissions',
          args: [podId, epoch], account: clients.account,
        }).catch((e) => {
          const decoded = decodeRevert(e);
          throw cliError(decoded.code, 'Simulation reverted', decoded.hint);
        });
        emit({
          simulated: true,
          podId: podId.toString(),
          epoch: epoch.toString(),
          owner,
          amountDue: { unavailable: 'PodManager V2 does not expose a per-pod emissions-due view' },
          gas: sim.request.gas?.toString() ?? null,
        });
        return 0;
      }

      if (this.idempotencyKey) await begin(this.idempotencyKey, COMMAND, args);

      let tx: `0x${string}`;
      try {
        const nonce = await nextNonce(clients.publicClient, clients.account.address);
        tx = await clients.walletClient.writeContract({
          address: pm.address, abi: pm.abi, functionName: 'claimPodOwnerEmissions',
          args: [podId, epoch],
          chain: clients.walletClient.chain, account: clients.account, nonce,
        });
      } catch (e) {
        const decoded = decodeRevert(e);
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, decoded.code);
        throw cliError(decoded.code, 'claim-emissions tx failed to submit', decoded.hint);
      }

      // markSubmitted BEFORE waitForReceipt — closes the retry-resend window.
      if (this.idempotencyKey) await markSubmitted(this.idempotencyKey, COMMAND, args, tx);

      const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
      if (receipt.status === 'reverted') {
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, 'TX_REVERTED', tx);
        throw cliError('TX_REVERTED', `claim-emissions tx reverted: ${tx}`);
      }

      const result = {
        txHash: tx,
        podId: podId.toString(),
        epoch: epoch.toString(),
        amountClaimed: { unavailable: 'PodManager V2 does not expose a per-pod emissions-due view' },
        block: receipt.blockNumber.toString(),
        basescanUrl: cfg.network === 'mainnet'
          ? `https://basescan.org/tx/${tx}`
          : `https://sepolia.basescan.org/tx/${tx}`,
      };
      if (this.idempotencyKey) await markConfirmed(this.idempotencyKey, COMMAND, args, result, tx);

      emit(result, [
        `✓ Claimed pod ${podId} emissions for epoch ${epoch}`,
        `  amount: (unknown — V2 has no per-pod emissions-due view)`,
        `  tx: ${result.basescanUrl}`,
        `  block: ${receipt.blockNumber}`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}
