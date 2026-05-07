/**
 * `reppo query emissions-due` — list all unclaimed REPPO emissions
 * across the caller's pods.
 *
 * Goes through the platform API at api.reppo.xyz because pods are not
 * enumerable on-chain (PodManager doesn't expose tokenOfOwnerByIndex).
 * The platform API's `GET /pods` returns the caller's owned pods; for
 * each pod we follow up with `GET /pods/{podId}/emissions` to get the
 * per-epoch breakdown.
 *
 * Auth: this command auto-acquires a platform session token (via the
 * same flow as `reppo auth`), refreshing if expired. The user must
 * have set REPPO_PRIVATE_KEY — the platform API requires a wallet
 * signature to sign in.
 *
 * Output schema:
 *   { walletAddress, totalDueREPPO: { raw, formatted },
 *     byPod: [{ podId, currentEpoch, totalDue: {raw, formatted},
 *               epochs: [{ epoch, amount, claimed }, ...] }, ...] }
 *
 * No optional [address] argument — the platform API only returns pods
 * for the authenticated wallet. Switching wallets requires switching
 * REPPO_PRIVATE_KEY.
 */
import { formatUnits } from 'viem';
import { BaseCommand } from '../_base.js';
import { cliError, emit } from '../../output/format.js';
import { getOrRefreshSession, platformGet } from '../../api/platform.js';

interface PodListItem {
  id?: string | number;
  podId?: string | number;
  totalEmissions?: string | number;
  mintHash?: string;
  basescanUrl?: string;
}

interface PodListResponse {
  data?: { pods?: PodListItem[]; podCount?: number };
  pods?: PodListItem[];
}

interface EpochBreakdown {
  epoch?: number | string;
  amount?: string | number;
  claimed?: boolean;
}

interface PodEmissionsResponse {
  data?: {
    podId?: string | number;
    currentEpoch?: number | string;
    totalClaimable?: string | number;
    epochs?: EpochBreakdown[];
    moreEpochsAvailable?: boolean;
  };
  // Some envelopes are flat
  podId?: string | number;
  currentEpoch?: number | string;
  totalClaimable?: string | number;
  epochs?: EpochBreakdown[];
  moreEpochsAvailable?: boolean;
}

export class QueryEmissionsDueCommand extends BaseCommand {
  static override paths = [['query', 'emissions-due']];

  static override usage = BaseCommand.Usage({
    description: 'List unclaimed REPPO emissions across all pods owned by the configured wallet.',
    examples: [
      ['List emissions due',
        'reppo query emissions-due'],
      ['JSON output for an agent loop',
        'reppo query emissions-due --json'],
    ],
  });

  async execute(): Promise<number> {
    try {
      const cfg = this.loadConfig();
      const pk = cfg.privateKey;
      if (!pk) {
        throw cliError(
          'MISSING_PRIVATE_KEY',
          'No signing key available.',
          'Set REPPO_PRIVATE_KEY in env. The platform API requires a wallet signature to enumerate pods.',
        );
      }

      // Auto-acquire/refresh the session token. Same flow `reppo auth` runs.
      const session = await getOrRefreshSession(cfg.network, cfg.apiUrl, pk);

      // Step 1: list the caller's pods.
      const podsResp = await platformGet<PodListResponse>(cfg.apiUrl, '/pods', session.accessToken);
      const pods = podsResp.data?.pods ?? podsResp.pods ?? [];

      if (pods.length === 0) {
        const result = {
          walletAddress: session.walletAddress,
          totalDueREPPO: { raw: '0', formatted: '0' },
          byPod: [] as unknown[],
        };
        emit(result, [
          `No pods owned by ${session.walletAddress}.`,
          `(Mint a pod with \`reppo mint-pod\` first.)`,
        ]);
        return 0;
      }

      // Step 2: per-pod emissions, in parallel. Cap fan-out at 10 to be
      // gentle on the platform; if more pods exist, batch sequentially.
      const podIds = pods
        .map((p) => (p.id ?? p.podId)?.toString())
        .filter((id): id is string => id !== undefined && id !== '');

      // Per-pod outcome: success carries the breakdown; failure carries a
      // structured error so one bad pod (404, expired token mid-batch,
      // malformed payload) doesn't black-hole the other pods' results.
      type PodOutcome =
        | { ok: true; podId: string; currentEpoch: string | null; totalClaimable: bigint;
            epochs: { epoch: string | null; amount: string; claimed: boolean }[]; moreEpochsAvailable: boolean }
        | { ok: false; podId: string; error: { code: string; message: string } };

      const breakdowns: PodOutcome[] = await batchedPromiseAll(podIds, 10, async (podId): Promise<PodOutcome> => {
        try {
          const r = await platformGet<PodEmissionsResponse>(
            cfg.apiUrl,
            `/pods/${encodeURIComponent(podId)}/emissions`,
            session.accessToken,
          );
          const data = r.data ?? r;
          return {
            ok: true,
            podId,
            currentEpoch: data.currentEpoch?.toString() ?? null,
            totalClaimable: parseWei(data.totalClaimable),
            epochs: (data.epochs ?? []).map((e) => ({
              epoch: e.epoch?.toString() ?? null,
              amount: e.amount?.toString() ?? '0',
              claimed: !!e.claimed,
            })),
            moreEpochsAvailable: !!data.moreEpochsAvailable,
          };
        } catch (e) {
          const err = e as { code?: string; message?: string };
          return {
            ok: false,
            podId,
            error: {
              code: err.code ?? 'PLATFORM_API_ERROR',
              message: err.message ?? String(e),
            },
          };
        }
      });

      const totalDue = breakdowns.reduce((acc, b) => (b.ok ? acc + b.totalClaimable : acc), 0n);

      const failedCount = breakdowns.filter((b) => !b.ok).length;
      const result = {
        walletAddress: session.walletAddress,
        totalDueREPPO: { raw: totalDue.toString(), formatted: formatUnits(totalDue, 18) },
        byPod: breakdowns.map((b) =>
          b.ok
            ? {
                podId: b.podId,
                currentEpoch: b.currentEpoch,
                totalDue: { raw: b.totalClaimable.toString(), formatted: formatUnits(b.totalClaimable, 18) },
                epochs: b.epochs,
                moreEpochsAvailable: b.moreEpochsAvailable,
              }
            : { podId: b.podId, error: b.error },
        ),
      };

      const lines = [
        `Wallet: ${session.walletAddress}`,
        `Pods:   ${pods.length}${failedCount > 0 ? ` (${failedCount} failed to fetch — see byPod[].error)` : ''}`,
        `Total claimable: ${formatUnits(totalDue, 18)} REPPO`,
        ``,
      ];
      for (const b of breakdowns) {
        if (!b.ok) {
          lines.push(`  pod ${b.podId}: ✗ ${b.error.code} — ${b.error.message}`);
          continue;
        }
        const claimable = formatUnits(b.totalClaimable, 18);
        const claimed = b.epochs.filter((e) => e.claimed).length;
        const open = b.epochs.length - claimed;
        lines.push(`  pod ${b.podId}: ${claimable} REPPO due across ${open} unclaimed epoch${open === 1 ? '' : 's'}${b.moreEpochsAvailable ? ' (more available — re-run after claiming)' : ''}`);
      }
      emit(result, lines);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}

/** Promise.all but with a concurrency cap. Avoids slamming the platform. */
async function batchedPromiseAll<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(fn));
    out.push(...results);
  }
  return out;
}

/**
 * Parse a wei-amount returned by the platform API. Accepts both string
 * decimal ("1500000000000000000") and JS number forms; falls back to 0n
 * on anything unparseable so a single malformed pod entry doesn't crash
 * the whole command. `BigInt()` throws SyntaxError on floats, scientific
 * notation, and non-digit chars — guarded here so we surface a clean 0
 * rather than an opaque INTERNAL_ERROR.
 */
function parseWei(v: string | number | undefined): bigint {
  if (v === undefined || v === null) return 0n;
  const s = typeof v === 'number' ? Math.trunc(v).toString() : v.toString().trim();
  if (!/^-?\d+$/.test(s)) return 0n;
  try { return BigInt(s); } catch { return 0n; }
}
