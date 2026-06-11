/**
 * `reppo grant-access --datanet <id> [--to <addr>]` — pay the REPPO
 * access fee and grant `--to` access to the datanet. Defaults `--to`
 * to the address derived from REPPO_PRIVATE_KEY.
 *
 * "Datanet" is the user-facing term; on-chain it's a "subnet" (the
 * function is `accessSubnetWithREPPOFee` and we read `validSubnet` /
 * `hasSubnetAccess` / `getAccessFeeREPPO`). The CLI surface translates.
 *
 * Pre-flight checks (all surface error codes BEFORE the cache write,
 * so retries under the same --idempotency-key are safe):
 *   1. validSubnet(datanetId)         → DATANET_NOT_FOUND
 *   2. hasSubnetAccess(datanetId, to) → ACCESS_ALREADY_GRANTED (cheap savings)
 *   3. getAccessFeeREPPO(datanetId)   → fee amount (also surfaced in the result)
 *   4. REPPO balance >= fee           → INSUFFICIENT_REPPO_BALANCE
 *   5. REPPO allowance(caller→sm) ≥   → INSUFFICIENT_ALLOWANCE (matches the
 *      fee                             0xfb8f41b2 selector errors.ts decodes)
 *
 * Idempotency two-phase write protocol:
 *   begin → submit tx → markSubmitted → wait receipt → markConfirmed
 *
 * Args fingerprint: { datanetId, to } — re-using one --idempotency-key
 * for a different (datanetId, to) is rejected with IDEMPOTENCY_ARGS_MISMATCH.
 */
import { Option } from 'clipanion';
import { formatUnits, isAddress, type Address } from 'viem';
import { BaseCommand } from './_base.js';
import { cliError, emit } from '../output/format.js';
import { createClients, nextNonce } from '../chain/clients.js';
import { subnetManager, reppoToken } from '../chain/contracts.js';
import { decodeRevert } from '../chain/errors.js';
import { handleSubmittedCacheDecision } from './write-cache.js';
import { waitForWriteReceipt, receiptGasEth, reppoFeeFromReceipt } from '../chain/receipt.js';
import { begin, markSubmitted, markConfirmed, markFailed, peekIdempotent } from '../state/idempotency.js';

const COMMAND = 'grant-access';

export class GrantAccessCommand extends BaseCommand {
  static override paths = [['grant-access']];

  static override usage = BaseCommand.Usage({
    description: 'Pay the REPPO access fee and grant a datanet access to an address.',
    examples: [
      ['Grant the wallet derived from REPPO_PRIVATE_KEY access to datanet 19',
        'reppo grant-access --datanet 19'],
      ['Grant a different address access',
        'reppo grant-access --datanet 19 --to 0x726c…E31d'],
      ['With idempotency key',
        'reppo grant-access --datanet 19 --idempotency-key grant-19-self'],
      ['Dry-run',
        'reppo grant-access --datanet 19 --dry-run'],
    ],
  });

  datanet = Option.String('--datanet', { required: true, description: 'Datanet (subnet) ID to grant access to' });
  to = Option.String('--to', { description: 'Address to grant access to (defaults to address derived from REPPO_PRIVATE_KEY)' });
  idempotencyKey = Option.String('--idempotency-key');
  dryRun = Option.Boolean('--dry-run', false);

  async execute(): Promise<number> {
    try {
      const cfg = this.loadConfig();
      const pk = cfg.privateKey;
      if (!pk) {
        throw cliError(
          'MISSING_PRIVATE_KEY',
          'No signing key available.',
          'Set REPPO_PRIVATE_KEY in env.',
        );
      }

      let datanetId: bigint;
      try {
        datanetId = BigInt(this.datanet);
      } catch {
        throw cliError('INVALID_DATANET_ID', `Datanet id must be a non-negative integer; got "${this.datanet}".`);
      }

      const clients = createClients({
        network: cfg.network,
        privateKey: pk,
        ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}),
      });

      const target: Address = this.to
        ? (isAddress(this.to)
            ? this.to
            : (() => { throw cliError('INVALID_ADDRESS', `Invalid --to address: ${this.to}`); })())
        : clients.account.address;

      const args = { datanetId: datanetId.toString(), to: target.toLowerCase() };

      const decision = await peekIdempotent<Record<string, unknown>>(
        this.idempotencyKey, COMMAND, args, this.dryRun,
      );
      if (decision.kind === 'return-confirmed') {
        emit({ ...decision.result, idempotent: true, status: 'confirmed' },
          [`(cached, confirmed) tx: ${decision.txHash ?? 'n/a'}`]);
        return 0;
      }
      if (decision.kind === 'return-submitted') {
        const clients = createClients({
          network: cfg.network,
          privateKey: pk,
          ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}),
        });
        return handleSubmittedCacheDecision(decision, {
          idempotencyKey: this.idempotencyKey,
          command: COMMAND,
          args,
          network: cfg.network,
          publicClient: clients.publicClient,
          buildResult: async () => {
            try {
              const smLocal = subnetManager(cfg.network);
              const fee = await clients.publicClient.readContract({
                address: smLocal.address, abi: smLocal.abi, functionName: 'getAccessFeeREPPO', args: [datanetId],
              });
              return {
                datanetId: datanetId.toString(),
                to: target,
                feeREPPO: { raw: fee.toString(), formatted: formatUnits(fee, 18) },
              };
            } catch {
              return { datanetId: datanetId.toString(), to: target };
            }
          },
        });
      }

      // Throwing variants — write commands must fail loud on TBD.
      const sm = subnetManager(cfg.network);
      const reppo = reppoToken(cfg.network);

      // Pre-flight in parallel where independent.
      const [valid, alreadyHasAccess, fee, balance, allowance] = await Promise.all([
        clients.publicClient.readContract({
          address: sm.address, abi: sm.abi, functionName: 'validSubnet', args: [datanetId],
        }),
        clients.publicClient.readContract({
          address: sm.address, abi: sm.abi, functionName: 'hasSubnetAccess', args: [datanetId, target],
        }),
        clients.publicClient.readContract({
          address: sm.address, abi: sm.abi, functionName: 'getAccessFeeREPPO', args: [datanetId],
        }),
        clients.publicClient.readContract({
          address: reppo.address, abi: reppo.abi, functionName: 'balanceOf', args: [clients.account.address],
        }),
        clients.publicClient.readContract({
          address: reppo.address, abi: reppo.abi, functionName: 'allowance', args: [clients.account.address, sm.address],
        }),
      ]);

      if (!valid) {
        throw cliError(
          'DATANET_NOT_FOUND',
          `Datanet ${datanetId} does not exist on ${cfg.network}.`,
          `Verify the id; check \`reppo query subnet ${datanetId}\` before granting access.`,
        );
      }

      if (alreadyHasAccess) {
        throw cliError(
          'ACCESS_ALREADY_GRANTED',
          `${target} already has access to datanet ${datanetId}.`,
          'Nothing to do — skip the call.',
        );
      }

      if (balance < fee) {
        throw cliError(
          'INSUFFICIENT_REPPO_BALANCE',
          `Caller has ${formatUnits(balance, 18)} REPPO but the fee is ${formatUnits(fee, 18)} REPPO.`,
          'Acquire more REPPO before granting access.',
        );
      }

      if (allowance < fee) {
        throw cliError(
          'INSUFFICIENT_ALLOWANCE',
          `REPPO allowance from ${clients.account.address} to SubnetManager is ${formatUnits(allowance, 18)}, ` +
          `below the fee of ${formatUnits(fee, 18)} REPPO.`,
          `Approve the SubnetManager (${sm.address}) for at least ${formatUnits(fee, 18)} REPPO. ` +
          `Auto-approval lands in v0.2; for the alpha, send the approve() tx manually (e.g. via cast).`,
        );
      }

      if (this.dryRun) {
        const sim = await clients.publicClient.simulateContract({
          address: sm.address, abi: sm.abi, functionName: 'accessSubnetWithREPPOFee',
          args: [datanetId, target], account: clients.account,
        }).catch((e) => {
          const decoded = decodeRevert(e);
          throw cliError(decoded.code, 'Simulation reverted', decoded.hint);
        });
        emit({
          simulated: true,
          datanetId: datanetId.toString(),
          to: target,
          feeREPPO: { raw: fee.toString(), formatted: formatUnits(fee, 18) },
          gas: sim.request.gas?.toString() ?? null,
        });
        return 0;
      }

      if (this.idempotencyKey) await begin(this.idempotencyKey, COMMAND, args);

      let tx: `0x${string}`;
      try {
        const nonce = await nextNonce(clients.publicClient, clients.account.address);
        tx = await clients.walletClient.writeContract({
          address: sm.address, abi: sm.abi, functionName: 'accessSubnetWithREPPOFee',
          args: [datanetId, target],
          chain: clients.walletClient.chain, account: clients.account, nonce,
        });
      } catch (e) {
        const decoded = decodeRevert(e);
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, decoded.code);
        throw cliError(decoded.code, 'grant-access tx failed to submit', decoded.hint);
      }

      // markSubmitted BEFORE waitForReceipt — closes the retry-resend window.
      if (this.idempotencyKey) {
        await markSubmitted(this.idempotencyKey, COMMAND, args, tx, {
          datanetId: datanetId.toString(),
          to: target,
          feeREPPO: { raw: fee.toString(), formatted: formatUnits(fee, 18) },
        });
      }

      const receipt = await waitForWriteReceipt(clients.publicClient, tx);
      if (receipt.status === 'reverted') {
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, 'TX_REVERTED', tx);
        throw cliError('TX_REVERTED', `grant-access tx reverted: ${tx}`);
      }

      const result = {
        txHash: tx,
        gasEth: receiptGasEth(receipt),
        reppoFee: reppoFeeFromReceipt(receipt, reppoToken(cfg.network).address, clients.account.address),
        datanetId: datanetId.toString(),
        to: target,
        feeREPPO: { raw: fee.toString(), formatted: formatUnits(fee, 18) },
        block: receipt.blockNumber.toString(),
        basescanUrl: cfg.network === 'mainnet'
          ? `https://basescan.org/tx/${tx}`
          : `https://sepolia.basescan.org/tx/${tx}`,
      };
      if (this.idempotencyKey) await markConfirmed(this.idempotencyKey, COMMAND, args, result, tx);

      emit(result, [
        `✓ Granted ${target} access to datanet ${datanetId}`,
        `  fee paid: ${formatUnits(fee, 18)} REPPO`,
        `  tx: ${result.basescanUrl}`,
        `  block: ${receipt.blockNumber}`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}
