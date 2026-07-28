/**
 * Reppo public API helpers (reppo.ai).
 *
 * Unauthenticated read-only endpoints exposed by the Reppo dashboard,
 * distinct from the wallet-authed platform API at api.reppo.xyz. No
 * Bearer token, no signature — just `fetch`.
 *
 * Kept separate from `src/api/platform.ts` so callers can't accidentally
 * route a public-API request through `platformGet`, which requires a
 * session token.
 *
 * Base URL resolution:
 *   1. explicit `baseUrl` arg (caller-supplied / env override)
 *   2. DEFAULT_PUBLIC_API_URL
 *
 * The `REPPO_PUBLIC_API_URL` env override is read at the call site, not
 * threaded through `config/load.ts`, to keep the config plumbing scope
 * minimal for now.
 */
import { cliError } from '../output/format.js';

export const DEFAULT_PUBLIC_API_URL = 'https://reppo.ai';

/** Robinhood datanets live in a separate catalog served by robinhood.reppo.ai
 *  (same /api/v1/public/* DTO shape; fee fields are single-token variants). */
export const ROBINHOOD_PUBLIC_API_URL = 'https://robinhood.reppo.ai';

/** Per-network public catalog base. The reppo.ai catalog only knows Base
 *  mainnet datanets; robinhood rows come from robinhood.reppo.ai. */
export function defaultPublicApiUrl(network?: string): string {
  return network === 'robinhood' ? ROBINHOOD_PUBLIC_API_URL : DEFAULT_PUBLIC_API_URL;
}

/**
 * Unauthenticated GET against the Reppo public API. Returns parsed JSON
 * or throws `PUBLIC_API_*` on transport / non-2xx / parse failures.
 *
 * Mirrors the error-shape conventions of `platformGet` in `platform.ts`:
 *   - PUBLIC_API_UNREACHABLE — network error (fetch threw)
 *   - PUBLIC_API_ERROR       — non-2xx HTTP response
 *   - PUBLIC_API_INVALID_RESPONSE — 2xx but body wasn't JSON
 */
export async function publicGet<T>(baseUrl: string | undefined, path: string): Promise<T> {
  const resolved = (baseUrl ?? DEFAULT_PUBLIC_API_URL).replace(/\/+$/, '');
  const url = `${resolved}${path}`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (e) {
    throw cliError(
      'PUBLIC_API_UNREACHABLE',
      `Could not reach ${url}: ${(e as Error).message}.`,
      'Check your internet connection. If reppo.ai is down, try again in a few minutes.',
    );
  }

  if (!response.ok) {
    const body = await safeJson(response);
    throw cliError(
      'PUBLIC_API_ERROR',
      `${path} returned HTTP ${response.status}: ${pickErr(body) ?? 'no body'}.`,
    );
  }

  try {
    return (await response.json()) as T;
  } catch (e) {
    throw cliError(
      'PUBLIC_API_INVALID_RESPONSE',
      `${path} returned 200 but the body was not valid JSON: ${(e as Error).message}.`,
    );
  }
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
