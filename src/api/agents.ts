/**
 * Agent-scoped platform API (reppo.ai/api/v1/agents/*) — the Phase-2
 * metadata surface for minting. Distinct service from api.reppo.xyz
 * (see api/platform.ts): this one authenticates with the persistent agent
 * apiKey from `reppo register-agent`, not the wallet-auth session token.
 *
 * `mintPodWithREPPO(to, subnetId)` creates the bare ERC-721 on Base but
 * carries no text or dataset URI. The Reppo UI surfaces a pod only after a
 * separate authenticated POST registers its metadata in the platform DB:
 *
 *   POST {AGENTS_API_BASE}/agents/{agentId}/pods
 *   Authorization: Bearer {agentApiKey}
 *   { txHash, subnetId, podName, podDescription, url, platform, category,
 *     agreeToTerms, imageURL, thumbnailURL, pdfURL, videoURL }
 *
 * Optionally the pod's dataset is first pinned to IPFS via Pinata, and the
 * resulting public-gateway URL is wired into the POST body.
 *
 * Two hard-won constraints are encoded by the caller (learned in the aeon
 * swarm), documented here so this module's contract is self-explaining:
 *   - `subnetId` MUST be the platform subnet UUID (a cuid like
 *     `cmnhuowns000bic04e16t6735`), NOT the on-chain datanet id. Sending the
 *     numeric id passes the platform's Zod schema but 500s in the downstream
 *     UUID lookup.
 *   - `podName` ≤ 50 chars, `podDescription` ≤ 200 chars.
 *
 * These functions return structured results / throw `cliError`; they never
 * print. The caller decides exit semantics — a Phase-2 failure must NOT flip
 * a confirmed on-chain mint to "failed", because the tx is already durable.
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { cliError } from '../output/format.js';

/**
 * Agents API base. Hardcoded — same host as `register-agent`, distinct from
 * REPPO_API_URL (api.reppo.xyz wallet-auth surface).
 */
export const AGENTS_API_BASE = 'https://reppo.ai/api/v1';
const PINATA_PIN_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';

/** Platform-enforced field ceilings (aeon ISS-012). */
export const POD_NAME_MAX = 50;
export const POD_DESCRIPTION_MAX = 200;

export interface PodMetadata {
  txHash: string;
  /** Platform subnet UUID (cuid), NOT the on-chain datanet id. */
  subnetId: string;
  podName: string;
  podDescription: string;
  url: string;
  platform: string;
  category: string;
  agreeToTerms: boolean;
  imageURL: string;
  thumbnailURL: string;
  pdfURL: string;
  videoURL: string;
}

/**
 * Pin a local file to IPFS via Pinata. Returns the public-gateway URL
 * (`https://ipfs.io/ipfs/<cid>`) so the pin is verifiable from any gateway —
 * Pinata's role here is pinning, not gating retrieval.
 *
 * Throws `cliError` on a missing file, missing JWT, network error, or any
 * non-2xx / malformed Pinata response.
 */
export async function pinDatasetToIpfs(filePath: string, pinataJwt: string): Promise<string> {
  if (!existsSync(filePath)) {
    throw cliError('DATASET_FILE_NOT_FOUND', `Dataset file not found: ${filePath}`);
  }
  if (!pinataJwt) {
    throw cliError(
      'MISSING_PINATA_JWT',
      'PINATA_JWT is required to pin a --dataset file to IPFS.',
      'Set PINATA_JWT, or pass --dataset-uri <url> to skip pinning and supply the URL directly.',
    );
  }

  const name = basename(filePath);
  const form = new FormData();
  // Read the whole file into memory — datasets here are small JSON blobs.
  form.append('file', new Blob([readFileSync(filePath)]), name);
  form.append('pinataMetadata', JSON.stringify({ name }));

  let response: Response;
  try {
    response = await fetch(PINATA_PIN_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pinataJwt}` },
      body: form,
    });
  } catch (e) {
    throw cliError(
      'IPFS_PIN_UNREACHABLE',
      `Could not reach Pinata at ${PINATA_PIN_URL}: ${(e as Error).message}.`,
      'Check your connection and PINATA_JWT. The on-chain mint already landed; re-run with the same --idempotency-key to retry Phase 2.',
    );
  }

  let body: { IpfsHash?: string; error?: unknown } | null = null;
  try {
    body = (await response.json()) as { IpfsHash?: string; error?: unknown };
  } catch {
    // fall through to the !ok / missing-CID handling below
  }

  if (!response.ok || !body?.IpfsHash) {
    const detail =
      typeof body?.error === 'string'
        ? body.error
        : JSON.stringify(body?.error ?? `HTTP ${response.status}`);
    throw cliError(
      'IPFS_PIN_FAILED',
      `Pinata pin failed (HTTP ${response.status}): ${detail}`,
      'Verify PINATA_JWT has the pinFileToIPFS scope. The mint is durable; retry Phase 2 with the same --idempotency-key.',
    );
  }

  return `https://ipfs.io/ipfs/${body.IpfsHash}`;
}

export interface RegisterResult {
  ok: boolean;
  status: number;
  /** Single-line, trimmed response detail for diagnostics (≤600 chars). */
  detail: string;
}

/**
 * POST pod metadata to the platform. Returns `{ ok, status, detail }` for any
 * HTTP response (the caller decides whether a non-2xx is fatal). Throws
 * `cliError` only on a network-level failure (DNS/TLS/refused).
 */
export async function registerPodMetadata(
  agentId: string,
  agentApiKey: string,
  metadata: PodMetadata,
  apiBase: string = AGENTS_API_BASE,
): Promise<RegisterResult> {
  const url = `${apiBase}/agents/${agentId}/pods`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agentApiKey}`,
      },
      body: JSON.stringify(metadata),
    });
  } catch (e) {
    throw cliError(
      'PLATFORM_API_UNREACHABLE',
      `Could not reach the Reppo platform at ${url}: ${(e as Error).message}.`,
      'The on-chain mint already landed. Re-run with the same --idempotency-key once the platform is reachable to retry Phase 2.',
    );
  }

  const raw = await response.text().catch(() => '');
  // Collapse whitespace and cap at 600 chars so a failure fits one log line.
  const detail = raw.replace(/\s+/g, ' ').trim().slice(0, 600);
  return { ok: response.ok, status: response.status, detail };
}
