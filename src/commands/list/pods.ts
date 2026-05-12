/**
 * `reppo list pods` — list pods owned by the authenticated wallet.
 *
 * Hits the platform API `GET /pods` on `cfg.apiUrl` (mainnet defaults to
 * https://api.reppo.xyz). The platform API only returns pods for the
 * authenticated wallet — there is NO `?owner=0xOther` query param, so
 * "list someone else's pods" is intentionally out of scope (it would
 * require an event scan or a new platform endpoint that doesn't exist
 * yet). Switching wallets requires switching REPPO_PRIVATE_KEY.
 *
 * Optional `--include-emissions` follows up with `GET /pods/{podId}/emissions`
 * per pod (matches the `query emissions-due` shape) and appends a per-pod
 * `unclaimedEmissionsREPPO` plus a top-level `totalUnclaimedREPPO`. Off by
 * default because it's N+1 against the platform.
 *
 * Auth: auto-acquires a platform session token via getOrRefreshSession,
 * same flow as `reppo auth` / `reppo query emissions-due`. Requires
 * REPPO_PRIVATE_KEY. Testnet without REPPO_API_URL surfaces
 * PLATFORM_API_NOT_CONFIGURED via requireApiUrl inside getOrRefreshSession.
 */
import { Option } from 'clipanion';
import { formatUnits } from 'viem';
import { BaseCommand } from '../_base.js';
import { cliError, emit } from '../../output/format.js';
import { getOrRefreshSession, platformGet } from '../../api/platform.js';

// Mirror the shape used by `query/emissions-due.ts`. Redefined here
// rather than imported because that file deliberately doesn't export
// these — refactoring them out is a separate concern.
interface PodListItem {
  id?: string | number;
  podId?: string | number;
  subnetId?: string | number;
  totalEmissions?: string | number;
  mintHash?: string;
  basescanUrl?: string;
  mintedAt?: string;
  createdAt?: string;
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
  podId?: string | number;
  currentEpoch?: number | string;
  totalClaimable?: string | number;
  epochs?: EpochBreakdown[];
  moreEpochsAvailable?: boolean;
}

export class ListPodsCommand extends BaseCommand {
  static override paths = [['list', 'pods']];

  static override usage = BaseCommand.Usage({
    description: 'List pods owned by the authenticated wallet (REPPO_PRIVATE_KEY).',
    examples: [
      ['List my pods',
        'reppo list pods'],
      ['JSON output for an agent loop',
        'reppo list pods --json'],
      ['Include unclaimed emissions per pod (N+1 — slower)',
        'reppo list pods --include-emissions'],
      ['Cap at 5 rows',
        'reppo list pods --limit 5'],
      ['Only pods in datanet 19',
        'reppo list pods --datanet 19 --json'],
    ],
  });

  includeEmissions = Option.Boolean('--include-emissions', false, {
    description: 'Also fetch unclaimed emissions per pod (N+1 against platform; off by default)',
  });

  datanet = Option.String('--datanet', {
    description: 'Only list pods belonging to this datanet (subnet) id.',
  });

  limit = Option.String('--limit', { description: 'Max rows to return (default: unlimited)' });

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

      // Parse --limit up front so a bad value fails before any network call.
      let limit: number | undefined;
      if (this.limit !== undefined) {
        const n = Number(this.limit);
        if (!Number.isInteger(n) || n < 0) {
          throw cliError(
            'INVALID_LIMIT',
            `--limit must be a non-negative integer; got "${this.limit}".`,
          );
        }
        limit = n;
      }

      // Parse --datanet up front. Subnet ids are non-negative integers
      // on-chain; normalize to the string form returned by the API so the
      // filter comparison below is a simple === check.
      let datanetFilter: string | undefined;
      if (this.datanet !== undefined) {
        const trimmed = this.datanet.trim();
        const n = Number(trimmed);
        if (!Number.isInteger(n) || n < 0 || trimmed === '') {
          throw cliError(
            'INVALID_DATANET',
            `--datanet must be a non-negative integer; got "${this.datanet}".`,
          );
        }
        datanetFilter = n.toString();
      }

      // Auto-acquire/refresh the session token. Same flow `reppo auth` runs.
      // requireApiUrl inside getOrRefreshSession surfaces PLATFORM_API_NOT_CONFIGURED
      // for testnet without REPPO_API_URL.
      const session = await getOrRefreshSession(cfg.network, cfg.apiUrl, pk);

      const podsResp = await platformGet<PodListResponse>(cfg.apiUrl, '/pods', session.accessToken);
      const rawPods = podsResp.data?.pods ?? podsResp.pods ?? [];

      // Normalize: pick podId from `id` or `podId`, drop anything without one.
      const normalized = rawPods
        .map((p) => {
          const podId = (p.id ?? p.podId)?.toString();
          if (!podId) return null;
          const out: {
            podId: string;
            subnetId?: string;
            mintedAt?: string;
            mintHash?: string;
            basescanUrl?: string;
          } = { podId };
          if (p.subnetId !== undefined && p.subnetId !== null) out.subnetId = p.subnetId.toString();
          if (p.mintedAt) out.mintedAt = p.mintedAt;
          else if (p.createdAt) out.mintedAt = p.createdAt;
          if (p.mintHash) out.mintHash = p.mintHash;
          if (p.basescanUrl) out.basescanUrl = p.basescanUrl;
          return out;
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);

      // Apply --datanet filter before --limit so the cap reflects the
      // user's filtered view, not the raw API page.
      const filtered = datanetFilter !== undefined
        ? normalized.filter((p) => p.subnetId === datanetFilter)
        : normalized;

      const truncated = limit !== undefined ? filtered.slice(0, limit) : filtered;

      if (truncated.length === 0) {
        const result = {
          address: session.walletAddress,
          network: cfg.network,
          pods: [] as unknown[],
          count: 0,
        };
        const emptyLines = [
          `Wallet:  ${session.walletAddress}`,
          `Network: ${cfg.network}`,
        ];
        if (datanetFilter !== undefined) emptyLines.push(`Datanet: ${datanetFilter}`);
        if (datanetFilter !== undefined && normalized.length > 0) {
          emptyLines.push(`No pods in this datanet (wallet owns ${normalized.length} pod(s) total).`);
        } else {
          emptyLines.push(
            `No pods owned by this wallet.`,
            `(Mint a pod with \`reppo mint-pod\` first.)`,
          );
        }
        emit(result, emptyLines);
        return 0;
      }

      // Optional emissions enrichment. Same fan-out cap as emissions-due.
      type EmissionsByPod = Map<string, { unclaimedREPPO: bigint; error?: { code: string; message: string } }>;
      let emissionsByPod: EmissionsByPod | undefined;

      if (this.includeEmissions) {
        emissionsByPod = new Map();
        const fetched = await batchedPromiseAll(truncated, 10, async (p) => {
          try {
            const r = await platformGet<PodEmissionsResponse>(
              cfg.apiUrl,
              `/pods/${encodeURIComponent(p.podId)}/emissions`,
              session.accessToken,
            );
            const data = r.data ?? r;
            // Prefer the API-provided `totalClaimable` aggregate; fall back
            // to summing unclaimed epochs only if it's absent.
            let unclaimed = parseWei(data.totalClaimable);
            if (unclaimed === 0n && data.epochs) {
              for (const e of data.epochs) {
                if (!e.claimed) unclaimed += parseWei(e.amount);
              }
            }
            return { podId: p.podId, unclaimedREPPO: unclaimed };
          } catch (e) {
            const err = e as { code?: string; message?: string };
            return {
              podId: p.podId,
              unclaimedREPPO: 0n,
              error: {
                code: err.code ?? 'PLATFORM_API_ERROR',
                message: err.message ?? String(e),
              },
            };
          }
        });
        for (const f of fetched) {
          emissionsByPod.set(f.podId, f.error
            ? { unclaimedREPPO: f.unclaimedREPPO, error: f.error }
            : { unclaimedREPPO: f.unclaimedREPPO });
        }
      }

      const pods = truncated.map((p) => {
        const base: Record<string, unknown> = { podId: p.podId };
        if (p.subnetId !== undefined) base.subnetId = p.subnetId;
        if (p.mintedAt !== undefined) base.mintedAt = p.mintedAt;
        if (p.mintHash !== undefined) base.mintHash = p.mintHash;
        if (p.basescanUrl !== undefined) base.basescanUrl = p.basescanUrl;
        if (emissionsByPod) {
          const e = emissionsByPod.get(p.podId);
          if (e) {
            base.unclaimedEmissionsREPPO = {
              raw: e.unclaimedREPPO.toString(),
              formatted: formatUnits(e.unclaimedREPPO, 18),
            };
            if (e.error) base.emissionsError = e.error;
          }
        }
        return base;
      });

      const totalUnclaimed = emissionsByPod
        ? Array.from(emissionsByPod.values()).reduce((acc, e) => acc + e.unclaimedREPPO, 0n)
        : undefined;

      const result: Record<string, unknown> = {
        address: session.walletAddress,
        network: cfg.network,
        pods,
        count: pods.length,
      };
      if (totalUnclaimed !== undefined) {
        result.totalUnclaimedREPPO = {
          raw: totalUnclaimed.toString(),
          formatted: formatUnits(totalUnclaimed, 18),
        };
      }

      const lines = [
        `Wallet:  ${session.walletAddress}`,
        `Network: ${cfg.network}`,
      ];
      if (datanetFilter !== undefined) lines.push(`Datanet: ${datanetFilter}`);
      lines.push(
        `Pods:    ${pods.length}${limit !== undefined && filtered.length > pods.length ? ` (of ${filtered.length}; limited)` : ''}`,
      );
      if (totalUnclaimed !== undefined) {
        lines.push(`Total unclaimed: ${formatUnits(totalUnclaimed, 18)} REPPO`);
      }
      lines.push(``);
      for (const p of pods) {
        const subnet = p.subnetId !== undefined ? ` subnet=${p.subnetId as string}` : '';
        let emissionsLine = '';
        if (emissionsByPod) {
          const e = emissionsByPod.get(p.podId as string);
          if (e?.error) {
            emissionsLine = `  (emissions: ✗ ${e.error.code})`;
          } else if (e) {
            emissionsLine = `  ${formatUnits(e.unclaimedREPPO, 18)} REPPO unclaimed`;
          }
        }
        lines.push(`  pod ${p.podId as string}${subnet}${emissionsLine}`);
      }
      emit(result, lines);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}

/** Promise.all with concurrency cap. Mirrors the emissions-due helper. */
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
 * Parse a non-negative wei-amount from the platform API. Same semantics
 * as `query/emissions-due.ts`'s parseWei — duplicated rather than imported
 * because that file's parseWei isn't part of a stable shared utility yet,
 * and refactoring it out is a separate concern.
 */
export function parseWei(v: string | number | undefined | null): bigint {
  if (v === undefined || v === null) return 0n;
  const s = typeof v === 'number' ? Math.trunc(v).toString() : v.toString().trim();
  if (!/^\d+$/.test(s)) return 0n;
  try { return BigInt(s); } catch { return 0n; }
}
