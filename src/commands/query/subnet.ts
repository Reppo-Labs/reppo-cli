/**
 * `reppo query subnet <subnetId> [--for <address>]` — show whether a
 * subnet exists, its REPPO access fee, and (optionally) whether a given
 * address has access.
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

export class QuerySubnetCommand extends BaseCommand {
  static override paths = [['query', 'subnet']];

  static override usage = BaseCommand.Usage({
    description: 'Show subnet validity, REPPO access fee, and (optionally) whether an address has access.',
    examples: [
      ['Inspect subnet 19',
        'reppo query subnet 19'],
      ['Check whether a specific address has access',
        'reppo query subnet 19 --for 0x726c…E31d'],
      ['JSON output for an agent',
        'reppo query subnet 19 --json'],
    ],
  });

  subnet = Option.String({ required: true });
  for_ = Option.String('--for', { description: 'Address to check access for (defaults to address derived from REPPO_PRIVATE_KEY)' });

  async execute(): Promise<number> {
    try {
      const cfg = this.loadConfig();

      let subnetId: bigint;
      try {
        subnetId = BigInt(this.subnet);
      } catch {
        throw cliError('INVALID_SUBNET_ID', `Subnet id must be a non-negative integer; got "${this.subnet}".`);
      }

      const client = createReadClient({ network: cfg.network, ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}) });
      const sm = trySubnetManager(cfg.network);

      if (!sm) {
        const reason = `SubnetManager address not configured for ${cfg.network}.`;
        emit(
          {
            subnetId: subnetId.toString(),
            network: cfg.network,
            valid: unavailable(reason),
            accessFeeREPPO: unavailable(reason),
          },
          [
            `Subnet:        ${subnetId}`,
            `Network:       ${cfg.network}`,
            `(unavailable: ${reason})`,
          ],
        );
        return 0;
      }

      const valid: boolean = await client.readContract({ ...sm, functionName: 'validSubnet', args: [subnetId] });

      // Skip the fee read on invalid subnets — getAccessFeeREPPO is likely
      // to revert (or return 0) for non-existent subnets, and either way
      // the answer is "no fee because there is no subnet", not "fee is 0".
      const accessFeeREPPO: Numeric = valid
        ? await client.readContract({ ...sm, functionName: 'getAccessFeeREPPO', args: [subnetId] })
            .then((v) => ({ raw: v.toString(), formatted: formatUnits(v, 18) }))
        : unavailable('subnet does not exist');

      // Optional caller-access check.
      const callerAddr = this.resolveCallerAddress(cfg.privateKey);
      const callerAccess = callerAddr && valid
        ? {
            address: callerAddr,
            hasAccess: await client.readContract({
              ...sm, functionName: 'hasSubnetAccess', args: [subnetId, callerAddr],
            }),
          }
        : undefined;

      const result = {
        subnetId: subnetId.toString(),
        network: cfg.network,
        valid,
        accessFeeREPPO,
        ...(callerAccess ? { callerAccess } : {}),
      };

      const feeFmt = 'unavailable' in accessFeeREPPO
        ? `(unavailable: ${accessFeeREPPO.unavailable})`
        : `${accessFeeREPPO.formatted} REPPO`;

      const lines = [
        `Subnet:        ${subnetId}`,
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
