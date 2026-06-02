/**
 * Reppo public catalog of datanets ("subnets").
 *
 * The unauthenticated endpoint `GET reppo.ai/api/v1/public/subnets` returns
 * the rich, off-chain metadata for every datanet — name, description,
 * onboarding guidance, native token, emissions, vote volumes. This is the
 * source `list datanets` summarizes and `query datanet` surfaces in full.
 *
 * "Datanet" is the user-facing name; the platform still uses the legacy
 * "subnet" terminology in field names. A row carries BOTH ids:
 *   - `id`      — platform cuid (e.g. cmnhuowns000bic04e16t6735), the
 *                 `--subnet-uuid` used by mint-pod Phase-2 publishing.
 *   - `tokenId` — the on-chain datanet id (e.g. "9") the CLI takes as the
 *                 `query datanet <id>` / `mint-pod --datanet` argument.
 */
import { publicGet } from './public.js';

export const PUBLIC_SUBNETS_PATH = '/api/v1/public/subnets';

/** Raw subnet row as returned by /api/v1/public/subnets. */
export interface RawSubnet {
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

export interface PublicSubnetsResponse {
  data?: { subnets?: RawSubnet[] };
  subnets?: RawSubnet[];
}

/**
 * Convert a JSON number/string from the platform into a string suitable for
 * downstream BigInt parsing. Non-numeric or missing values render as "0"
 * rather than "NaN"/"undefined" so the output shape stays consistent.
 */
export function numericToString(v: number | string | undefined): string {
  if (v === undefined || v === null) return '0';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '0';
    return Math.trunc(v).toString();
  }
  const s = v.trim();
  return s === '' ? '0' : s;
}

/** Fetch the full public catalog. Throws `PUBLIC_API_*` on transport/parse failure. */
export async function fetchSubnets(baseUrl: string | undefined): Promise<RawSubnet[]> {
  const resp = await publicGet<PublicSubnetsResponse>(baseUrl, PUBLIC_SUBNETS_PATH);
  return resp.data?.subnets ?? resp.subnets ?? [];
}

/**
 * Find a single catalog row by its on-chain datanet id (`tokenId`). Returns
 * `null` when no row matches (e.g. a testnet datanet absent from the mainnet
 * catalog). Throws `PUBLIC_API_*` only on transport/parse failure — the
 * caller decides whether that's fatal.
 */
export async function fetchSubnetByTokenId(
  baseUrl: string | undefined,
  tokenId: string,
): Promise<RawSubnet | null> {
  const subnets = await fetchSubnets(baseUrl);
  return subnets.find((s) => (s.tokenId ?? '') === tokenId) ?? null;
}
