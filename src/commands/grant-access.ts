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
 *   6. feeToken allowance(caller→sm): a short allowance is AUTO-APPROVED
 *      (unlimited approve() + wait) before the access call — no longer a hard error.
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
import { ensureAllowance } from '../chain/allowance.js';
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
        // Reuse `clients` (already built above); recompute feePaid/gasEth from the
        // receipt so a reconciled-confirmed result has the same keys as a
        // fresh-confirmed one. feeToken {address,decimals} survives on the cached
        // submitted record (markSubmitted stored feeFields).
        const ftMeta = decision.result.feeToken as { address: Address; decimals: number } | undefined;
        return handleSubmittedCacheDecision(decision, {
          idempotencyKey: this.idempotencyKey,
          command: COMMAND,
          args,
          network: cfg.network,
          publicClient: clients.publicClient,
          buildResult: (receipt) => {
            const base: Record<string, unknown> = {
              datanetId: datanetId.toString(),
              to: target,
              token: this.token,
              gasEth: receiptGasEth(receipt),
            };
            if (ftMeta) {
              const feePaid = tokenFeeFromReceipt(receipt, ftMeta.address, clients.account.address, ftMeta.decimals);
              base.feePaid = feePaid;
              if (this.token === 'reppo') base.reppoFee = feePaid;
            }
            return base;
          },
        });
      }

      const sm = subnetManager(cfg.network);

      // Validate the datanet BEFORE resolving the fee token. A nonexistent
      // datanet must surface DATANET_NOT_FOUND — not DATANET_HAS_NO_PRIMARY_TOKEN
      // (getSubnetPrimaryToken returns address(0) for a missing subnet too, which
      // would otherwise mis-report the cause on the `--token primary` path).
      const valid = await clients.publicClient.readContract({
        address: sm.address, abi: sm.abi, functionName: 'validSubnet', args: [datanetId],
      });
      if (!valid) {
        throw cliError('DATANET_NOT_FOUND', `Datanet ${datanetId} does not exist on ${cfg.network}.`,
          `Verify the id; check \`reppo query datanet ${datanetId}\` before granting access.`);
      }

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
        let primaryAddr: Address;
        try {
          primaryAddr = await clients.publicClient.readContract({
            address: sm.address, abi: sm.abi, functionName: 'getSubnetPrimaryToken', args: [datanetId],
          });
        } catch {
          throw cliError('DATANET_HAS_NO_PRIMARY_TOKEN',
            `Could not resolve a primary token for datanet ${datanetId} on ${cfg.network}.`,
            'This datanet likely charges access in REPPO only — retry without `--token primary`.');
        }
        // getSubnetPrimaryToken returns address(0) for REPPO-only datanets.
        if (BigInt(primaryAddr) === 0n) {
          throw cliError('DATANET_HAS_NO_PRIMARY_TOKEN',
            `Datanet ${datanetId} has no primary token configured.`,
            'This datanet charges access in REPPO only — retry without `--token primary`.');
        }
        feeTokenAddress = primaryAddr;
        const ft = erc20(feeTokenAddress);
        // decimals has no safe default — a wrong value corrupts every amount —
        // so a read failure is a hard error, not a guess. Wrap it like symbol()
        // below so a raw viem decode error doesn't surface as INTERNAL_ERROR.
        feeTokenDecimals = await clients.publicClient
          .readContract({ ...ft, functionName: 'decimals' })
          .then((dec) => Number(dec))
          .catch(() => {
            throw cliError('INVALID_PRIMARY_TOKEN',
              `Could not read decimals() for datanet ${datanetId} primary token ${feeTokenAddress}.`,
              'The primary token is not a standard ERC20 (decimals() reverted or returned non-numeric data).');
          });
        // symbol is cosmetic — best-effort: some tokens return bytes32, which would
        // fail to decode against the `string` ABI and abort the whole command.
        feeTokenSymbol = await clients.publicClient
          .readContract({ ...ft, functionName: 'symbol' })
          .catch(() => `${feeTokenAddress.slice(0, 6)}…${feeTokenAddress.slice(-4)}`);
      }
      const feeToken = erc20(feeTokenAddress);

      // Pre-flight in parallel where independent (validSubnet already checked above).
      const [alreadyHasAccess, fee, balance, allowance] = await Promise.all([
        clients.publicClient.readContract({ address: sm.address, abi: sm.abi, functionName: 'hasSubnetAccess', args: [datanetId, target] }),
        clients.publicClient.readContract({ address: sm.address, abi: sm.abi, functionName: fns.feeGetter, args: [datanetId] }),
        clients.publicClient.readContract({ ...feeToken, functionName: 'balanceOf', args: [clients.account.address] }),
        clients.publicClient.readContract({ ...feeToken, functionName: 'allowance', args: [clients.account.address, sm.address] }),
      ]);

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
      // Auto-approval: a short allowance no longer hard-fails. The real-write path
      // (below) sends an unlimited approve() to SubnetManager for the fee token before
      // the access call; dry-run only reports it (the access sim would revert).
      const needsApproval = allowance < fee;

      const feeFields = {
        feeToken: { symbol: feeTokenSymbol, address: feeTokenAddress, decimals: feeTokenDecimals },
        feeAmount: { raw: fee.toString(), formatted: formatUnits(fee, feeTokenDecimals) },
        // Legacy REPPO field for back-compat with existing consumers; only set on the REPPO path.
        ...(this.token === 'reppo'
          ? { feeREPPO: { raw: fee.toString(), formatted: formatUnits(fee, 18) } }
          : {}),
      };

      if (this.dryRun) {
        if (needsApproval) {
          // Can't simulate the access call without allowance (it would revert). Report
          // the approve that the real run would send first.
          emit({
            simulated: true,
            wouldAutoApprove: { token: feeTokenAddress, spender: sm.address, currentAllowance: formatUnits(allowance, feeTokenDecimals) },
            datanetId: datanetId.toString(),
            to: target,
            token: this.token,
            ...feeFields,
          }, [
            `(dry-run) would auto-approve SubnetManager for ${feeTokenSymbol}, then grant ${target} access to datanet ${datanetId}`,
          ]);
          return 0;
        }
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

      // Auto-approve SubnetManager to pull the fee token before the access call (no-op
      // when already approved). Outside the idempotency two-phase: approve() is
      // self-idempotent via the allowance read, and waiting advances the nonce.
      const approval = await ensureAllowance(clients, feeTokenAddress, sm.address, fee, allowance);

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

      const feePaid = tokenFeeFromReceipt(receipt, feeTokenAddress, clients.account.address, feeTokenDecimals);
      const result = {
        txHash: tx,
        gasEth: receiptGasEth(receipt),
        ...(approval.approved ? { autoApproveTx: approval.approveTx } : {}),
        feePaid,
        // Legacy top-level field for back-compat with pre-0.8.5 consumers that
        // read `reppoFee`; only meaningful on the REPPO path.
        ...(this.token === 'reppo' ? { reppoFee: feePaid } : {}),
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

      // Show the on-chain fee quote (always correct); feePaid in JSON is the
      // receipt-derived actual, which can read 0 for non-standard transfer flows.
      emit(result, [
        ...(approval.approved ? [`✓ Auto-approved SubnetManager for ${feeTokenSymbol} (tx: ${approval.approveTx})`] : []),
        `✓ Granted ${target} access to datanet ${datanetId}`,
        `  fee: ${result.feeAmount.formatted} ${feeTokenSymbol}`,
        `  tx: ${result.basescanUrl}`,
        `  block: ${receipt.blockNumber}`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}
