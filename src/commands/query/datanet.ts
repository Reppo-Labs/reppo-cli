/**
 * `reppo query datanet <datanetId> [--for <address>]` — show whether a
 * datanet exists, its REPPO access fee, and (optionally) whether a given
 * address has access.
 *
 * "Datanet" is Reppo's user-facing term; on-chain the same concept is
 * called a "subnet" (SubnetManager, validSubnet, hasSubnetAccess). The
 * CLI uses the user-facing term at its surface and translates internally.
 *
 * Resolution order for the access check:
 *   1. --for <addr>            (explicit, no key needed)
 *   2. REPPO_PRIVATE_KEY       (derived from env)
 *   3. neither set              → callerAccess omitted from output
 *
 * If subnet manager is TBD on the chosen network (mainnet today), every
 * field emits `{ unavailable: "<reason>" }` rather than a misleading
 * default.
 */
import { Option } from 'clipanion';
import { formatUnits, isAddress, type Address } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { BaseCommand } from '../_base.js';
import { cliError, emit } from '../../output/format.js';
import { createReadClient } from '../../chain/clients.js';
import { trySubnetManager } from '../../chain/contracts.js';

type Numeric = { raw: string; formatted: string } | { unavailable: string };

function unavailable(reason: string): { unavailable: string } {
  return { unavailable: reason };
}

export class QueryDatanetCommand extends BaseCommand {
  static override paths = [['query', 'datanet']];

  static override usage = BaseCommand.Usage({
    description: 'Show datanet validity, REPPO access fee, and (optionally) whether an address has access.',
    examples: [
      ['Inspect datanet 19',
        'reppo query datanet 19'],
      ['Check whether a specific address has access',
        'reppo query datanet 19 --for 0x726c…E31d'],
      ['JSON output for an agent',
        'reppo query datanet 19 --json'],
    ],
  });

  datanet = Option.String({ required: true });
  for_ = Option.String('--for', { description: 'Address to check access for (defaults to address derived from REPPO_PRIVATE_KEY)' });

  async execute(): Promise<number> {
    try {
      const cfg = this.loadConfig();

      let datanetId: bigint;
      try {
        datanetId = BigInt(this.datanet);
      } catch {
        throw cliError('INVALID_DATANET_ID', `Datanet id must be a non-negative integer; got "${this.datanet}".`);
      }

      const client = createReadClient({ network: cfg.network, ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}) });
      const sm = trySubnetManager(cfg.network);

      if (!sm) {
        const reason = `Datanet manager address not configured for ${cfg.network}.`;
        emit(
          {
            datanetId: datanetId.toString(),
            network: cfg.network,
            valid: unavailable(reason),
            accessFeeREPPO: unavailable(reason),
          },
          [
            `Datanet:       ${datanetId}`,
            `Network:       ${cfg.network}`,
            `(unavailable: ${reason})`,
          ],
        );
        return 0;
      }

      // On-chain function names use the legacy "subnet" naming; CLI surface uses datanet.
      const valid: boolean = await client.readContract({ ...sm, functionName: 'validSubnet', args: [datanetId] });

      // Skip the fee read on invalid datanets — getAccessFeeREPPO is likely
      // to revert (or return 0) for non-existent datanets, and either way
      // the answer is "no fee because there is no datanet", not "fee is 0".
      const accessFeeREPPO: Numeric = valid
        ? await client.readContract({ ...sm, functionName: 'getAccessFeeREPPO', args: [datanetId] })
            .then((v) => ({ raw: v.toString(), formatted: formatUnits(v, 18) }))
        : unavailable('datanet does not exist');

      // Optional caller-access check.
      const callerAddr = this.resolveCallerAddress(cfg.privateKey);
      const callerAccess = callerAddr && valid
        ? {
            address: callerAddr,
            hasAccess: await client.readContract({
              ...sm, functionName: 'hasSubnetAccess', args: [datanetId, callerAddr],
            }),
          }
        : undefined;

      const result = {
        datanetId: datanetId.toString(),
        network: cfg.network,
        valid,
        accessFeeREPPO,
        ...(callerAccess ? { callerAccess } : {}),
      };

      const feeFmt = 'unavailable' in accessFeeREPPO
        ? `(unavailable: ${accessFeeREPPO.unavailable})`
        : `${accessFeeREPPO.formatted} REPPO`;

      const lines = [
        `Datanet:       ${datanetId}`,
        `Network:       ${cfg.network}`,
        `Valid:         ${valid}`,
        `Access fee:    ${feeFmt}`,
      ];
      if (callerAccess) {
        lines.push(`Caller:        ${callerAccess.address}`);
        lines.push(`Caller access: ${callerAccess.hasAccess}`);
      }

      emit(result, lines);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }

  private resolveCallerAddress(pk: `0x${string}` | undefined): Address | undefined {
    if (this.for_) {
      if (!isAddress(this.for_)) {
        throw cliError('INVALID_ADDRESS', `Invalid --for address: ${this.for_}`);
      }
      return this.for_;
    }
    if (pk) return privateKeyToAddress(pk);
    return undefined;
  }
}
