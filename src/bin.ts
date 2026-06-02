#!/usr/bin/env node
/**
 * @reppo/cli entry point. Registers every command class and dispatches
 * via clipanion's runExit.
 */
import { Cli, Builtins } from 'clipanion';
import { ApproveCommand } from './commands/approve.js';
import { AuthCommand } from './commands/auth.js';
import { ClaimEmissionsCommand } from './commands/claim-emissions.js';
import { ExtendLockCommand } from './commands/extend-lock.js';
import { GrantAccessCommand } from './commands/grant-access.js';
import { ListDatanetsCommand } from './commands/list/datanets.js';
import { ListPodsCommand } from './commands/list/pods.js';
import { LockCommand } from './commands/lock.js';
import { MintPodCommand } from './commands/mint-pod.js';
import { QueryBalanceCommand } from './commands/query/balance.js';
import { QueryDatanetCommand } from './commands/query/datanet.js';
import { QueryEmissionsDueCommand } from './commands/query/emissions-due.js';
import { QueryPodCommand } from './commands/query/pod.js';
import { QueryVotingPowerCommand } from './commands/query/voting-power.js';
import { RegisterAgentCommand } from './commands/register-agent.js';
import { UnlockCommand } from './commands/unlock.js';
import { VoteCommand } from './commands/vote.js';

const cli = new Cli({
  binaryLabel: 'Reppo CLI',
  binaryName: 'reppo',
  binaryVersion: '0.7.0',
  enableCapture: false,
});

cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);

cli.register(ApproveCommand);
cli.register(AuthCommand);
cli.register(ClaimEmissionsCommand);
cli.register(ExtendLockCommand);
cli.register(GrantAccessCommand);
cli.register(ListDatanetsCommand);
cli.register(ListPodsCommand);
cli.register(LockCommand);
cli.register(MintPodCommand);
cli.register(QueryBalanceCommand);
cli.register(QueryDatanetCommand);
cli.register(QueryEmissionsDueCommand);
cli.register(QueryPodCommand);
cli.register(QueryVotingPowerCommand);
cli.register(RegisterAgentCommand);
cli.register(UnlockCommand);
cli.register(VoteCommand);

// TODO: 2 commands still pending:
//   create-datanet (browser-only — blocked: Privy session cookie auth)
//   swap (deferred-by-scope: Uniswap V3 multi-tx flow)

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
