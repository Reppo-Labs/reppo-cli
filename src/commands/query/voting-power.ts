/**
 * `reppo query voting-power [address]` — show veREPPO voting power and
 * lockup count for an address. Defaults to the address derived from
 * REPPO_PRIVATE_KEY if no address is given.
 *
 * veReppo is the lockup NFT: each lockup the user has minted is a token
 * counted by `balanceOf(address)`, and `votingPowerOf(address)` aggregates
 * the points across all of them. An agent that just locked needs both:
 * "did the lockup mint succeed?" (lockupCount went up) and "how much
 * voting power did I get?" (votingPowerOf delta).
 *
 * If veReppo is TBD on the chosen network, each field emits
 * `{ unavailable: "<reason>" }` rather than a misleading 0.
 */
import { Option } from 'clipanion';
import { formatUnits, isAddress, type Address } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { BaseCommand } from '../_base.js';
import { cliError, emit } from '../../output/format.js';
import { createReadClient } from '../../chain/clients.js';
import { tryVeReppo } from '../../chain/contracts.js';

type Numeric =
  | { raw: string; formatted: string }
  | { unavailable: string };

type Count = { value: string } | { unavailable: string };

function unavailable(network: string): { unavailable: string } {
  return { unavailable: `veReppo address not configured for ${network}.` };
}

export class QueryVotingPowerCommand extends BaseCommand {
  static override paths = [['query', 'voting-power']];

  static override usage = BaseCommand.Usage({
    description: 'Show veREPPO voting power and lockup count for an address.',
    examples: [
      ['Query the wallet derived from REPPO_PRIVATE_KEY', 'reppo query voting-power'],
      ['Query a specific address',                          'reppo query voting-power 0x726c…E31d'],
      ['JSON output',                                       'reppo query voting-power --json'],
    ],
  });

  address = Option.String({ required: false });

  async execute(): Promise<number> {
    try {
      const cfg = this.loadConfig();
      const addr = this.resolveAddress(cfg.privateKey);
      const client = createReadClient({ network: cfg.network, ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}) });

      const ve = tryVeReppo(cfg.network);

      const votingPower: Numeric = ve
        ? await client.readContract({ ...ve, functionName: 'votingPowerOf', args: [addr] })
            .then((v) => ({ raw: v.toString(), formatted: formatUnits(v, 18) }))
        : unavailable(cfg.network);

      // RBV1 (robinhood) veReppo is a plain voting-power mirror, not a lockup
      // NFT — it has no balanceOf, and voting power there is admin-synced from
      // the wallet's Base veREPPO position via robinhood.reppo.ai.
      const lockupCount: Count = cfg.network === 'robinhood'
        ? { unavailable: 'no lockups on robinhood — voting power is mirrored from Base veREPPO.' }
        : ve
          ? await client.readContract({ ...ve, functionName: 'balanceOf', args: [addr] })
              .then((v) => ({ value: v.toString() }))
          : unavailable(cfg.network);

      const result = { address: addr, network: cfg.network, votingPower, lockupCount };

      const vpFmt = 'unavailable' in votingPower
        ? `(unavailable: ${votingPower.unavailable})`
        : votingPower.formatted;
      const lcFmt = 'unavailable' in lockupCount
        ? `(unavailable: ${lockupCount.unavailable})`
        : lockupCount.value;

      emit(result, [
        `Address:       ${addr}`,
        `Network:       ${cfg.network}`,
        `Voting power:  ${vpFmt}`,
        `Lockup count:  ${lcFmt}`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }

  private resolveAddress(pk: `0x${string}` | undefined): Address {
    if (this.address) {
      if (!isAddress(this.address)) {
        throw cliError('INVALID_ADDRESS', `Invalid address: ${this.address}`);
      }
      return this.address;
    }
    if (!pk) {
      throw cliError(
        'MISSING_ADDRESS',
        'No address provided and REPPO_PRIVATE_KEY not set.',
        'Pass an address argument or set REPPO_PRIVATE_KEY in env.',
      );
    }
    return privateKeyToAddress(pk);
  }
}
