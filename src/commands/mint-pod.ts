/**
 * `reppo mint-pod` — mint a pod NFT. Network-dependent params:
 *
 *   - mainnet: `mintPod(to, emissionSharePercent)` — pays `publishingFee()`
 *     in REPPO. Required: `--share <0-100>`.
 *   - testnet: `mintPodWithREPPO(to, datanetId)` (default) or
 *     `mintPodWithPrimaryToken(to, datanetId)` (alt fee asset). The
 *     testnet contracts are a fork of mainnet with subnet/datanet logic
 *     added for a client experiment — the methods are the same, only the
 *     parameters differ. Required: `--datanet <id>`.
 *
 * Pre-flight (mainnet):
 *   - MISSING_SHARE / INVALID_SHARE
 *   - INVALID_ADDRESS (--to)
 *   - INSUFFICIENT_REPPO_BALANCE (publishingFee)
 *   - INSUFFICIENT_ALLOWANCE     (caller → PodManager for publishingFee)
 *
 * Pre-flight (testnet):
 *   - MISSING_DATANET / INVALID_DATANET_ID
 *   - INVALID_TOKEN (--token must be "reppo" or "primary")
 *   - INVALID_ADDRESS (--to)
 *   - DATANET_NOT_FOUND
 *
 * Two-phase write protocol via peekIdempotent.
 */
import { Option } from 'clipanion';
import { formatUnits, isAddress, type Address } from 'viem';
import { BaseCommand } from './_base.js';
import { cliError, emit } from '../output/format.js';
import { createClients, nextNonce } from '../chain/clients.js';
import { podManager, subnetManager, reppoToken } from '../chain/contracts.js';
import { decodeRevert } from '../chain/errors.js';
import { begin, markSubmitted, markConfirmed, markFailed, peekIdempotent } from '../state/idempotency.js';

const COMMAND = 'mint-pod';

export class MintPodCommand extends BaseCommand {
  static override paths = [['mint-pod']];

  static override usage = BaseCommand.Usage({
    description: 'Mint a pod NFT. Required params depend on network: --share on mainnet, --datanet on testnet.',
    examples: [
      ['Mint a pod on mainnet with 50% emission share',
        'reppo mint-pod --share 50 --network mainnet'],
      ['Mint a pod into testnet datanet 19, paid in REPPO',
        'reppo mint-pod --datanet 19 --network testnet'],
      ['Pay testnet mint with the datanet primary token instead',
        'reppo mint-pod --datanet 19 --token primary --network testnet'],
      ['Mint to a different address',
        'reppo mint-pod --share 50 --to 0x726c…E31d --network mainnet'],
    ],
  });

  share = Option.String('--share', { description: 'Mainnet only: emission share percent (0-100)' });
  datanet = Option.String('--datanet', { description: 'Testnet only: datanet (subnet) id to mint into' });
  token = Option.String('--token', 'reppo', { description: 'Testnet only: fee asset — "reppo" (default) or "primary"' });
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

      return cfg.network === 'mainnet'
        ? await this.mintMainnet(clients, target, cfg.network)
        : await this.mintTestnet(clients, target, cfg.network);
    } catch (err) {
      this.handleError(err);
    }
  }

  // ── Mainnet path: mintPod(to, share) — pays publishingFee in REPPO ─

  private async mintMainnet(
    clients: ReturnType<typeof createClients>,
    target: Address,
    network: 'mainnet',
  ): Promise<number> {
    if (this.share === undefined) {
      throw cliError(
        'MISSING_SHARE',
        '--share is required on mainnet.',
        'Pass --share <0-100> to set the pod\'s emission share percent.',
      );
    }
    const shareNum = Number(this.share);
    if (!Number.isInteger(shareNum) || shareNum < 0 || shareNum > 100) {
      throw cliError(
        'INVALID_SHARE',
        `--share must be an integer 0-100; got "${this.share}".`,
      );
    }
    const share = shareNum;

    const args = { share: share.toString(), to: target.toLowerCase() };

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

    const pm = podManager(network);
    const reppo = reppoToken(network);

    // Pre-flight: fee + balance + allowance, parallel.
    const [fee, balance, allowance] = await Promise.all([
      clients.publicClient.readContract({
        address: pm.address, abi: pm.abi, functionName: 'publishingFee', args: [],
      }),
      clients.publicClient.readContract({
        address: reppo.address, abi: reppo.abi, functionName: 'balanceOf', args: [clients.account.address],
      }),
      clients.publicClient.readContract({
        address: reppo.address, abi: reppo.abi, functionName: 'allowance', args: [clients.account.address, pm.address],
      }),
    ]);

    if (balance < fee) {
      throw cliError(
        'INSUFFICIENT_REPPO_BALANCE',
        `Caller has ${formatUnits(balance, 18)} REPPO but the publishing fee is ${formatUnits(fee, 18)} REPPO.`,
        'Acquire more REPPO before minting.',
      );
    }

    if (allowance < fee) {
      throw cliError(
        'INSUFFICIENT_ALLOWANCE',
        `REPPO allowance from ${clients.account.address} to PodManager is ${formatUnits(allowance, 18)}, ` +
        `below the publishing fee of ${formatUnits(fee, 18)} REPPO.`,
        `Approve PodManager (${pm.address}) for at least ${formatUnits(fee, 18)} REPPO. ` +
        `Auto-approval lands in v0.2; for the alpha, send the approve() tx manually.`,
      );
    }

    if (this.dryRun) {
      const sim = await clients.publicClient.simulateContract({
        address: pm.address, abi: pm.abi, functionName: 'mintPod',
        args: [target, share], account: clients.account,
      }).catch((e) => {
        const decoded = decodeRevert(e);
        throw cliError(decoded.code, 'Simulation reverted', decoded.hint);
      });
      emit({
        simulated: true,
        share,
        to: target,
        feeREPPO: { raw: fee.toString(), formatted: formatUnits(fee, 18) },
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
        address: pm.address, abi: pm.abi, functionName: 'mintPod',
        args: [target, share],
        chain: clients.walletClient.chain, account: clients.account, nonce,
      });
    } catch (e) {
      const decoded = decodeRevert(e);
      if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, decoded.code);
      throw cliError(decoded.code, 'mint-pod tx failed to submit', decoded.hint);
    }

    if (this.idempotencyKey) await markSubmitted(this.idempotencyKey, COMMAND, args, tx);

    const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
    if (receipt.status === 'reverted') {
      if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, 'TX_REVERTED', tx);
      throw cliError('TX_REVERTED', `mint-pod tx reverted: ${tx}`);
    }

    const result = {
      txHash: tx,
      share,
      to: target,
      feeREPPO: { raw: fee.toString(), formatted: formatUnits(fee, 18) },
      block: receipt.blockNumber.toString(),
      basescanUrl: `https://basescan.org/tx/${tx}`,
    };
    if (this.idempotencyKey) await markConfirmed(this.idempotencyKey, COMMAND, args, result, tx);

    emit(result, [
      `✓ Minted pod (mainnet) with ${share}% emission share`,
      `  to: ${target}`,
      `  fee paid: ${formatUnits(fee, 18)} REPPO`,
      `  tx: ${result.basescanUrl}`,
      `  block: ${receipt.blockNumber}`,
      `  (new podId: check the explorer or run \`reppo query pod <id>\` to verify)`,
    ]);
    return 0;
  }

  // ── Testnet path: mintPodWithREPPO / mintPodWithPrimaryToken(to, datanetId) ─

  private async mintTestnet(
    clients: ReturnType<typeof createClients>,
    target: Address,
    network: 'testnet',
  ): Promise<number> {
    if (this.datanet === undefined) {
      throw cliError(
        'MISSING_DATANET',
        '--datanet is required on testnet.',
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

    const pm = podManager(network);
    const sm = subnetManager(network);

    // Pre-flight: validate the datanet exists.
    const valid = await clients.publicClient.readContract({
      address: sm.address, abi: sm.abi, functionName: 'validSubnet', args: [datanetId],
    });
    if (!valid) {
      throw cliError(
        'DATANET_NOT_FOUND',
        `Datanet ${datanetId} does not exist on ${network}.`,
        `Verify the id; check \`reppo query datanet ${datanetId}\` before minting.`,
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
      basescanUrl: `https://sepolia.basescan.org/tx/${tx}`,
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
  }
}
