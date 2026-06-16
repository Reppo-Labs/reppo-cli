/**
 * `reppo grant-access --datanet <id> [--to <addr>] [--token reppo|primary]` —
 * pay the datanet access fee and grant `--to` access. Paid in REPPO by default,
 * or in the datanet's primary token with `--token primary` (mirrors
 * `mint-pod --token`). Defaults `--to` to the address from REPPO_PRIVATE_KEY.
 *
 * On-chain the concept is a "subnet". For REPPO we call
 * `accessSubnetWithREPPOFee` + `getAccessFeeREPPO`; for the primary token,
 * `accessSubnetWithPrimaryTokenFee` + `getAccessFeePrimaryToken`, with the token
 * address resolved via `getSubnetPrimaryToken` and its `decimals()` read on-chain
 * (never assumed 18).
 *
 * Pre-flight (all surface error codes BEFORE the cache write):
 *   1. INVALID_TOKEN                    (--token not reppo|primary)
 *   2. validSubnet(datanetId)           → DATANET_NOT_FOUND
 *   3. hasSubnetAccess(datanetId, to)   → ACCESS_ALREADY_GRANTED
 *   4. fee getter                       → fee amount (in the fee token)
 *   5. feeToken balance >= fee          → INSUFFICIENT_REPPO_BALANCE / INSUFFICIENT_TOKEN_BALANCE
 *   6. feeToken allowance(caller→sm) ≥  → INSUFFICIENT_ALLOWANCE
 *
 * Idempotency: begin → submit → markSubmitted → wait → markConfirmed.
 * Args fingerprint: { datanetId, to, token }.
 */
import { Option } from 'clipanion';
import { formatUnits, isAddress, type Address } from 'viem';
import { BaseCommand } from './_base.js';
import { cliError, emit } from '../output/format.js';
import { createClients, nextNonce } from '../chain/clients.js';
import { subnetManager, reppoToken, erc20 } from '../chain/contracts.js';
import { decodeRevert } from '../chain/errors.js';
import { handleSubmittedCacheDecision } from './write-cache.js';
import { waitForWriteReceipt, receiptGasEth, tokenFeeFromReceipt } from '../chain/receipt.js';
import { begin, markSubmitted, markConfirmed, markFailed, peekIdempotent } from '../state/idempotency.js';

const COMMAND = 'grant-access';

/** Maps the --token choice to the SubnetManager access method + fee getter. */
export function accessFns(token: 'reppo' | 'primary'): {
  access: 'accessSubnetWithREPPOFee' | 'accessSubnetWithPrimaryTokenFee';
  feeGetter: 'getAccessFeeREPPO' | 'getAccessFeePrimaryToken';
} {
  return token === 'reppo'
    ? { access: 'accessSubnetWithREPPOFee', feeGetter: 'getAccessFeeREPPO' }
    : { access: 'accessSubnetWithPrimaryTokenFee', feeGetter: 'getAccessFeePrimaryToken' };
}

export class GrantAccessCommand extends BaseCommand {
  static override paths = [['grant-access']];

  static override usage = BaseCommand.Usage({
    description: 'Pay the datanet access fee (REPPO or the datanet primary token) and grant an address access.',
    examples: [
      ['Grant the wallet derived from REPPO_PRIVATE_KEY access to datanet 19 (paid in REPPO)',
        'reppo grant-access --datanet 19'],
      ['Pay the access fee in the datanet primary token instead',
        'reppo grant-access --datanet 19 --token primary'],
      ['Grant a different address access',
        'reppo grant-access --datanet 19 --to 0x726c…E31d'],
      ['With idempotency key',
        'reppo grant-access --datanet 19 --idempotency-key grant-19-self'],
      ['Dry-run',
        'reppo grant-access --datanet 19 --dry-run'],
    ],
  });

  datanet = Option.String('--datanet', { required: true, description: 'Datanet (subnet) ID to grant access to' });
  token = Option.String('--token', 'reppo', { description: 'Fee asset — "reppo" (default) or "primary"' });
  to = Option.String('--to', { description: 'Address to grant access to (defaults to address derived from REPPO_PRIVATE_KEY)' });
  idempotencyKey = Option.String('--idempotency-key');
  dryRun = Option.Boolean('--dry-run', false);

  async execute(): Promise<number> {
    try {
      const cfg = this.loadConfig();
      const pk = cfg.privateKey;
      if (!pk) {
        throw cliError('MISSING_PRIVATE_KEY', 'No signing key available.', 'Set REPPO_PRIVATE_KEY in env.');
      }

      let datanetId: bigint;
      try {
        datanetId = BigInt(this.datanet);
      } catch {
        throw cliError('INVALID_DATANET_ID', `Datanet id must be a non-negative integer; got "${this.datanet}".`);
      }

      if (this.token !== 'reppo' && this.token !== 'primary') {
        throw cliError('INVALID_TOKEN', `--token must be "reppo" or "primary"; got "${this.token}".`);
      }
      const fns = accessFns(this.token);

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

      const args = { datanetId: datanetId.toString(), to: target.toLowerCase(), token: this.token };

      const decision = await peekIdempotent<Record<string, unknown>>(
        this.idempotencyKey, COMMAND, args, this.dryRun,
      );
      if (decision.kind === 'return-confirmed') {
        emit({ ...decision.result, idempotent: true, status: 'confirmed' },
          [`(cached, confirmed) tx: ${decision.txHash ?? 'n/a'}`]);
        return 0;
      }
      if (decision.kind === 'return-submitted') {
        const clients2 = createClients({
          network: cfg.network,
          privateKey: pk,
          ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}),
        });
        return handleSubmittedCacheDecision(decision, {
          idempotencyKey: this.idempotencyKey,
          command: COMMAND,
          args,
          network: cfg.network,
          publicClient: clients2.publicClient,
          buildResult: async () => ({ datanetId: datanetId.toString(), to: target, token: this.token }),
        });
      }

      const sm = subnetManager(cfg.network);

      // Resolve the fee token: REPPO (pinned) or the datanet's primary token
      // (discovered on-chain). decimals MUST be read for the primary token,
      // never assumed 18 — a non-18-decimal token would otherwise corrupt every
      // amount.
      let feeTokenAddress: Address;
      let feeTokenDecimals: number;
      let feeTokenSymbol: string;
      if (this.token === 'reppo') {
        feeTokenAddress = reppoToken(cfg.network).address;
        feeTokenDecimals = 18;
        feeTokenSymbol = 'REPPO';
      } else {
        feeTokenAddress = await clients.publicClient.readContract({
          address: sm.address, abi: sm.abi, functionName: 'getSubnetPrimaryToken', args: [datanetId],
        });
        const ft = erc20(feeTokenAddress);
        const [dec, sym] = await Promise.all([
          clients.publicClient.readContract({ ...ft, functionName: 'decimals' }),
          clients.publicClient.readContract({ ...ft, functionName: 'symbol' }),
        ]);
        feeTokenDecimals = Number(dec);
        feeTokenSymbol = sym;
      }
      const feeToken = erc20(feeTokenAddress);

      // Pre-flight in parallel where independent.
      const [valid, alreadyHasAccess, fee, balance, allowance] = await Promise.all([
        clients.publicClient.readContract({ address: sm.address, abi: sm.abi, functionName: 'validSubnet', args: [datanetId] }),
        clients.publicClient.readContract({ address: sm.address, abi: sm.abi, functionName: 'hasSubnetAccess', args: [datanetId, target] }),
        clients.publicClient.readContract({ address: sm.address, abi: sm.abi, functionName: fns.feeGetter, args: [datanetId] }),
        clients.publicClient.readContract({ ...feeToken, functionName: 'balanceOf', args: [clients.account.address] }),
        clients.publicClient.readContract({ ...feeToken, functionName: 'allowance', args: [clients.account.address, sm.address] }),
      ]);

      if (!valid) {
        throw cliError('DATANET_NOT_FOUND', `Datanet ${datanetId} does not exist on ${cfg.network}.`,
          `Verify the id; check \`reppo query datanet ${datanetId}\` before granting access.`);
      }
      if (alreadyHasAccess) {
        throw cliError('ACCESS_ALREADY_GRANTED', `${target} already has access to datanet ${datanetId}.`,
          'Nothing to do — skip the call.');
      }
      if (balance < fee) {
        throw cliError(
          this.token === 'reppo' ? 'INSUFFICIENT_REPPO_BALANCE' : 'INSUFFICIENT_TOKEN_BALANCE',
          `Caller has ${formatUnits(balance, feeTokenDecimals)} ${feeTokenSymbol} but the fee is ${formatUnits(fee, feeTokenDecimals)} ${feeTokenSymbol}.`,
          `Acquire more ${feeTokenSymbol} before granting access.`,
        );
      }
      if (allowance < fee) {
        throw cliError('INSUFFICIENT_ALLOWANCE',
          `${feeTokenSymbol} allowance from ${clients.account.address} to SubnetManager is ${formatUnits(allowance, feeTokenDecimals)}, ` +
          `below the fee of ${formatUnits(fee, feeTokenDecimals)} ${feeTokenSymbol}.`,
          `Approve the SubnetManager (${sm.address}) for at least ${formatUnits(fee, feeTokenDecimals)} ${feeTokenSymbol} ` +
          `(send the approve() tx manually, e.g. via cast).`);
      }

      const feeFields = {
        feeToken: { symbol: feeTokenSymbol, address: feeTokenAddress, decimals: feeTokenDecimals },
        feeAmount: { raw: fee.toString(), formatted: formatUnits(fee, feeTokenDecimals) },
        // Legacy REPPO field for back-compat with existing consumers; only set on the REPPO path.
        ...(this.token === 'reppo'
          ? { feeREPPO: { raw: fee.toString(), formatted: formatUnits(fee, 18) } }
          : {}),
      };

      if (this.dryRun) {
        const sim = await clients.publicClient.simulateContract({
          address: sm.address, abi: sm.abi, functionName: fns.access,
          args: [datanetId, target], account: clients.account,
        }).catch((e) => {
          const decoded = decodeRevert(e);
          throw cliError(decoded.code, 'Simulation reverted', decoded.hint);
        });
        emit({
          simulated: true,
          datanetId: datanetId.toString(),
          to: target,
          token: this.token,
          ...feeFields,
          gas: sim.request.gas?.toString() ?? null,
        });
        return 0;
      }

      if (this.idempotencyKey) await begin(this.idempotencyKey, COMMAND, args);

      let tx: `0x${string}`;
      try {
        const nonce = await nextNonce(clients.publicClient, clients.account.address);
        tx = await clients.walletClient.writeContract({
          address: sm.address, abi: sm.abi, functionName: fns.access,
          args: [datanetId, target],
          chain: clients.walletClient.chain, account: clients.account, nonce,
        });
      } catch (e) {
        const decoded = decodeRevert(e);
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, decoded.code);
        throw cliError(decoded.code, 'grant-access tx failed to submit', decoded.hint);
      }

      if (this.idempotencyKey) {
        await markSubmitted(this.idempotencyKey, COMMAND, args, tx, {
          datanetId: datanetId.toString(), to: target, token: this.token, ...feeFields,
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
        feePaid: tokenFeeFromReceipt(receipt, feeTokenAddress, clients.account.address, feeTokenDecimals),
        datanetId: datanetId.toString(),
        to: target,
        token: this.token,
        ...feeFields,
        block: receipt.blockNumber.toString(),
        basescanUrl: cfg.network === 'mainnet'
          ? `https://basescan.org/tx/${tx}`
          : `https://sepolia.basescan.org/tx/${tx}`,
      };
      if (this.idempotencyKey) await markConfirmed(this.idempotencyKey, COMMAND, args, result, tx);

      emit(result, [
        `✓ Granted ${target} access to datanet ${datanetId}`,
        `  fee paid: ${result.feePaid} ${feeTokenSymbol}`,
        `  tx: ${result.basescanUrl}`,
        `  block: ${receipt.blockNumber}`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}
