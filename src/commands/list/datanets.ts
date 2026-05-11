/**
 * `reppo list datanets` — list active datanets on the Reppo platform.
 *
 * Hits the UNAUTHENTICATED public endpoint at
 * https://reppo.ai/api/v1/public/subnets. No private key, no Bearer
 * token. Distinct host from `cfg.apiUrl` (api.reppo.xyz, wallet-authed).
 *
 * "Datanet" is the user-facing name; the platform API still uses the
 * legacy "subnet" terminology in field names. The CLI surface translates.
 *
 * Output is a compact list shape — full descriptions, thumbnails, and
 * onboarding text live in `query datanet <id>` instead so this view
 * stays scannable for agents.
 *
 * Numeric platform fields (accessFeeREPPO, emissionsPerEpochREPPO,
 * upVoteVolume, downVoteVolume) arrive as JSON numbers; they're emitted
 * as strings here so downstream agents can BigInt-parse them without
 * losing precision.
 */
import { Option } from 'clipanion';
import { BaseCommand } from '../_base.js';
import { cliError, emit } from '../../output/format.js';
import { publicGet, DEFAULT_PUBLIC_API_URL } from '../../api/public.js';

/** Raw subnet row as returned by /api/v1/public/subnets. */
interface RawSubnet {
  id?: string;
  subnetName?: string;
  subnetDescription?: string;
  thumbnailUrl?: string;
  nativeTokenAddress?: string;
  nativeTokenSymbol?: string;
  nativeTokenDecimals?: number;
  tokenId?: string;
  accessFeeREPPO?: number | string;
  emissionsPerEpochREPPO?: number | string;
  emissionsPerEpochPrimaryToken?: number | string;
  status?: string;
  upVoteVolume?: number | string;
  downVoteVolume?: number | string;
  onboardingPublishers?: string;
  onboardingVoters?: string;
  createdByUserId?: string;
  deleteScheduledAt?: string | null;
  isABTestingSubnet?: boolean;
}

interface PublicSubnetsResponse {
  data?: { subnets?: RawSubnet[] };
  subnets?: RawSubnet[];
}

interface DatanetRow {
  id: string;
  name: string;
  status: string;
  accessFeeREPPO: string;
  emissionsPerEpochREPPO: string;
  nativeToken: {
    address: string;
    symbol: string;
    decimals: number;
  };
  upVoteVolume: string;
  downVoteVolume: string;
}

const VALID_STATUSES = ['ACTIVE', 'ALL'] as const;
type StatusFilter = (typeof VALID_STATUSES)[number];

export class ListDatanetsCommand extends BaseCommand {
  static override paths = [['list', 'datanets']];

  static override usage = BaseCommand.Usage({
    description: 'List active datanets on the Reppo platform (public, unauthenticated).',
    examples: [
      ['List all active datanets',
        'reppo list datanets'],
      ['Include scheduled-for-deletion rows too',
        'reppo list datanets --status ALL'],
      ['Only datanets paid in REPPO',
        'reppo list datanets --token-symbol REPPO'],
      ['Limit to first 5 rows',
        'reppo list datanets --limit 5'],
      ['JSON output for agents',
        'reppo list datanets --json'],
    ],
  });

  status = Option.String('--status', 'ACTIVE', {
    description: 'Filter by status. ACTIVE (default) shows live datanets; ALL includes scheduled-for-deletion.',
  });

  tokenSymbol = Option.String('--token-symbol', {
    description: 'Filter by native token symbol (case-insensitive), e.g. REPPO or USDC.',
  });

  limit = Option.String('--limit', {
    description: 'Maximum number of rows to return after filtering.',
  });

  async execute(): Promise<number> {
    try {
      const cfg = this.loadConfig();

      // Validate --status.
      const statusUpper = this.status.toUpperCase();
      if (!isStatusFilter(statusUpper)) {
        throw cliError(
          'INVALID_STATUS',
          `--status must be one of ${VALID_STATUSES.join(', ')}; got "${this.status}".`,
        );
      }

      // Validate --limit if present (positive integer).
      let limitN: number | undefined;
      if (this.limit !== undefined) {
        if (!/^\d+$/.test(this.limit)) {
          throw cliError(
            'INVALID_LIMIT',
            `--limit must be a non-negative integer; got "${this.limit}".`,
          );
        }
        limitN = Number.parseInt(this.limit, 10);
      }

      // Resolve env override at call site (per spec — not in loadConfig).
      const baseUrl = process.env.REPPO_PUBLIC_API_URL ?? DEFAULT_PUBLIC_API_URL;

      const resp = await publicGet<PublicSubnetsResponse>(baseUrl, '/api/v1/public/subnets');
      const raw = resp.data?.subnets ?? resp.subnets ?? [];

      // Filter: status, token-symbol.
      const symbolNeedle = this.tokenSymbol?.toLowerCase();
      const filtered = raw.filter((s) => {
        if (statusUpper === 'ACTIVE' && (s.status ?? '').toUpperCase() !== 'ACTIVE') return false;
        if (symbolNeedle && (s.nativeTokenSymbol ?? '').toLowerCase() !== symbolNeedle) return false;
        return true;
      });

      const limited = limitN !== undefined ? filtered.slice(0, limitN) : filtered;

      const datanets: DatanetRow[] = limited.map(toRow);

      const result = {
        network: cfg.network,
        datanets,
        count: datanets.length,
      };

      const lines = [
        `Network:  ${cfg.network}`,
        `Datanets: ${datanets.length}${this.tokenSymbol ? ` (token=${this.tokenSymbol})` : ''}${statusUpper !== 'ACTIVE' ? ` (status=${statusUpper})` : ''}`,
        ``,
      ];
      if (datanets.length === 0) {
        lines.push('(no datanets matched)');
      } else {
        for (const d of datanets) {
          lines.push(`  #${d.id.padEnd(4)} ${d.name}  [${d.status}]  fee=${d.accessFeeREPPO} REPPO  token=${d.nativeToken.symbol}`);
        }
      }

      emit(result, lines);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}

function isStatusFilter(v: string): v is StatusFilter {
  return (VALID_STATUSES as readonly string[]).includes(v);
}

/**
 * Convert a JSON number/string from the platform into a string suitable
 * for downstream BigInt parsing. Non-numeric or missing values render
 * as "0" rather than "NaN" or "undefined" so the output shape stays
 * consistent.
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

function toRow(s: RawSubnet): DatanetRow {
  return {
    id: s.tokenId ?? '',
    name: s.subnetName ?? '',
    status: s.status ?? 'UNKNOWN',
    accessFeeREPPO: numericToString(s.accessFeeREPPO),
    emissionsPerEpochREPPO: numericToString(s.emissionsPerEpochREPPO),
    nativeToken: {
      address: s.nativeTokenAddress ?? '',
      symbol: s.nativeTokenSymbol ?? '',
      decimals: typeof s.nativeTokenDecimals === 'number' ? s.nativeTokenDecimals : 0,
    },
    upVoteVolume: numericToString(s.upVoteVolume),
    downVoteVolume: numericToString(s.downVoteVolume),
  };
}
