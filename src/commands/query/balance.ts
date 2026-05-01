/**
 * `reppo query balance [address]` — show ETH + REPPO + veREPPO + USDC
 * balances for an address. Defaults to the address derived from
 * REPPO_PRIVATE_KEY if no address is given.
 *
 * Token contracts that are TBD on the current network (e.g. mainnet
 * veReppo today) emit `{ unavailable: "<reason>" }` instead of a
 * misleading 0 — so an agent can tell "user has nothing" apart from
 * "the CLI doesn't know where to look".
 */
import { Option } from 'clipanion';
import { formatUnits, type Address } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { BaseCommand } from '../_base.js';
import { emit } from '../../output/format.js';
import { createReadClient } from '../../chain/clients.js';
import { getAddresses } from '../../chain/addresses.js';
import { ERC20_ABI, VE_REPPO_ABI } from '../../chain/abis.js';

const TBD = '0x0000000000000000000000000000000000000000' as const;

type Balance =
  | { raw: string; formatted: string }
  | { unavailable: string };

export class QueryBalanceCommand extends BaseCommand {
  static override paths = [['query', 'balance']];

  static override usage = BaseCommand.Usage({
    description: 'Show on-chain balances (ETH, REPPO, veREPPO, USDC) for an address.',
    examples: [
      ['Query the wallet derived from REPPO_PRIVATE_KEY', 'reppo query balance'],
      ['Query a specific address',                         'reppo query balance 0x726c…E31d'],
      ['JSON output',                                      'reppo query balance --json'],
    ],
  });

  address = Option.String({ required: false });

  async execute(): Promise<number> {
    try {
      const cfg = this.loadConfig();
      const addr = this.resolveAddress(cfg.privateKey);
      const addrs = getAddresses(cfg.network);
      const client = createReadClient({ network: cfg.network, ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}) });

      const eth = await client.getBalance({ address: addr });

      const reppo: Balance = addrs.reppoToken === TBD
        ? { unavailable: `REPPO token address not configured for ${cfg.network}.` }
        : await client.readContract({
            address: addrs.reppoToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr],
          }).then((v) => ({ raw: (v as bigint).toString(), formatted: formatUnits(v as bigint, 18) }));

      const veReppo: Balance = addrs.veReppo === TBD
        ? { unavailable: `veReppo address not configured for ${cfg.network}.` }
        : await client.readContract({
            address: addrs.veReppo, abi: VE_REPPO_ABI, functionName: 'votingPowerOf', args: [addr],
          }).then((v) => ({ raw: (v as bigint).toString(), formatted: formatUnits(v as bigint, 18) }));

      const usdc: Balance = addrs.usdc === TBD
        ? { unavailable: `USDC address not configured for ${cfg.network}.` }
        : await client.readContract({
            address: addrs.usdc, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr],
          }).then((v) => ({ raw: (v as bigint).toString(), formatted: formatUnits(v as bigint, 6) }));

      const result = {
        address: addr,
        network: cfg.network,
        balances: {
          eth: { raw: eth.toString(), formatted: formatUnits(eth, 18) },
          reppo,
          veReppo,
          usdc,
        },
      };

      const fmt = (b: Balance): string =>
        'unavailable' in b ? `(unavailable: ${b.unavailable})` : b.formatted;

      emit(result, [
        `Address:  ${addr}`,
        `Network:  ${cfg.network}`,
        `ETH:      ${formatUnits(eth, 18)}`,
        `REPPO:    ${fmt(reppo)}`,
        `veREPPO:  ${fmt(veReppo)}`,
        `USDC:     ${fmt(usdc)}`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }

  private resolveAddress(pk: `0x${string}` | undefined): Address {
    if (this.address) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(this.address)) {
        throw Object.assign(new Error(`Invalid address: ${this.address}`), { code: 'INVALID_ADDRESS' });
      }
      return this.address as Address;
    }
    if (!pk) {
      throw Object.assign(
        new Error('No address provided and REPPO_PRIVATE_KEY not set.'),
        { code: 'MISSING_ADDRESS', hint: 'Pass an address argument or set REPPO_PRIVATE_KEY in env.' },
      );
    }
    return privateKeyToAddress(pk);
  }
}
