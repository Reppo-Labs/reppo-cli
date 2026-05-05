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
import { formatUnits, isAddress, type Address } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { BaseCommand } from '../_base.js';
import { cliError, emit } from '../../output/format.js';
import { createReadClient } from '../../chain/clients.js';
import { tryReppoToken, tryUsdcToken, tryVeReppo } from '../../chain/contracts.js';

type Balance =
  | { raw: string; formatted: string }
  | { unavailable: string };

function unavailable(label: string, network: string): Balance {
  return { unavailable: `${label} address not configured for ${network}.` };
}

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
      const client = createReadClient({ network: cfg.network, ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}) });

      const eth = await client.getBalance({ address: addr });

      const reppoContract = tryReppoToken(cfg.network);
      const reppo: Balance = reppoContract
        ? await client.readContract({ ...reppoContract, functionName: 'balanceOf', args: [addr] })
            .then((v) => ({ raw: v.toString(), formatted: formatUnits(v, 18) }))
        : unavailable('REPPO token', cfg.network);

      const veReppoContract = tryVeReppo(cfg.network);
      const veReppo: Balance = veReppoContract
        ? await client.readContract({ ...veReppoContract, functionName: 'votingPowerOf', args: [addr] })
            .then((v) => ({ raw: v.toString(), formatted: formatUnits(v, 18) }))
        : unavailable('veReppo', cfg.network);

      const usdcContract = tryUsdcToken(cfg.network);
      const usdc: Balance = usdcContract
        ? await client.readContract({ ...usdcContract, functionName: 'balanceOf', args: [addr] })
            .then((v) => ({ raw: v.toString(), formatted: formatUnits(v, 6) }))
        : unavailable('USDC', cfg.network);

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
