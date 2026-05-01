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
import { setOutputMode, fail } from '../output/format.js';
import { loadConfig, type Config } from '../config/load.js';
import type { Network } from '../chain/addresses.js';

export abstract class BaseCommand extends Command {
  network = Option.String('--network', { description: 'mainnet | testnet' });
  json = Option.Boolean('--json', false, { description: 'Emit JSON to stdout' });
  rpcUrl = Option.String('--rpc-url', { description: 'Override RPC URL' });

  protected loadConfig(): Config {
    setOutputMode(this.json ? 'json' : 'human');
    const overrides: { network?: Network } = {};
    if (this.network === 'mainnet' || this.network === 'testnet') {
      overrides.network = this.network;
    } else if (this.network) {
      throw new Error(`--network must be "mainnet" or "testnet", got "${this.network}"`);
    }
    const cfg = loadConfig(overrides);
    if (this.rpcUrl) cfg.rpcUrl = this.rpcUrl;
    return cfg;
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
