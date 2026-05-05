// TEMPLATE — write command (signs and submits a tx). Replace TODO markers.
//
// Used by the command-scaffold skill. Mirror the style of src/commands/vote.ts.
//
// Pattern checklist:
//   - Validate args BEFORE loadConfig (cheapest path).
//   - Resolve the signing key (cfg.voterPrivateKey ?? cfg.privateKey if voter cmd).
//   - Build the args fingerprint object — include EVERY arg that affects intent.
//   - Use peekIdempotent<R>(key, COMMAND, args, isDryRun) and switch on .kind.
//   - Pre-flight reads (voting power, subnet access, etc.) BEFORE the dry-run
//     branch so dry-run still surfaces precondition failures cleanly.
//   - On dry-run, NEVER write to the cache — emit the simulation result and return.
//   - Two-phase write: begin → submit → markSubmitted → wait → markConfirmed/markFailed.
//   - markSubmitted MUST persist BEFORE waitForReceipt (close the retry-resend window).
//   - Pass txHash to markFailed when the failure was post-broadcast (peekIdempotent
//     uses the txHash presence to refuse same-key retries).

import { Option } from 'clipanion';
import { BaseCommand } from './_base.js';
import { cliError, emit } from '../output/format.js';
import { createClients, nextNonce } from '../chain/clients.js';
// TODO: import the right contract helper (throwing variant — write commands must fail loud on TBD)
import { podManager /*, subnetManager, veReppo */ } from '../chain/contracts.js';
import { decodeRevert } from '../chain/errors.js';
import { begin, markSubmitted, markConfirmed, markFailed, peekIdempotent } from '../state/idempotency.js';

const COMMAND = 'TODO-command-name';

export class TODO_Command extends BaseCommand {
  // TODO: set CLI path
  static override paths = [['TODO']];

  static override usage = BaseCommand.Usage({
    description: 'TODO: one-line description.',
    examples: [
      ['TODO: example', 'reppo TODO --idempotency-key job-1'],
      ['Dry-run',       'reppo TODO --dry-run'],
    ],
  });

  // TODO: declare flags
  idempotencyKey = Option.String('--idempotency-key');
  dryRun = Option.Boolean('--dry-run', false);

  async execute(): Promise<number> {
    try {
      // TODO: validate args (e.g. require exactly one of --like/--dislike)

      const cfg = this.loadConfig();
      const pk = cfg.privateKey;
      if (!pk) {
        throw cliError(
          'MISSING_PRIVATE_KEY',
          'No signing key available.',
          'Set REPPO_PRIVATE_KEY in env.',
        );
      }

      // TODO: build args object — must include every arg that changes the
      // tx's effect, so peekIdempotent rejects key reuse with different intent.
      const args = { /* TODO: e.g. podId, subnetId, like */ };

      // Cache decision policy lives in peekIdempotent. Just switch on the kind.
      const decision = await peekIdempotent<Record<string, unknown>>(
        this.idempotencyKey, COMMAND, args, this.dryRun,
      );
      if (decision.kind === 'return-confirmed') {
        emit({ ...decision.result, idempotent: true, status: 'confirmed' },
          [`(cached, confirmed) tx: ${decision.txHash ?? 'n/a'}`]);
        return 0;
      }
      if (decision.kind === 'return-submitted') {
        emit({ ...decision.result, idempotent: true, status: 'submitted' },
          [`(cached, submitted but not confirmed yet) tx: ${decision.txHash ?? 'n/a'}`,
           `Re-run after the tx confirms, or check the explorer.`]);
        return 0;
      }

      const clients = createClients({
        network: cfg.network,
        privateKey: pk,
        ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}),
      });
      // TODO: fetch the right contract (throwing variant)
      const c = podManager(cfg.network);

      // TODO: pre-flight reads — keep BEFORE dry-run so simulation still
      // surfaces precondition failures with structured codes.

      if (this.dryRun) {
        const sim = await clients.publicClient.simulateContract({
          address: c.address, abi: c.abi, functionName: 'TODO',
          args: [/* TODO */] as const, account: clients.account,
        }).catch((e) => {
          const decoded = decodeRevert(e);
          throw cliError(decoded.code, 'Simulation reverted', decoded.hint);
        });
        emit({
          simulated: true,
          // TODO: include arg echoes
          gas: sim.request.gas?.toString() ?? null,
        });
        return 0;
      }

      if (this.idempotencyKey) await begin(this.idempotencyKey, COMMAND, args);

      let tx: `0x${string}`;
      try {
        const nonce = await nextNonce(clients.publicClient, clients.account.address);
        tx = await clients.walletClient.writeContract({
          address: c.address, abi: c.abi, functionName: 'TODO',
          args: [/* TODO */] as const,
          chain: clients.walletClient.chain, account: clients.account, nonce,
        });
      } catch (e) {
        const decoded = decodeRevert(e);
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, decoded.code);
        throw cliError(decoded.code, 'TODO tx failed to submit', decoded.hint);
      }

      // CRITICAL: markSubmitted before waitForReceipt — closes the
      // retry-resend window an agent could otherwise hit.
      if (this.idempotencyKey) await markSubmitted(this.idempotencyKey, COMMAND, args, tx);

      const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
      if (receipt.status === 'reverted') {
        // Pass tx hash so the cached failed entry retains it AND so peekIdempotent
        // refuses re-broadcast under the same key on retry.
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, 'TX_REVERTED', tx);
        throw cliError('TX_REVERTED', `TODO tx reverted: ${tx}`);
      }

      const result = {
        txHash: tx,
        // TODO: include domain-relevant fields the user/agent will want
        block: receipt.blockNumber.toString(),
        basescanUrl: cfg.network === 'mainnet'
          ? `https://basescan.org/tx/${tx}`
          : `https://sepolia.basescan.org/tx/${tx}`,
      };
      if (this.idempotencyKey) await markConfirmed(this.idempotencyKey, COMMAND, args, result, tx);

      emit(result, [
        `✓ TODO action`,
        `  tx: ${result.basescanUrl}`,
        `  block: ${receipt.blockNumber}`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}
