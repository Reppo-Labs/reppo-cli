/**
 * `reppo query pod <podId>` — show whether a pod exists and who owns it.
 *
 * The PodManager is an ERC-721 — `ownerOf(tokenId)` reverts on non-
 * existent tokens (per the spec). We render `{ exists: false, owner: null }`
 * for any revert from that call. RPC errors *also* show up that way; for
 * an alpha read command that's an acceptable trade-off versus introspecting
 * the revert reason. (Real bugs surface as RPC errors elsewhere.)
 *
 * The mainnet PodManager and testnet PodManager (forked variant) share the
 * `ownerOf` selector, so this command works on both networks via
 * `tryPodManager(network)` — viem pairs the right ABI with the right
 * address automatically.
 */
import { Option } from 'clipanion';
import { BaseCommand } from '../_base.js';
import { cliError, emit } from '../../output/format.js';
import { createReadClient } from '../../chain/clients.js';
import { tryPodManager } from '../../chain/contracts.js';

export class QueryPodCommand extends BaseCommand {
  static override paths = [['query', 'pod']];

  static override usage = BaseCommand.Usage({
    description: 'Show pod existence and ownership.',
    examples: [
      ['Inspect pod 34',
        'reppo query pod 34'],
      ['JSON output for an agent',
        'reppo query pod 34 --json'],
    ],
  });

  pod = Option.String({ required: true });

  async execute(): Promise<number> {
    try {
      const cfg = this.loadConfig();

      let podId: bigint;
      try {
        podId = BigInt(this.pod);
      } catch {
        throw cliError('INVALID_POD_ID', `Pod id must be a non-negative integer; got "${this.pod}".`);
      }

      const client = createReadClient({ network: cfg.network, ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}) });
      const pm = tryPodManager(cfg.network);

      if (!pm) {
        const reason = `PodManager address not configured for ${cfg.network}.`;
        emit(
          {
            podId: podId.toString(),
            network: cfg.network,
            exists: { unavailable: reason },
            owner: { unavailable: reason },
          },
          [
            `Pod:           ${podId}`,
            `Network:       ${cfg.network}`,
            `(unavailable: ${reason})`,
          ],
        );
        return 0;
      }

      let owner: `0x${string}` | null = null;
      let exists = false;
      try {
        owner = await client.readContract({ ...pm, functionName: 'ownerOf', args: [podId] });
        exists = true;
      } catch {
        // ownerOf reverts on non-existent tokens (ERC-721 spec). We
        // intentionally don't decodeRevert here — the answer the user
        // wants is "does this pod exist?", not the revert reason.
      }

      const result = {
        podId: podId.toString(),
        network: cfg.network,
        exists,
        owner,
      };

      emit(result, [
        `Pod:           ${podId}`,
        `Network:       ${cfg.network}`,
        `Exists:        ${exists}`,
        `Owner:         ${owner ?? '(none — pod does not exist)'}`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}
