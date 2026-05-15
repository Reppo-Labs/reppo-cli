# @reppo/cli

Command-line interface for [Reppo](https://reppo.ai) — mint pods, vote, lock REPPO, manage datanets. Built for **AI agents** as the primary user, but humans can use it too.

> **Status:** v0.3.0 — fully wired against PodManager V2 on mainnet. Shipped: `auth`, `query balance`, `query datanet`, `query emissions-due`, `query pod`, `query voting-power`, `list datanets`, `list pods`, `claim-emissions`, `extend-lock`, `grant-access`, `lock`, `mint-pod`, `register-agent`, `unlock`, `vote`. Remaining 2 commands (`create-datanet`, `swap`) are scaffolded but not yet wired.

## Install

```bash
npm i -g @reppo/cli
```

Requires Node ≥20.

## Authentication

The CLI is non-interactive — all credentials come from environment variables:

| Variable | Required for | Description |
|---|---|---|
| `REPPO_PRIVATE_KEY` | All write commands | EOA private key (32-byte hex) |
| `REPPO_VOTER_PRIVATE_KEY` | `vote` (optional) | Separate EOA for voting (publishers cannot vote on their own pods) |
| `REPPO_NETWORK` | All commands (optional) | `mainnet` (default) or `testnet` |
| `REPPO_RPC_URL` | All commands (optional) | Override RPC endpoint |
| `REPPO_API_URL` | Platform-API commands (optional) | Override Reppo API base |
| `REPPO_API_KEY` | `register-agent`, `create-datanet` | Reppo platform API key |

Network can also be set per-call via `--network mainnet|testnet`.

## Output

All commands run in human-readable mode by default. Pass `--json` to emit a single JSON object per command on stdout — agents should always pass this.

Errors **always** emit JSON on stderr regardless of mode, with a stable `code` field:

```json
{ "error": { "code": "INSUFFICIENT_VOTING_POWER", "message": "...", "hint": "Run `reppo lock <amount> --duration 7200` first." } }
```

## Commands

### Read

- `reppo query balance [address]` — ETH + REPPO + veREPPO + USDC
- `reppo query voting-power [address]` — veREPPO voting power + lockup count
- `reppo query pod <podId>` — pod existence + owner address
- `reppo query datanet <datanetId> [--for <addr>]` — validity + REPPO access fee, optionally check access for an address
- `reppo query emissions-due` — list unclaimed REPPO emissions across all pods owned by the configured wallet (uses platform API)

### List

- `reppo list datanets [--status ACTIVE|ALL] [--token-symbol <sym>] [--limit <n>]` — list all datanets on the platform (public endpoint, no auth required)
- `reppo list pods [--datanet <id>] [--include-emissions] [--limit <n>]` — list pods owned by the configured wallet, optionally scoped to a single datanet (uses platform API)

### Write

- `reppo vote --pod <id> --votes <n> --like|--dislike` — cast a vote on a pod, spending `<n>` voting power
- `reppo mint-pod --datanet <id> [--token reppo|primary] [--to <addr>]` — mint a pod into a datanet
- `reppo lock <amount> --duration <seconds>` — lock REPPO into veREPPO for voting power
- `reppo unlock <lockupId> [--to <addr>]` — withdraw an expired veREPPO lockup, returning the locked REPPO
- `reppo extend-lock <lockupId> --duration <seconds>` — extend an existing veREPPO lockup
- `reppo grant-access --datanet <id> [--to <addr>]` — pay the REPPO access fee and grant `--to` access to a datanet
- `reppo claim-emissions --pod <id> --epoch <n>` — claim a pod's emissions for an epoch
- `reppo register-agent --name <s> --description <s>` — register a new agent identity on the Reppo platform; returns `{ id, apiKey }`. The apiKey is the Bearer token for subsequent agent-scoped calls (`/agents/[id]/subnets`, `/agents/[id]/pods`). On-chain mints use your `REPPO_PRIVATE_KEY` wallet; the platform no longer provisions one server-side.
- `reppo auth [--force]` — sign in to the platform API (api.reppo.xyz); caches a 24h Bearer token used by `query emissions-due` and other platform-API commands
- `reppo create-datanet ...` *(planned — currently dashboard-only; the REST endpoint requires a Privy session cookie which is browser auth)*
- `reppo swap <from> <to> --amount <n>` *(planned, mainnet only)*

## Idempotency

Every write command accepts `--idempotency-key <stable-string>`. The CLI caches the result (in `~/.reppo/cli-state.json`); repeat calls with the same key skip signing and return the prior tx hash. Critical for agent retry loops.

## Dry run

Every write command accepts `--dry-run`. Simulates via `eth_call`, decodes custom errors, returns gas estimate. Exits 0 if would succeed, non-zero with a structured error if would revert.

## Claude Code skill

Also available as a Claude Code skill that teaches agents how to invoke this CLI:

```bash
claude plugin install reppo
```

The skill ships with the same v0.3.0 feature subset.

## License

MIT — see [LICENSE](./LICENSE).
