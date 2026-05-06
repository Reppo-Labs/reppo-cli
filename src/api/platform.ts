/**
 * Reppo platform API helpers (api.reppo.xyz).
 *
 * Two-step EIP-191 wallet auth:
 *   1. POST /auth/nonce  { walletAddress } → { nonce, message }
 *   2. POST /auth/verify { walletAddress, signature, nonce } → { token, ... }
 *
 * The returned token is a 24h Bearer credential. Cached in
 * state/db.ts under sessions[`${network}:reppo-platform`].
 *
 * NB: this module deliberately does NOT touch reppo.ai/api/v1/agents/*,
 * which is a separate auth surface (persistent accessToken from
 * register-agent, not a session). Two distinct services.
 */
import type { PrivateKeyAccount } from 'viem/accounts';
import { privateKeyToAccount } from 'viem/accounts';
import { cliError } from '../output/format.js';
import { getSession, saveSession, type SessionEntry } from '../state/db.js';
import type { Network } from '../chain/addresses.js';

/**
 * Default base URL for the wallet-auth platform API. Resolved from
 * `cfg.apiUrl` (env REPPO_API_URL) when available; falls back to the
 * mainnet default if `cfg.apiUrl` is undefined.
 */
const DEFAULT_PLATFORM_API = 'https://api.reppo.xyz';

const SESSION_KEY = 'reppo-platform' as const;

/**
 * Re-authenticate with the platform API: hit /auth/nonce, sign the
 * returned message with the caller's account, hit /auth/verify, return
 * the new session.
 *
 * Caller responsible for caching via `saveSession`.
 */
export async function signInWithEthereum(
  apiUrl: string,
  account: PrivateKeyAccount,
): Promise<SessionEntry> {
  const baseUrl = apiUrl.replace(/\/+$/, '');

  // Step 1: request a nonce + message to sign.
  let nonceResp: Response;
  try {
    nonceResp = await fetch(`${baseUrl}/auth/nonce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: account.address }),
    });
  } catch (e) {
    throw cliError(
      'PLATFORM_API_UNREACHABLE',
      `Could not reach the Reppo platform at ${baseUrl}: ${(e as Error).message}.`,
      'Check your internet connection. If the platform is down, try again in a few minutes.',
    );
  }

  if (!nonceResp.ok) {
    const body = await safeJson(nonceResp);
    throw cliError(
      'PLATFORM_API_AUTH_FAILED',
      `/auth/nonce returned HTTP ${nonceResp.status}: ${pickErr(body) ?? 'no body'}.`,
      `If the error persists, the platform may be rejecting your wallet address. Verify REPPO_PRIVATE_KEY derives the address you expect.`,
    );
  }

  const nonceData = (await nonceResp.json()) as { nonce?: string; message?: string };
  if (!nonceData.nonce || !nonceData.message) {
    throw cliError(
      'PLATFORM_API_INVALID_RESPONSE',
      `/auth/nonce returned 200 but the response is missing nonce or message fields.`,
    );
  }

  // Step 2: sign the message and verify.
  const signature = await account.signMessage({ message: nonceData.message });

  let verifyResp: Response;
  try {
    verifyResp = await fetch(`${baseUrl}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: account.address,
        signature,
        nonce: nonceData.nonce,
      }),
    });
  } catch (e) {
    throw cliError(
      'PLATFORM_API_UNREACHABLE',
      `Could not reach ${baseUrl}/auth/verify: ${(e as Error).message}.`,
    );
  }

  if (!verifyResp.ok) {
    const body = await safeJson(verifyResp);
    throw cliError(
      'PLATFORM_API_AUTH_FAILED',
      `/auth/verify returned HTTP ${verifyResp.status}: ${pickErr(body) ?? 'no body'}.`,
      'The platform rejected the signature. Verify REPPO_PRIVATE_KEY is the same wallet that requested the nonce.',
    );
  }

  // Verify response shape varies; handle both flat and nested envelopes.
  const verifyBody = (await verifyResp.json()) as Record<string, unknown>;
  const data = (verifyBody.data && typeof verifyBody.data === 'object' ? verifyBody.data : verifyBody) as Record<string, unknown>;
  const token = (data.token ?? data.accessToken) as string | undefined;
  const expiresInSec = (data.expiresIn ?? 86400) as number; // default 24h per docs

  if (!token) {
    throw cliError(
      'PLATFORM_API_INVALID_RESPONSE',
      `/auth/verify returned 200 but no token field.`,
    );
  }

  const now = Date.now();
  return {
    accessToken: token,
    walletAddress: account.address,
    expiresAt: now + expiresInSec * 1000,
    createdAt: now,
  };
}

/**
 * Return a valid platform-API session, refreshing if expired or missing.
 * Caches the new session in state/db.ts.
 *
 * Refresh-margin: 60s — refresh proactively if the cached token expires
 * in the next minute, to avoid a stale-token revert mid-command.
 */
export async function getOrRefreshSession(
  network: Network,
  apiUrl: string | undefined,
  privateKey: `0x${string}`,
): Promise<SessionEntry> {
  const url = apiUrl ?? DEFAULT_PLATFORM_API;
  const account = privateKeyToAccount(privateKey);

  const cached = await getSession(network, SESSION_KEY);
  if (cached && cached.walletAddress?.toLowerCase() === account.address.toLowerCase()) {
    const REFRESH_MARGIN_MS = 60_000;
    const stillValid = cached.expiresAt !== undefined && Date.now() + REFRESH_MARGIN_MS < cached.expiresAt;
    if (stillValid) return cached;
  }

  const fresh = await signInWithEthereum(url, account);
  await saveSession(network, SESSION_KEY, fresh);
  return fresh;
}

/**
 * Authenticated GET against the platform API. Returns parsed JSON or
 * throws PLATFORM_API_ERROR on non-2xx.
 */
export async function platformGet<T>(
  apiUrl: string | undefined,
  path: string,
  token: string,
): Promise<T> {
  const baseUrl = (apiUrl ?? DEFAULT_PLATFORM_API).replace(/\/+$/, '');
  const url = `${baseUrl}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
  } catch (e) {
    throw cliError(
      'PLATFORM_API_UNREACHABLE',
      `Could not reach ${url}: ${(e as Error).message}.`,
    );
  }

  if (response.status === 401) {
    throw cliError(
      'PLATFORM_API_UNAUTHORIZED',
      `Platform rejected the session token (HTTP 401) at ${path}.`,
      'Run `reppo auth --force` to mint a fresh token.',
    );
  }

  if (!response.ok) {
    const body = await safeJson(response);
    throw cliError(
      'PLATFORM_API_ERROR',
      `${path} returned HTTP ${response.status}: ${pickErr(body) ?? 'no body'}.`,
    );
  }

  return response.json() as Promise<T>;
}

// ── Internal helpers ───────────────────────────────────────────────────

async function safeJson(resp: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pickErr(body: Record<string, unknown> | null): string | undefined {
  if (!body) return undefined;
  return (body.error ?? body.message ?? body.detail) as string | undefined;
}
