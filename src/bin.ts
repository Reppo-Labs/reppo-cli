#!/usr/bin/env node
/**
 * @reppo-labs/cli entry point. Registers every command class and dispatches
 * via clipanion's runExit.
 */
import { Cli, Builtins } from 'clipanion';
import { QueryBalanceCommand } from './commands/query/balance.js';
import { VoteCommand } from './commands/vote.js';

const cli = new Cli({
  binaryLabel: 'Reppo CLI',
  binaryName: 'reppo',
  binaryVersion: '0.1.0-alpha.0',
  enableCapture: false,
});

cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);

cli.register(QueryBalanceCommand);
cli.register(VoteCommand);

// TODO: register remaining 13 commands as they're implemented:
//   query pod, query subnet, query voting-power, query emissions-due,
//   mint-pod, claim-emissions, grant-access,
//   lock, unlock, extend-lock,
//   create-datanet, register-agent, swap.

// Wrap clipanion's runExit so any synchronous throw during command
// registration / arg-parsing flows through the structured `fail()`
// instead of leaking a raw stack to stderr (agents would lose the
// `code` field they key off).
import { fail } from './output/format.js';

try {
  await cli.runExit(process.argv.slice(2));
} catch (err) {
  fail({
    code: 'CLI_INIT_ERROR',
    message: err instanceof Error ? err.message : String(err),
  });
}
