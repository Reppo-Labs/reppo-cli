/**
 * `reppo query epoch` — report the current on-chain epoch, read directly
 * from the Reppo contracts (no off-chain inference).
 *
 * Source of truth: veReppo is the protocol's epoch time-base. Both
 * PodManagerV2 and SubnetManager compute epoch as `veReppo.currentEpoch()`,
 * so this command reads that getter directly rather than inferring epoch
 * from pod `validityEpoch`s (which lag when no pod has published this epoch).
 *
 * Epochs are fixed-length windows (`epochLength()` ≈ 48h). `epochEnd(epoch)`
 * returns the unix second the epoch ends (== the next epoch's start), so:
 *   epochStart       = epochEnd(currentEpoch) - epochLength
 *   secondsRemaining = epochEnd(currentEpoch) - <latest block timestamp>
 *
 * The epoch number is read first and is authoritative. The timing fields are
 * best-effort: if `epochLength`/`epochEnd` are absent on a given deployment
 * they degrade to `null` without breaking the epoch read. `secondsRemaining`
 * uses the chain's latest block timestamp, not the local clock, to keep the
 * answer purely on-chain.
 *
 * Pure read: `eth_call` only — no transaction, no signing key, no gas.
 */
import { BaseCommand } from '../_base.js';
import { emit } from '../../output/format.js';
import { createReadClient } from '../../chain/clients.js';
import { tryVeReppo } from '../../chain/contracts.js';

export class QueryEpochCommand extends BaseCommand {
  static override paths = [['query', 'epoch']];

  static override usage = BaseCommand.Usage({
    description: 'Show the current on-chain epoch (read from the Reppo contracts).',
    examples: [
      ['Current epoch on mainnet', 'reppo query epoch'],
      ['JSON output for an agent', 'reppo query epoch --json'],
      ['Against a private RPC',     'reppo query epoch --rpc-url https://my-base-rpc'],
    ],
  });

  async execute(): Promise<number> {
    try {
      const cfg = this.loadConfig();
      const ve = tryVeReppo(cfg.network);

      if (!ve) {
        const reason = `veReppo address not configured for ${cfg.network}.`;
        const result = {
          network: cfg.network,
          epoch: null,
          epochStart: null,
          epochDurationSeconds: null,
          secondsRemaining: null,
        };
        emit(result, [
          `Network:       ${cfg.network}`,
          `(on-chain unavailable: ${reason})`,
        ]);
        return 0;
      }

      const client = createReadClient({ network: cfg.network, ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}) });

      // Authoritative: the epoch number itself.
      const epoch = await client.readContract({ ...ve, functionName: 'currentEpoch' });

      // Best-effort timing. epochLength + epochEnd let us derive start and
      // seconds-remaining; either being absent degrades only the timing
      // fields, never the epoch number.
      let epochStart: number | null = null;
      let epochDurationSeconds: number | null = null;
      let secondsRemaining: number | null = null;
      try {
        const [epochLength, epochEnd, block] = await Promise.all([
          client.readContract({ ...ve, functionName: 'epochLength' }),
          client.readContract({ ...ve, functionName: 'epochEnd', args: [epoch] }),
          client.getBlock({ blockTag: 'latest' }),
        ]);
        epochDurationSeconds = Number(epochLength);
        epochStart = Number(epochEnd - epochLength);
        // Clamp: epochEnd(currentEpoch) is always > the timestamp that
        // produced currentEpoch, but guard against a stale block read.
        const remaining = epochEnd - block.timestamp;
        secondsRemaining = remaining > 0n ? Number(remaining) : 0;
      } catch {
        // Timing getters unavailable on this deployment — leave nulls.
      }

      const result = {
        network: cfg.network,
        epoch: Number(epoch),
        epochStart,
        epochDurationSeconds,
        secondsRemaining,
      };

      const lines = [
        `Network:       ${cfg.network}`,
        `Current epoch: ${result.epoch}`,
      ];
      if (epochStart !== null) {
        lines.push(`Epoch start:   ${new Date(epochStart * 1000).toISOString()} (${epochStart})`);
      }
      if (secondsRemaining !== null) {
        const h = Math.floor(secondsRemaining / 3600);
        const m = Math.floor((secondsRemaining % 3600) / 60);
        lines.push(`Next epoch in: ${h}h ${m}m (${secondsRemaining}s)`);
      }

      emit(result, lines);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}
