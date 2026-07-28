/**
 * Shared base class for all CLI commands. Wires up:
 *   - --network flag (overrides REPPO_NETWORK env)
 *   - --json flag (sets output mode)
 *   - --rpc-url flag (override RPC)
 *   - structured error catch
 *
 * Subclasses implement run() and call this.exit() on success.
 */
import { Command, Option } from 'clipanion';
import { setOutputMode, fail, cliError } from '../output/format.js';
import { loadConfig, type Config } from '../config/load.js';
import type { Network } from '../chain/addresses.js';

export abstract class BaseCommand extends Command {
  network = Option.String('--network', { description: 'mainnet | testnet' });
  json = Option.Boolean('--json', false, { description: 'Emit JSON to stdout' });
  rpcUrl = Option.String('--rpc-url', { description: 'Override RPC URL' });

  protected loadConfig(): Config {
    setOutputMode(this.json ? 'json' : 'human');
    const overrides: { network?: Network } = {};
    if (this.network === 'mainnet' || this.network === 'testnet' || this.network === 'robinhood') {
      overrides.network = this.network;
    } else if (this.network) {
      throw cliError(
        'INVALID_NETWORK',
        `--network must be "mainnet", "testnet", or "robinhood", got "${this.network}"`,
      );
    }
    const cfg = loadConfig(overrides);
    if (this.rpcUrl) cfg.rpcUrl = this.rpcUrl;
    return cfg;
  }

  /**
   * Guard for commands that require on-chain veREPPO staking. Robinhood
   * Chain runs the RBV1 variant: VeReppoRBV1 has no stake/withdraw —
   * voting power there is mirrored from the wallet's Base veREPPO
   * position by robinhood.reppo.ai.
   */
  protected requireStakingNetwork(network: Network): void {
    if (network === 'robinhood') {
      throw cliError(
        'UNSUPPORTED_ON_NETWORK',
        'veREPPO staking does not exist on Robinhood Chain — voting power is mirrored from your Base veREPPO position.',
        'Lock on Base instead (`reppo lock --network mainnet …`), then sync voting power at https://robinhood.reppo.ai.',
      );
    }
  }

  protected handleError(err: unknown): never {
    const e = err as { code?: string; message?: string; hint?: string };
    fail({
      code: e.code ?? 'INTERNAL_ERROR',
      message: e.message ?? String(err),
      ...(e.hint ? { hint: e.hint } : {}),
    });
  }
}
