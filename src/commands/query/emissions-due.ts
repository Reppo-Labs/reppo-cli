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
import { agentsApiBase } from '../../api/agents.js';
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

      // Preferred source: the agents API's chain-truth emissions-due endpoint
      // (reppo.ai /api/v1). It reads PodManagerV2 directly server-side, so it cannot
      // under-report the way the wallet-auth surface historically did (empty list while
      // 20 (pod,epoch) pairs were claimable on-chain), and it needs no wallet signature —
      // only the persistent agent credentials from `reppo register-agent`.
      // Falls through to the legacy api.reppo.xyz path when the credentials are absent
      // or the platform predates the endpoint (404).
      const agentId = cfg.agentId?.trim();
      const agentApiKey = cfg.agentApiKey?.trim();
      if (agentId && agentApiKey) {
        const viaAgents = await queryViaAgentsApi(agentsApiBase(cfg.network), agentId, agentApiKey);
        if (viaAgents !== null) {
          emit(viaAgents.result, viaAgents.lines);
          return 0;
        }
      }

      const pk = cfg.privateKey;
      if (!pk) {
        throw cliError(
          'MISSING_PRIVATE_KEY',
          'No signing key available.',
          'Set REPPO_PRIVATE_KEY in env (or REPPO_AGENT_ID + REPPO_AGENT_API_KEY from `reppo register-agent`). The legacy platform API requires a wallet signature to enumerate pods.',
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

/** One epoch row from the agents API's emissions-due endpoint. */
interface AgentsApiEpoch { epoch?: number; claimed?: boolean; claimable?: boolean }
interface AgentsApiPod {
  podId?: number | string;
  owner?: string;
  error?: string;
  epochs?: AgentsApiEpoch[];
}
interface AgentsApiEmissionsDue {
  data?: {
    currentEpoch?: number;
    maxClaimableEpoch?: number;
    byPod?: AgentsApiPod[];
    moreEpochsAvailable?: boolean;
    nextCursor?: string;
  };
}

/** Hard stop for the pagination loop — 50 pages × 240 epoch checks is far beyond any
 *  real backlog; hitting it means the platform is misbehaving, not that more data exists. */
const MAX_AGENTS_API_PAGES = 50;

/** Query the agents API's chain-truth emissions-due endpoint, following `nextCursor`
 *  until the backlog is fully enumerated. Returns null when the platform predates the
 *  endpoint (404), so the caller can fall back to the legacy wallet-auth path.
 *
 *  Output is mapped to this command's documented schema. The endpoint reports
 *  claimability without amounts (PodManagerV2 has no amount view — the chain pays what
 *  is owed at claim time), so amounts are '0' and `claimed` is the load-bearing field:
 *  an unclaimed epoch with NOTHING to claim (zero emissions) is reported as
 *  claimed=true, because emitting it as unclaimed would make consumers fire claim
 *  transactions that revert. */
export async function queryViaAgentsApi(
  apiBase: string,
  agentId: string,
  agentApiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ result: Record<string, unknown>; lines: string[] } | null> {
  const byPod = new Map<string, { owner: string | null; epochs: { epoch: number; amount: string; claimed: boolean }[]; error?: { code: string; message: string } }>();
  let currentEpoch: number | null = null;
  let cursor: string | undefined;
  let pages = 0;
  let truncated = false;

  do {
    if (pages >= MAX_AGENTS_API_PAGES) { truncated = true; break; }
    pages++;
    const url = `${apiBase}/agents/${encodeURIComponent(agentId)}/emissions-due${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
    let resp: Response;
    try {
      resp = await fetchImpl(url, { headers: { Authorization: `Bearer ${agentApiKey}` } });
    } catch (e) {
      throw cliError(
        'PLATFORM_UNREACHABLE',
        `Could not reach the Reppo agents API at ${apiBase}: ${(e as Error).message}.`,
        'Check connectivity, or unset REPPO_AGENT_ID to use the legacy wallet-auth path.',
      );
    }
    if (resp.status === 404) return null; // platform predates the endpoint — legacy path
    if (resp.status === 401) {
      throw cliError(
        'INVALID_AGENT_CREDENTIALS',
        'The agents API rejected REPPO_AGENT_ID / REPPO_AGENT_API_KEY (HTTP 401).',
        'Re-check the credentials from `reppo register-agent` — they are per-platform.',
      );
    }
    if (!resp.ok) {
      throw cliError(
        'PLATFORM_API_ERROR',
        `The agents API emissions-due endpoint returned HTTP ${resp.status}.`,
        'Retry later, or unset REPPO_AGENT_ID to use the legacy wallet-auth path.',
      );
    }
    const body = (await resp.json().catch(() => ({}))) as AgentsApiEmissionsDue;
    const data = body.data ?? {};
    currentEpoch = data.currentEpoch ?? currentEpoch;

    for (const pod of data.byPod ?? []) {
      const podId = pod.podId?.toString() ?? '';
      if (podId === '') continue;
      const entry = byPod.get(podId) ?? { owner: null, epochs: [] };
      entry.owner = pod.owner ?? entry.owner;
      if (pod.error) entry.error = { code: pod.error, message: `Platform could not resolve this pod (${pod.error}).` };
      for (const e of pod.epochs ?? []) {
        if (e.epoch === undefined) continue;
        entry.epochs.push({
          epoch: e.epoch,
          amount: '0',
          // Zero-emission unclaimed epochs surface as claimed=true — see docstring.
          claimed: e.claimable !== true,
        });
      }
      byPod.set(podId, entry);
    }
    cursor = data.moreEpochsAvailable ? data.nextCursor ?? undefined : undefined;
    if (data.moreEpochsAvailable && cursor === undefined) truncated = true; // defensive: flag without cursor
  } while (cursor !== undefined);

  const owners = [...byPod.values()].map((p) => p.owner).filter(Boolean);
  const result = {
    walletAddress: owners[0] ?? null,
    // Amounts are unknown pre-claim by design (no amount view on PodManagerV2).
    totalDueREPPO: { raw: '0', formatted: '0' },
    source: 'agents-api-onchain',
    ...(truncated ? { truncated: true } : {}),
    byPod: [...byPod.entries()].map(([podId, p]) => ({
      podId,
      currentEpoch: currentEpoch?.toString() ?? null,
      totalDue: { raw: '0', formatted: '0' },
      ...(p.owner ? { owner: p.owner } : {}),
      ...(p.error ? { error: p.error } : {}),
      epochs: p.epochs,
      moreEpochsAvailable: false,
    })),
  };

  const totalClaimablePairs = [...byPod.values()].reduce(
    (acc, p) => acc + p.epochs.filter((e) => !e.claimed).length, 0);
  const lines = [
    `Source: agents API (chain-truth, amounts settle at claim time)`,
    `Pods:   ${byPod.size}`,
    `Claimable (pod, epoch) pairs: ${totalClaimablePairs}`,
    ...(truncated ? ['WARNING: pagination stopped early — results may be incomplete. Re-run to continue.'] : []),
    ``,
    ...[...byPod.entries()].map(([podId, p]) => {
      if (p.error) return `  pod ${podId}: ✗ ${p.error.code}`;
      const open = p.epochs.filter((e) => !e.claimed).length;
      return `  pod ${podId}: ${open} claimable epoch${open === 1 ? '' : 's'}`;
    }),
  ];
  return { result, lines };
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
 * Parse a non-negative wei-amount returned by the platform API. Accepts
 * both string decimal ("1500000000000000000") and JS number forms; falls
 * back to 0n on anything unparseable so a single malformed pod entry
 * doesn't crash the whole command. `BigInt()` throws SyntaxError on
 * floats, scientific notation, and non-digit chars — guarded here so we
 * surface a clean 0 rather than an opaque INTERNAL_ERROR. Negatives are
 * also rejected (claimable emissions are always non-negative) so a buggy
 * API response can't drag totalDueREPPO below zero.
 */
export function parseWei(v: string | number | undefined): bigint {
  if (v === undefined || v === null) return 0n;
  const s = typeof v === 'number' ? Math.trunc(v).toString() : v.toString().trim();
  if (!/^\d+$/.test(s)) return 0n;
  try { return BigInt(s); } catch { return 0n; }
}
