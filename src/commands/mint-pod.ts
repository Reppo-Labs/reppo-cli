/**
 * `reppo mint-pod` — mint a pod NFT into a datanet on PodManager V2.
 *
 * V2 unified both networks behind the same call shape:
 *   - `mintPodWithREPPO(to, subnetId)`          (default, `--token reppo`)
 *   - `mintPodWithPrimaryToken(to, subnetId)`   (`--token primary`)
 *
 * The pre-V2 mainnet path `mintPod(to, emissionSharePercent)` and the
 * `publishingFee()` getter are gone — fee logic moved to SubnetManager.
 * Fee/balance/allowance pre-flight is intentionally skipped here: the
 * contract reverts with structured errors (decoded via decodeRevert)
 * if balance/allowance/fee constraints are violated, and any client-
 * side estimate is duplicate logic that drifts.
 *
 * Pre-flight (both networks):
 *   - MISSING_DATANET / INVALID_DATANET_ID
 *   - INVALID_TOKEN (--token must be "reppo" or "primary")
 *   - INVALID_ADDRESS (--to)
 *   - DATANET_NOT_FOUND
 *
 * Two-phase write protocol via peekIdempotent.
 */
import { Option } from 'clipanion';
import { isAddress, type Address } from 'viem';
import { BaseCommand } from './_base.js';
import { cliError, emit } from '../output/format.js';
import { createClients, nextNonce } from '../chain/clients.js';
import { podManager, subnetManager } from '../chain/contracts.js';
import { decodeRevert } from '../chain/errors.js';
import { handleSubmittedCacheDecision } from './write-cache.js';
import { waitForWriteReceipt } from '../chain/receipt.js';
import { begin, markSubmitted, markConfirmed, markFailed, peekIdempotent } from '../state/idempotency.js';

const COMMAND = 'mint-pod';

export class MintPodCommand extends BaseCommand {
  static override paths = [['mint-pod']];

  static override usage = BaseCommand.Usage({
    description: 'Mint a pod NFT into a datanet. Required: --datanet <id>. Optional: --token reppo|primary, --to <addr>.',
    examples: [
      ['Mint a pod into datanet 19, paid in REPPO',
        'reppo mint-pod --datanet 19'],
      ['Mint into testnet datanet 19',
        'reppo mint-pod --datanet 19 --network testnet'],
      ['Pay the mint with the datanet primary token instead',
        'reppo mint-pod --datanet 19 --token primary'],
      ['Mint to a different address',
        'reppo mint-pod --datanet 19 --to 0x726c…E31d'],
    ],
  });

  datanet = Option.String('--datanet', { description: 'Datanet (subnet) id to mint into' });
  token = Option.String('--token', 'reppo', { description: 'Fee asset — "reppo" (default) or "primary"' });
  to = Option.String('--to', { description: 'Address to mint the pod to (defaults to caller)' });
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

      if (this.datanet === undefined) {
        throw cliError(
          'MISSING_DATANET',
          '--datanet is required.',
          'Pass --datanet <id> to choose which datanet to mint into.',
        );
      }
      let datanetId: bigint;
      try {
        datanetId = BigInt(this.datanet);
      } catch {
        throw cliError('INVALID_DATANET_ID', `Datanet id must be a non-negative integer; got "${this.datanet}".`);
      }

      if (this.token !== 'reppo' && this.token !== 'primary') {
        throw cliError(
          'INVALID_TOKEN',
          `--token must be "reppo" or "primary"; got "${this.token}".`,
        );
      }
      const functionName = this.token === 'reppo' ? 'mintPodWithREPPO' : 'mintPodWithPrimaryToken';

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

      const args = { datanetId: datanetId.toString(), token: this.token, to: target.toLowerCase() };

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
          buildResult: () => ({ datanetId: datanetId.toString(), token: this.token, to: target }),
        });
      }

      const pm = podManager(cfg.network);
      const sm = subnetManager(cfg.network);

      // Pre-flight: validate the datanet exists. The contract would
      // revert with InvalidSubnet otherwise; failing fast here gives a
      // cleaner error.
      const valid = await clients.publicClient.readContract({
        address: sm.address, abi: sm.abi, functionName: 'validSubnet', args: [datanetId],
      });
      if (!valid) {
        throw cliError(
          'DATANET_NOT_FOUND',
          `Datanet ${datanetId} does not exist on ${cfg.network}.`,
          `Verify the id; check \`reppo query datanet ${datanetId}\` before minting.`,
        );
      }

      const basescanUrlFor = (tx: `0x${string}`) =>
        cfg.network === 'mainnet'
          ? `https://basescan.org/tx/${tx}`
          : `https://sepolia.basescan.org/tx/${tx}`;

      if (this.dryRun) {
        const sim = await clients.publicClient.simulateContract({
          address: pm.address, abi: pm.abi, functionName,
          args: [target, datanetId], account: clients.account,
        }).catch((e) => {
          const decoded = decodeRevert(e);
          throw cliError(decoded.code, 'Simulation reverted', decoded.hint);
        });
        emit({
          simulated: true,
          datanetId: datanetId.toString(),
          token: this.token,
          to: target,
          predictedPodId: sim.result.toString(),
          gas: sim.request.gas?.toString() ?? null,
        });
        return 0;
      }

      if (this.idempotencyKey) await begin(this.idempotencyKey, COMMAND, args);

      let tx: `0x${string}`;
      try {
        const nonce = await nextNonce(clients.publicClient, clients.account.address);
        tx = await clients.walletClient.writeContract({
          address: pm.address, abi: pm.abi, functionName,
          args: [target, datanetId],
          chain: clients.walletClient.chain, account: clients.account, nonce,
        });
      } catch (e) {
        const decoded = decodeRevert(e);
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, decoded.code);
        throw cliError(decoded.code, 'mint-pod tx failed to submit', decoded.hint);
      }

      if (this.idempotencyKey) {
        await markSubmitted(this.idempotencyKey, COMMAND, args, tx, {
          datanetId: datanetId.toString(),
          token: this.token,
          to: target,
        });
      }

      const receipt = await waitForWriteReceipt(clients.publicClient, tx);
      if (receipt.status === 'reverted') {
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, 'TX_REVERTED', tx);
        throw cliError('TX_REVERTED', `mint-pod tx reverted: ${tx}`);
      }

      const result = {
        txHash: tx,
        datanetId: datanetId.toString(),
        token: this.token,
        to: target,
        block: receipt.blockNumber.toString(),
        basescanUrl: basescanUrlFor(tx),
      };
      if (this.idempotencyKey) await markConfirmed(this.idempotencyKey, COMMAND, args, result, tx);

      emit(result, [
        `✓ Minted pod into datanet ${datanetId} (paid in ${this.token})`,
        `  to: ${target}`,
        `  tx: ${result.basescanUrl}`,
        `  block: ${receipt.blockNumber}`,
        `  (new podId: check the explorer or run \`reppo query pod <id>\` to verify)`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}
