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

cli.runExit(process.argv.slice(2));
