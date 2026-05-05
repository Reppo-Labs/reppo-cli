// TEMPLATE — minimal read command. Replace TODO markers and rename the class.
//
// Used by the command-scaffold skill. Mirror the style of
// src/commands/query/voting-power.ts and src/commands/query/subnet.ts.
//
// Pattern checklist:
//   - Extend BaseCommand (inherits --network, --json, --rpc-url, loadConfig, handleError)
//   - Use tryX() for any contract that may be TBD on the chosen network
//   - Use cliError() instead of Object.assign(new Error, ...)
//   - Use viem's isAddress() if accepting an address arg
//   - Render { unavailable: "..." } rather than misleading 0 when contract addr is TBD

import { Option } from 'clipanion';
import { formatUnits, isAddress, type Address } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { BaseCommand } from '../_base.js';
import { cliError, emit } from '../../output/format.js';
import { createReadClient } from '../../chain/clients.js';
// TODO: import the right tryX helper(s)
import { tryReppoToken /*, tryVeReppo, tryPodManager, trySubnetManager, tryUsdcToken */ } from '../../chain/contracts.js';

export class TODO_QueryCommand extends BaseCommand {
  // TODO: set the CLI path (kebab-case, lowercase)
  static override paths = [['query', 'TODO']];

  static override usage = BaseCommand.Usage({
    description: 'TODO: one-line description.',
    examples: [
      ['TODO: example 1', 'reppo query TODO'],
      ['TODO: example 2', 'reppo query TODO --json'],
    ],
  });

  // TODO: declare positional args + flags
  address = Option.String({ required: false });

  async execute(): Promise<number> {
    try {
      const cfg = this.loadConfig();
      const addr = this.resolveAddress(cfg.privateKey);
      const client = createReadClient({ network: cfg.network, ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}) });

      // TODO: pick the right tryX() and the right functionName.
      const contract = tryReppoToken(cfg.network);
      const value = contract
        ? await client.readContract({ ...contract, functionName: 'balanceOf', args: [addr] })
            .then((v) => ({ raw: v.toString(), formatted: formatUnits(v, 18) }))
        : { unavailable: `Contract address not configured for ${cfg.network}.` };

      const result = { address: addr, network: cfg.network, value };

      const valueLine = 'unavailable' in value
        ? `(unavailable: ${value.unavailable})`
        : value.formatted;

      emit(result, [
        `Address:  ${addr}`,
        `Network:  ${cfg.network}`,
        `Value:    ${valueLine}`,
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
