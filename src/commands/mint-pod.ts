/**
 * `reppo mint-pod --datanet <id> [--token reppo|primary] [--to <addr>]` —
 * mint a pod NFT into a datanet on testnet (V2 PodManager).
 *
 * V1/V2 ABI split:
 *   - mainnet: PodManager exposes `mintPod(to, emissionSharePercent)` (V1).
 *     Different signature; flagged as NETWORK_NOT_SUPPORTED for now.
 *     Tracked separately — the alpha targets the V2 datanet flow.
 *   - testnet: `mintPodWithREPPO(to, subnetId)` (V2, default) or
 *     `mintPodWithPrimaryToken(to, subnetId)` (V2, alt fee asset).
 *
 * Pre-flight:
 *   - INVALID_DATANET_ID, INVALID_ADDRESS (--to)
 *   - NETWORK_NOT_SUPPORTED (mainnet — V1 mint-pod requires --share, separate cmd)
 *   - INVALID_TOKEN (--token must be "reppo" or "primary")
 *   - DATANET_NOT_FOUND (validSubnet returned false)
 *
 * Note: this command does NOT decode the new podId from the receipt
 * (PodManager has a Transfer event in V1 mainnet ABI but not in our
 * minimal testnet ABI). Result emits a hint to run `reppo query pod`
 * with the predicted id, or check the explorer.
 */
import { Option } from 'clipanion';
import { isAddress, type Address } from 'viem';
import { BaseCommand } from './_base.js';
import { cliError, emit } from '../output/format.js';
import { createClients, nextNonce } from '../chain/clients.js';
import { podManager, subnetManager } from '../chain/contracts.js';
import { decodeRevert } from '../chain/errors.js';
import { begin, markSubmitted, markConfirmed, markFailed, peekIdempotent } from '../state/idempotency.js';

const COMMAND = 'mint-pod';

export class MintPodCommand extends BaseCommand {
  static override paths = [['mint-pod']];

  static override usage = BaseCommand.Usage({
    description: 'Mint a pod NFT into a datanet (testnet only in alpha).',
    examples: [
      ['Mint a pod into datanet 19, paid in REPPO',
        'reppo mint-pod --datanet 19 --network testnet'],
      ['Pay with the datanet primary token instead',
        'reppo mint-pod --datanet 19 --token primary --network testnet'],
      ['Mint to a different address',
        'reppo mint-pod --datanet 19 --to 0x726c…E31d --network testnet'],
    ],
  });

  datanet = Option.String('--datanet', { required: true });
  token = Option.String('--token', 'reppo', { description: 'Fee asset: "reppo" (default) or "primary" (datanet primary token)' });
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

      if (cfg.network === 'mainnet') {
        throw cliError(
          'NETWORK_NOT_SUPPORTED',
          'mint-pod on mainnet uses the V1 PodManager (mintPod with --share), which is not yet wired in this alpha.',
          'Use --network testnet for now, or wait for the V1-mainnet variant of this command.',
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
        emit({ ...decision.result, idempotent: true, status: 'submitted' },
          [`(cached, submitted but not confirmed yet) tx: ${decision.txHash ?? 'n/a'}`,
           `Re-run after the tx confirms, or check the explorer.`]);
        return 0;
      }

      const pm = podManager(cfg.network);
      const sm = subnetManager(cfg.network);

      // Pre-flight: validate the datanet exists.
      const valid = await clients.publicClient.readContract({
        address: sm.address, abi: sm.abi, functionName: 'validSubnet', args: [datanetId],
      });
      if (!valid) {
        throw cliError(
          'DATANET_NOT_FOUND',
          `Datanet ${datanetId} does not exist on ${cfg.network}.`,
          `Verify the id; check \`reppo query datanet ${datanetId}\` (or \`query subnet ${datanetId}\`) before minting.`,
        );
      }

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

      // markSubmitted BEFORE waitForReceipt — closes the retry-resend window.
      if (this.idempotencyKey) await markSubmitted(this.idempotencyKey, COMMAND, args, tx);

      const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
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
        basescanUrl: `https://sepolia.basescan.org/tx/${tx}`, // testnet only after the mainnet early-return
        // podId not decoded — Transfer event isn't in the V2 testnet ABI fragments.
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
