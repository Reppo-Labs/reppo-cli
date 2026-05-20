/**
 * `reppo list pods` — list pods, in one of two scopes.
 *
 * DEFAULT (owner scope): pods owned by the authenticated wallet. Hits the
 * platform API `GET /pods` on `cfg.apiUrl` (mainnet defaults to
 * https://api.reppo.xyz). The platform API only returns pods for the
 * authenticated wallet — there is NO `?owner=0xOther` query param.
 * Switching wallets requires switching REPPO_PRIVATE_KEY. Auth: auto-
 * acquires a platform session token via getOrRefreshSession, same flow as
 * `reppo auth`. Requires REPPO_PRIVATE_KEY. Testnet without REPPO_API_URL
 * surfaces PLATFORM_API_NOT_CONFIGURED inside getOrRefreshSession.
 *
 * `--all` (community scope): pods published by ANY wallet — the discovery
 * primitive for finding pods to vote on. Hits the UNAUTHENTICATED public
 * endpoint at https://reppo.ai/api/v1/public/pods (no private key, no
 * Bearer token), the same host/auth model as `list datanets`. Public pods
 * carry `privateSubnetId` (a CUID) rather than the numeric datanet id, so
 * `--all` also fetches `/api/v1/public/subnets` to translate CUID ↔
 * numeric id (for the `--datanet` filter and per-row `datanetId`). Each
 * row's `podId` feeds straight into `reppo vote --pod <podId>`. `--all` is
 * incompatible with `--include-emissions` (the public API has no
 * per-wallet emissions data).
 *
 * Optional `--include-emissions` (owner scope only) follows up with
 * `GET /pods/{podId}/emissions` per pod (matches the `query emissions-due`
 * shape) and appends a per-pod `unclaimedEmissionsREPPO` plus a top-level
 * `totalUnclaimedREPPO`. Off by default because it's N+1 against the
 * platform.
 */
import { Option } from 'clipanion';
import { formatUnits } from 'viem';
import { BaseCommand } from '../_base.js';
import { cliError, emit } from '../../output/format.js';
import { getOrRefreshSession, platformGet } from '../../api/platform.js';
import { publicGet, DEFAULT_PUBLIC_API_URL } from '../../api/public.js';

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
    description: 'List pods owned by the authenticated wallet, or (with --all) every published pod.',
    examples: [
      ['List my pods',
        'reppo list pods'],
      ['JSON output for an agent loop',
        'reppo list pods --json'],
      ['Include unclaimed emissions per pod (N+1 — slower)',
        'reppo list pods --include-emissions'],
      ['Cap at 5 rows',
        'reppo list pods --limit 5'],
      ['Only my pods in datanet 19',
        'reppo list pods --datanet 19 --json'],
      ['Discover pods from any wallet to vote on (public, no auth)',
        'reppo list pods --all --datanet 19 --json'],
    ],
  });

  all = Option.Boolean('--all', false, {
    description: 'List pods published by ANY wallet (public, unauthenticated) — for discovering pods to vote on. Incompatible with --include-emissions.',
  });

  includeEmissions = Option.Boolean('--include-emissions', false, {
    description: 'Also fetch unclaimed emissions per pod (N+1 against platform; off by default; owner scope only)',
  });

  datanet = Option.String('--datanet', {
    description: 'Only list pods belonging to this datanet (subnet) id.',
  });

  limit = Option.String('--limit', { description: 'Max rows to return (default: unlimited)' });

  async execute(): Promise<number> {
    try {
      const cfg = this.loadConfig();

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

      // --all switches to the public, unauthenticated community view: pods
      // published by any wallet. Distinct endpoint, distinct output shape.
      if (this.all) {
        if (this.includeEmissions) {
          throw cliError(
            'INCOMPATIBLE_FLAGS',
            '--all cannot be combined with --include-emissions.',
            'Per-pod emissions come from the wallet-authed platform API; --all uses the public API, which has no emissions data. Drop one flag.',
          );
        }
        await listCommunityPods(cfg.network, datanetFilter, limit);
        return 0;
      }

      // Owner scope below — requires a signing key for the platform API.
      const pk = cfg.privateKey;
      if (!pk) {
        throw cliError(
          'MISSING_PRIVATE_KEY',
          'No signing key available.',
          'Set REPPO_PRIVATE_KEY in env. The platform API requires a wallet signature to enumerate pods.',
        );
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

// ── --all (community scope) ─────────────────────────────────────────────

/** Raw pod row as returned by the public /api/v1/public/pods endpoint. */
interface RawCommunityPod {
  name?: string;
  tokenId?: number | string;
  privateSubnetId?: string;
  url?: string;
  podValidityEpoch?: number | string;
  cumulativeUpVotesVolume?: number | string;
  cumulativeDownVotesVolume?: number | string;
  creator?: { username?: string };
}

interface PublicPodsResponse {
  data?: { pods?: RawCommunityPod[] };
  pods?: RawCommunityPod[];
}

/** Raw subnet row — only the id/tokenId pair is needed for the CUID map. */
interface RawSubnetIdPair {
  id?: string;
  tokenId?: string;
}

interface PublicSubnetsResponse {
  data?: { subnets?: RawSubnetIdPair[] };
  subnets?: RawSubnetIdPair[];
}

/**
 * `list pods --all` body: enumerate pods published by any wallet via the
 * public API. `datanetFilter` is the already-validated numeric datanet id
 * (string form) or undefined; `limit` is the already-parsed row cap.
 */
async function listCommunityPods(
  network: string,
  datanetFilter: string | undefined,
  limit: number | undefined,
): Promise<void> {
  const baseUrl = process.env.REPPO_PUBLIC_API_URL ?? DEFAULT_PUBLIC_API_URL;

  // Fetch subnets first: needed to build the CUID → numeric-id map and to
  // resolve the --datanet filter to the CUID the pods carry.
  const subnetsResp = await publicGet<PublicSubnetsResponse>(baseUrl, '/api/v1/public/subnets');
  const rawSubnets = subnetsResp.data?.subnets ?? subnetsResp.subnets ?? [];

  const cuidToDatanetId = new Map<string, string>();
  for (const s of rawSubnets) {
    if (s.id && s.tokenId !== undefined && s.tokenId !== null) {
      cuidToDatanetId.set(s.id, s.tokenId.toString());
    }
  }

  // Resolve --datanet to the CUID pods reference. Erroring on an unknown
  // id (rather than returning empty) tells an agent it passed a bad id,
  // not that the datanet is empty.
  let datanetCuid: string | undefined;
  if (datanetFilter !== undefined) {
    for (const [cuid, id] of cuidToDatanetId) {
      if (id === datanetFilter) { datanetCuid = cuid; break; }
    }
    if (datanetCuid === undefined) {
      throw cliError(
        'DATANET_NOT_FOUND',
        `No datanet with id ${datanetFilter} exists.`,
        'Run `reppo list datanets` to see valid datanet ids.',
      );
    }
  }

  const podsResp = await publicGet<PublicPodsResponse>(baseUrl, '/api/v1/public/pods');
  const rawPods = podsResp.data?.pods ?? podsResp.pods ?? [];

  // Filter by datanet CUID before limiting so the cap reflects the
  // user's filtered view, not the raw API page.
  const filtered = datanetCuid !== undefined
    ? rawPods.filter((p) => p.privateSubnetId === datanetCuid)
    : rawPods;

  const limited = limit !== undefined ? filtered.slice(0, limit) : filtered;

  const pods = limited.map((p) => {
    const cuid = p.privateSubnetId;
    return {
      podId: p.tokenId !== undefined && p.tokenId !== null ? p.tokenId.toString() : '',
      name: p.name ?? '',
      creator: p.creator?.username ?? '',
      datanetId: cuid ? cuidToDatanetId.get(cuid) ?? null : null,
      upVotes: numericToString(p.cumulativeUpVotesVolume),
      downVotes: numericToString(p.cumulativeDownVotesVolume),
      validityEpoch: numericToString(p.podValidityEpoch),
      url: p.url ?? '',
    };
  });

  const result: Record<string, unknown> = {
    scope: 'community',
    network,
    pods,
    count: pods.length,
  };
  if (datanetFilter !== undefined) result.datanet = datanetFilter;

  const lines = [
    `Network: ${network}`,
    `Scope:   community (pods from any wallet)`,
  ];
  if (datanetFilter !== undefined) lines.push(`Datanet: ${datanetFilter}`);
  lines.push(
    `Pods:    ${pods.length}${limit !== undefined && filtered.length > pods.length ? ` (of ${filtered.length}; limited)` : ''}`,
    ``,
  );
  if (pods.length === 0) {
    lines.push(datanetFilter !== undefined
      ? '(no pods published in this datanet yet)'
      : '(no community pods found)');
  } else {
    for (const p of pods) {
      const datanet = p.datanetId !== null ? ` datanet=${p.datanetId}` : '';
      lines.push(`  pod ${p.podId}${datanet}  ↑${p.upVotes} ↓${p.downVotes}  ${p.name}`);
    }
  }

  emit(result, lines);
}

/**
 * Convert a JSON number/string from the public API into a string suitable
 * for downstream BigInt parsing. Missing or non-numeric values render as
 * "0" rather than "NaN"/"undefined" so the output shape stays consistent.
 */
function numericToString(v: number | string | undefined): string {
  if (v === undefined || v === null) return '0';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '0';
    return Math.trunc(v).toString();
  }
  const s = v.trim();
  return s === '' ? '0' : s;
}
