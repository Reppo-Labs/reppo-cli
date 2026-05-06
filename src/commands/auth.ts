/**
 * `reppo auth` — sign in to the Reppo platform API (api.reppo.xyz).
 *
 * The platform API uses two-step EIP-191 wallet auth:
 *   1. POST /auth/nonce  { walletAddress } → { nonce, message }
 *   2. POST /auth/verify { walletAddress, signature, nonce } → { token, ... }
 *
 * The returned token is a 24h Bearer credential. Cached in
 * ~/.reppo/cli-state.json under sessions[`${network}:reppo-platform`].
 * Subsequent commands that hit api.reppo.xyz (e.g. `query emissions-due`)
 * read this cache and refresh on expiry.
 *
 * `reppo auth` is idempotent — if a valid cached token exists for the
 * caller's wallet, it returns the existing session without re-signing.
 * Pass `--force` to mint a fresh token regardless.
 *
 * NB: this command does NOT touch reppo.ai/api/v1/agents/* (a separate
 * service with persistent tokens issued by `register-agent`).
 */
import { Option } from 'clipanion';
import { privateKeyToAccount } from 'viem/accounts';
import { BaseCommand } from './_base.js';
import { cliError, emit } from '../output/format.js';
import { getOrRefreshSession, signInWithEthereum } from '../api/platform.js';
import { getSession, saveSession } from '../state/db.js';

const SESSION_KEY = 'reppo-platform' as const;

export class AuthCommand extends BaseCommand {
  static override paths = [['auth']];

  static override usage = BaseCommand.Usage({
    description: 'Sign in to the Reppo platform API (api.reppo.xyz). Caches a 24h session token.',
    examples: [
      ['Sign in (no-op if cached token is still valid)',
        'reppo auth'],
      ['Force a fresh sign-in even if cached token is valid',
        'reppo auth --force'],
      ['JSON output (capture token expiry programmatically)',
        'reppo auth --json'],
    ],
  });

  force = Option.Boolean('--force', false, { description: 'Re-sign even if a valid cached token exists' });

  async execute(): Promise<number> {
    try {
      const cfg = this.loadConfig();
      const pk = cfg.privateKey;
      if (!pk) {
        throw cliError(
          'MISSING_PRIVATE_KEY',
          'No signing key available.',
          'Set REPPO_PRIVATE_KEY in env. The platform API requires a wallet signature to sign in.',
        );
      }

      if (this.force) {
        // Bypass cache: sign fresh, save fresh, emit.
        const account = privateKeyToAccount(pk);
        const apiUrl = cfg.apiUrl ?? 'https://api.reppo.xyz';
        const fresh = await signInWithEthereum(apiUrl, account);
        await saveSession(cfg.network, SESSION_KEY, fresh);
        return this.emitSession(fresh, /*refreshed=*/true);
      }

      // Default: get-or-refresh — uses cached token when valid.
      const before = await getSession(cfg.network, SESSION_KEY);
      const session = await getOrRefreshSession(cfg.network, cfg.apiUrl, pk);
      const refreshed = !before || before.accessToken !== session.accessToken;
      return this.emitSession(session, refreshed);
    } catch (err) {
      this.handleError(err);
    }
  }

  private emitSession(session: { accessToken: string; walletAddress: string | null; expiresAt?: number }, refreshed: boolean): number {
    const expiresAtMs = session.expiresAt ?? 0;
    const expiresAtIso = expiresAtMs ? new Date(expiresAtMs).toISOString() : null;
    const remainingSec = expiresAtMs ? Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000)) : null;

    emit(
      {
        walletAddress: session.walletAddress,
        expiresAt: expiresAtIso,
        remainingSeconds: remainingSec,
        refreshed,
        // accessToken intentionally omitted from the canonical output —
        // it lives in ~/.reppo/cli-state.json and is read by subsequent
        // commands. Emitting it here would be a foot-gun (logs, screen
        // shares). Pass --json + parse cli-state.json directly if you
        // need the raw token.
      },
      [
        refreshed ? `✓ Signed in (fresh token)` : `✓ Signed in (cached token still valid)`,
        `  wallet:    ${session.walletAddress}`,
        expiresAtIso ? `  expiresAt: ${expiresAtIso} (${remainingSec}s remaining)` : `  expiresAt: (unknown)`,
        ``,
        `  Token cached in ~/.reppo/cli-state.json. Subsequent commands hitting`,
        `  api.reppo.xyz (e.g. \`reppo query emissions-due\`) will use it automatically.`,
      ],
    );
    return 0;
  }
}
