/**
 * `reppo approve --spender <alias|0x...> [--amount <units|max>] [--token reppo|usdc]`
 * — set an ERC20 allowance so subsequent write commands (lock, grant-access,
 * mint-pod) don't fail with INSUFFICIENT_ALLOWANCE.
 *
 * Most agent flows want unlimited approval once, so `--amount` defaults to
 * `max` (MaxUint256). Pass a numeric value (in human REPPO/USDC units) for a
 * bounded approval.
 *
 * Spender aliases resolve per network:
 *   - pod-manager     → PodManager      (mintPodWithREPPO, mintPodWithPrimaryToken)
 *   - subnet-manager  → SubnetManager   (grantAccess REPPO fee — pulled here)
 *   - ve-reppo        → veREPPO         (lock, extendLockup)
 *   - 0x…             → raw address     (validated with viem isAddress)
 *
 * Pre-flight: reads the current allowance and SHORT-CIRCUITS if it's already
 * ≥ the requested amount, emitting `{ status: 'no-op' }` with no tx. This
 * matches the idempotent re-runnability that agents expect.
 *
 * Two-phase write protocol identical to vote.ts; args fingerprint
 * (token, spender, amount) prevents same-key reuse with different intent.
 */
import { Option } from 'clipanion';
import { isAddress, parseUnits, formatUnits, maxUint256, type Address } from 'viem';
import { BaseCommand } from './_base.js';
import { cliError, emit } from '../output/format.js';
import { createClients, nextNonce } from '../chain/clients.js';
import {
  podManager,
  subnetManager,
  veReppo,
  reppoToken,
  usdcToken,
} from '../chain/contracts.js';
import { decodeRevert } from '../chain/errors.js';
import { receiptGasEth } from '../chain/receipt.js';
import {
  begin,
  markSubmitted,
  markConfirmed,
  markFailed,
  peekIdempotent,
} from '../state/idempotency.js';
import type { Network } from '../chain/addresses.js';

const COMMAND = 'approve';

type TokenName = 'reppo' | 'usdc';
type SpenderAlias = 'pod-manager' | 'subnet-manager' | 've-reppo';

const SPENDER_ALIASES: ReadonlySet<SpenderAlias> = new Set(['pod-manager', 'subnet-manager', 've-reppo']);
const TOKEN_NAMES: ReadonlySet<TokenName> = new Set(['reppo', 'usdc']);

function resolveSpender(spender: string, network: Network): Address {
  if (SPENDER_ALIASES.has(spender as SpenderAlias)) {
    switch (spender as SpenderAlias) {
      case 'pod-manager':    return podManager(network).address;
      case 'subnet-manager': return subnetManager(network).address;
      case 've-reppo':       return veReppo(network).address;
    }
  }
  if (isAddress(spender)) return spender;
  throw cliError(
    'INVALID_SPENDER',
    `--spender must be one of pod-manager|subnet-manager|ve-reppo or a 0x-prefixed address; got "${spender}".`,
  );
}

export class ApproveCommand extends BaseCommand {
  static override paths = [['approve']];

  static override usage = BaseCommand.Usage({
    description: 'Approve a Reppo contract to spend your REPPO (or USDC) tokens.',
    examples: [
      ['Unlimited REPPO approval for veREPPO (default amount=max)',
        'reppo approve --spender ve-reppo'],
      ['Bounded approval (100 REPPO) for SubnetManager',
        'reppo approve --spender subnet-manager --amount 100'],
      ['USDC approval for PodManager (mintPodWithPrimaryToken)',
        'reppo approve --spender pod-manager --token usdc --amount 50'],
      ['Raw spender address + idempotency key',
        'reppo approve --spender 0xabc...def --amount max --idempotency-key approve-veReppo-once'],
      ['Dry-run',
        'reppo approve --spender ve-reppo --dry-run'],
    ],
  });

  spender = Option.String('--spender', { required: true, description: 'pod-manager | subnet-manager | ve-reppo | 0x-address' });
  amount = Option.String('--amount', 'max', { description: 'Token amount in human units, or "max" for MaxUint256 (default).' });
  token = Option.String('--token', 'reppo', { description: 'reppo (default) or usdc' });
  idempotencyKey = Option.String('--idempotency-key');
  dryRun = Option.Boolean('--dry-run', false);

  async execute(): Promise<number> {
    try {
      // Validate token + spender BEFORE loadConfig (cheapest path).
      if (!TOKEN_NAMES.has(this.token as TokenName)) {
        throw cliError('INVALID_TOKEN', `--token must be reppo or usdc; got "${this.token}".`);
      }
      const tokenName = this.token as TokenName;
      const decimals = tokenName === 'reppo' ? 18 : 6;

      const cfg = this.loadConfig();
      const pk = cfg.privateKey;
      if (!pk) {
        throw cliError(
          'MISSING_PRIVATE_KEY',
          'No signing key available.',
          'Set REPPO_PRIVATE_KEY in env.',
        );
      }

      const spenderAddr = resolveSpender(this.spender, cfg.network);

      let amount: bigint;
      if (this.amount === 'max') {
        amount = maxUint256;
      } else {
        try {
          amount = parseUnits(this.amount, decimals);
        } catch {
          throw cliError(
            'INVALID_AMOUNT',
            `--amount must be a positive decimal number or "max"; got "${this.amount}".`,
          );
        }
        if (amount <= 0n) {
          throw cliError(
            'INVALID_AMOUNT',
            `--amount must be > 0 or "max"; got "${this.amount}".`,
          );
        }
      }

      // Args fingerprint baked into the cache so re-using one key with a
      // different (token, spender, amount) → IDEMPOTENCY_ARGS_MISMATCH.
      const args = {
        token: tokenName,
        spender: spenderAddr.toLowerCase(),
        amount: amount.toString(),
      };

      // Dry-run NEVER consults or mutates the cache (peekIdempotent enforces
      // this with its 4th arg). Cached real-tx returns vs simulation results
      // must not be conflated.
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
      const token = tokenName === 'reppo' ? reppoToken(cfg.network) : usdcToken(cfg.network);

      // Pre-flight: skip the tx entirely if the existing allowance already
      // covers the request. Saves gas and matches agent re-runnability.
      const currentAllowance = await clients.publicClient.readContract({
        address: token.address, abi: token.abi, functionName: 'allowance',
        args: [clients.account.address, spenderAddr],
      });

      const fmtAmt = (a: bigint) =>
        a === maxUint256
          ? { raw: a.toString(), formatted: 'max' }
          : { raw: a.toString(), formatted: formatUnits(a, decimals) };

      if (currentAllowance >= amount) {
        const result = {
          token: tokenName,
          spender: spenderAddr,
          owner: clients.account.address,
          requested: fmtAmt(amount),
          currentAllowance: fmtAmt(currentAllowance),
          status: 'no-op' as const,
          reason: 'allowance already sufficient',
        };
        // No tx, so we intentionally skip writing the idempotency cache —
        // `markConfirmed` requires a real txHash. Re-reading the chain
        // allowance on retry is cheap and authoritative.
        emit(result, [
          `= No-op: ${tokenName.toUpperCase()} allowance from ${clients.account.address} to ${spenderAddr}`,
          `  is already ${fmtAmt(currentAllowance).formatted} (>= requested ${fmtAmt(amount).formatted}).`,
        ]);
        return 0;
      }

      if (this.dryRun) {
        const sim = await clients.publicClient.simulateContract({
          address: token.address, abi: token.abi, functionName: 'approve',
          args: [spenderAddr, amount], account: clients.account,
        }).catch((e) => {
          const decoded = decodeRevert(e);
          throw cliError(decoded.code, 'Simulation reverted', decoded.hint);
        });
        emit({
          simulated: true,
          token: tokenName,
          spender: spenderAddr,
          owner: clients.account.address,
          requested: fmtAmt(amount),
          currentAllowance: fmtAmt(currentAllowance),
          gas: sim.request.gas?.toString() ?? null,
        });
        return 0;
      }

      // Two-phase write: begin → submit → markSubmitted → wait → markConfirmed.
      if (this.idempotencyKey) await begin(this.idempotencyKey, COMMAND, args);

      let tx: `0x${string}`;
      try {
        const nonce = await nextNonce(clients.publicClient, clients.account.address);
        tx = await clients.walletClient.writeContract({
          address: token.address, abi: token.abi, functionName: 'approve',
          args: [spenderAddr, amount],
          chain: clients.walletClient.chain, account: clients.account, nonce,
        });
      } catch (e) {
        const decoded = decodeRevert(e);
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, decoded.code);
        throw cliError(decoded.code, 'Approve tx failed to submit', decoded.hint);
      }

      // Persist 'submitted' BEFORE waiting for receipt — closes the
      // retry-resend window an agent could otherwise hit.
      if (this.idempotencyKey) await markSubmitted(this.idempotencyKey, COMMAND, args, tx);

      const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
      if (receipt.status === 'reverted') {
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, 'TX_REVERTED', tx);
        throw cliError('TX_REVERTED', `Approve tx reverted: ${tx}`);
      }

      const result = {
        txHash: tx,
        gasEth: receiptGasEth(receipt),
        token: tokenName,
        spender: spenderAddr,
        owner: clients.account.address,
        requested: fmtAmt(amount),
        previousAllowance: fmtAmt(currentAllowance),
        block: receipt.blockNumber.toString(),
        basescanUrl: cfg.network === 'mainnet'
          ? `https://basescan.org/tx/${tx}`
          : `https://sepolia.basescan.org/tx/${tx}`,
      };
      if (this.idempotencyKey) await markConfirmed(this.idempotencyKey, COMMAND, args, result, tx);

      emit(result, [
        `✓ Approved ${spenderAddr} to spend ${fmtAmt(amount).formatted} ${tokenName.toUpperCase()}`,
        `  tx: ${result.basescanUrl}`,
        `  block: ${receipt.blockNumber}`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}
