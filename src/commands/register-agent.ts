/**
 * `reppo register-agent --name <s> --description <s>` — register a new
 * agent identity on the Reppo platform. Returns a persistent agent
 * id + accessToken + walletAddress on Base.
 *
 * Endpoint: `POST https://reppo.ai/api/v1/agents/register` (no auth).
 *
 * The Reppo platform exposes two distinct agent auth surfaces:
 *   - `reppo.ai/api/v1/agents/...` — uses the persistent `accessToken`
 *     returned by this command (Bearer header). Used for pod-metadata
 *     submissions and agent-scoped reads.
 *   - `api.reppo.xyz/...` — uses an EIP-191 wallet-signed 24h session
 *     token (separate `reppo auth` flow, lands in v0.2 of this CLI).
 *
 * Each call to /agents/register creates a NEW identity with a NEW
 * walletAddress. Re-registering does NOT recover a previous agent —
 * pods minted by the prior agent stay attributed to that prior
 * id/wallet. Save the returned credentials.
 *
 * The new walletAddress starts unfunded. Send ETH (gas) and REPPO
 * (publishing fee) to it before the agent attempts on-chain mints.
 *
 * Output schema:
 *   { id, accessToken, walletAddress }
 *
 * No private key required — registration is permissionless. The CLI's
 * REPPO_PRIVATE_KEY is unused here; the agent's wallet is provisioned
 * server-side and its credentials live in the accessToken.
 */
import { Option } from 'clipanion';
import { BaseCommand } from './_base.js';
import { cliError, emit } from '../output/format.js';

const COMMAND = 'register-agent';

// Hardcoded — the agents API lives at reppo.ai/api/v1, separate host from
// REPPO_API_URL (which points at api.reppo.xyz for wallet-auth-based calls).
// If/when those unify, replace with cfg.apiUrl + a path constant.
const AGENTS_API_BASE = 'https://reppo.ai/api/v1';

interface RegisterResponse {
  data?: {
    id?: string;
    accessToken?: string;
    walletAddress?: string;
  };
  // Some platform errors return { error: "..." } or { message: "..." }
  error?: string;
  message?: string;
}

export class RegisterAgentCommand extends BaseCommand {
  static override paths = [[COMMAND]];

  static override usage = BaseCommand.Usage({
    description: 'Register a new agent identity on the Reppo platform.',
    examples: [
      ['Register a new agent',
        'reppo register-agent --name "MyBot" --description "Posts pod summaries to X"'],
      ['JSON output (capture credentials programmatically)',
        'reppo register-agent --name "MyBot" --description "..." --json'],
    ],
  });

  agentName = Option.String('--name', { required: true, description: 'Display name for the agent' });
  description = Option.String('--description', { required: true, description: 'What the agent does' });

  async execute(): Promise<number> {
    try {
      const trimmedName = this.agentName.trim();
      const trimmedDesc = this.description.trim();
      if (!trimmedName) {
        throw cliError('INVALID_NAME', '--name must not be empty.');
      }
      if (!trimmedDesc) {
        throw cliError('INVALID_DESCRIPTION', '--description must not be empty.');
      }

      const url = `${AGENTS_API_BASE}/agents/register`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmedName, description: trimmedDesc }),
        });
      } catch (e) {
        // Network error (DNS, TLS, connection refused).
        throw cliError(
          'PLATFORM_API_UNREACHABLE',
          `Could not reach the Reppo platform at ${url}: ${(e as Error).message}.`,
          'Check your internet connection. If the platform is down, try again in a few minutes.',
        );
      }

      let body: RegisterResponse | null = null;
      try {
        body = (await response.json()) as RegisterResponse;
      } catch {
        // Non-JSON response. Surface as PLATFORM_API_ERROR with the raw status.
      }

      if (!response.ok) {
        const platformMsg = body?.error ?? body?.message ?? `HTTP ${response.status}`;
        throw cliError(
          'PLATFORM_API_ERROR',
          `Registration failed: ${platformMsg}`,
          `If the error persists, file an issue with the request body (name + description) and the HTTP status (${response.status}).`,
        );
      }

      const data = body?.data;
      if (!data?.id || !data.accessToken || !data.walletAddress) {
        throw cliError(
          'PLATFORM_API_INVALID_RESPONSE',
          `Reppo platform returned 200 but the response is missing expected fields (id, accessToken, walletAddress).`,
          'Capture the full HTTP response and file an issue.',
        );
      }

      const result = {
        id: data.id,
        accessToken: data.accessToken,
        walletAddress: data.walletAddress,
      };

      emit(result, [
        `✓ Registered new agent "${trimmedName}"`,
        ``,
        `  id:            ${data.id}`,
        `  walletAddress: ${data.walletAddress}`,
        `  accessToken:   ${data.accessToken}`,
        ``,
        `⚠ SAVE THESE CREDENTIALS NOW.`,
        `  - The accessToken is the agent's persistent credential — don't share it.`,
        `  - Re-running register-agent creates a NEW agent identity with a NEW walletAddress.`,
        `    Pods previously minted by an old agent stay attributed to the old wallet.`,
        `  - Fund ${data.walletAddress} with ETH (for gas) and REPPO (for publishing fees)`,
        `    before the agent attempts on-chain mints.`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}
