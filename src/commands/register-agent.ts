/**
 * `reppo register-agent --name <s> --description <s> [--is-orquestra]` —
 * register a new agent identity on the Reppo platform. Returns a
 * persistent agent id + apiKey (Bearer token).
 *
 * `--is-orquestra` marks the agent as an Orquestra swarm node. The platform
 * then resolves ON-CHAIN pod ids on the agent-scoped endpoints — without it,
 * POST /agents/[id]/pods/[POD_ID]/votes only accepts platform pod ids
 * (pod_...), so on-chain vote registration fails with 404 "Pod not found".
 *
 * Endpoint: `POST https://reppo.ai/api/v1/agents/register` (no auth).
 * Spec: https://docs.reppo.ai/api/agent/custom-agents
 *
 * Two distinct agent auth surfaces on the platform:
 *   - `reppo.ai/api/v1/agents/...` — uses the persistent `apiKey`
 *     returned by this command (Bearer header). Used for the
 *     agent-scoped endpoints (POST /agents/[id]/subnets, /pods).
 *   - `api.reppo.xyz/...` — Privy / wallet-auth flow (`reppo auth`).
 *
 * Each call to /agents/register creates a NEW identity. Re-registering
 * does NOT recover a previous agent — save the returned credentials.
 *
 * No private key required for registration itself — it's permissionless.
 * The agent's on-chain wallet for minting is the user's own
 * REPPO_PRIVATE_KEY; the platform no longer provisions one server-side.
 * After an on-chain mint, the agent calls the agent-scoped /pods or
 * /subnets endpoint with the resulting txHash to register metadata.
 *
 * Output schema:
 *   { id, apiKey }
 */
import { Option } from 'clipanion';
import { BaseCommand } from './_base.js';
import { cliError, emit } from '../output/format.js';
import { agentsApiBase } from '../api/agents.js';

const COMMAND = 'register-agent';

interface RegisterResponse {
  data?: {
    id?: string;
    apiKey?: string;
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
      ['Register an Orquestra node agent (on-chain pod ids on /votes)',
        'reppo register-agent --name "my-node" --description "Orquestra swarm node" --is-orquestra'],
    ],
  });

  agentName = Option.String('--name', { required: true, description: 'Display name for the agent' });
  description = Option.String('--description', { required: true, description: 'What the agent does' });
  isOrquestra = Option.Boolean('--is-orquestra', false, {
    description: 'Register as an Orquestra node agent — the platform then resolves on-chain pod ids on the agent endpoints (required for vote registration)',
  });

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

      // Per-network platform: robinhood agents register on robinhood.reppo.ai
      // (agent ids/apiKeys are per-platform). This command doesn't loadConfig —
      // it reads flags/env directly — so mirror BaseCommand's network precedence.
      const url = `${agentsApiBase(this.network ?? process.env.REPPO_NETWORK)}/agents/register`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // isOrquestra only when set — the platform defaults it to false, and
          // omitting it keeps the body byte-identical for existing callers.
          body: JSON.stringify({
            name: trimmedName,
            description: trimmedDesc,
            ...(this.isOrquestra ? { isOrquestra: true } : {}),
          }),
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
      if (!data?.id || !data.apiKey) {
        throw cliError(
          'PLATFORM_API_INVALID_RESPONSE',
          `Reppo platform returned 200 but the response is missing expected fields (id, apiKey).`,
          'Capture the full HTTP response and file an issue.',
        );
      }

      const result = {
        id: data.id,
        apiKey: data.apiKey,
      };

      emit(result, [
        `✓ Registered new agent "${trimmedName}"`,
        ``,
        `  id:     ${data.id}`,
        `  apiKey: ${data.apiKey}`,
        ``,
        `⚠ SAVE THESE CREDENTIALS NOW.`,
        `  - The apiKey is the agent's persistent Bearer token — don't share it.`,
        `  - Re-running register-agent creates a NEW agent identity. Pods previously`,
        `    registered by an old agent stay attributed to that old id.`,
        `  - On-chain mints use your REPPO_PRIVATE_KEY wallet. After minting, the`,
        `    platform expects an /agents/${data.id}/{pods,subnets} call with the`,
        `    resulting txHash to register the metadata.`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}
