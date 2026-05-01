# @reppo-labs/cli

Command-line interface for [Reppo](https://reppo.ai) — mint pods, vote, lock REPPO, manage datanets. Built for **AI agents** as the primary user, but humans can use it too.

> **Status:** v0.1.0-alpha. The query + vote + lock commands ship in alpha. The remaining 12 commands are scaffolded but not yet wired.

## Install

```bash
npm i -g @reppo-labs/cli
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
- `reppo query voting-power [address]` *(planned)*
- `reppo query pod <podId>` *(planned)*
- `reppo query subnet <subnetId>` *(planned)*
- `reppo query emissions-due [address]` *(planned)*

### Write

- `reppo vote --pod <id> --subnet <id> --like|--dislike` — cast an on-chain vote
- `reppo mint-pod --subnet <id>` *(planned)*
- `reppo lock <amount> --duration <seconds>` *(planned)*
- `reppo unlock <lockupId>` *(planned)*
- `reppo extend-lock <lockupId> --duration <seconds>` *(planned)*
- `reppo grant-access --subnet <id> [--to <addr>]` *(planned)*
- `reppo claim-emissions --pod <id> [--epoch <n>]` *(planned)*
- `reppo create-datanet --name <s> --token <addr> --fee <reppo>` *(planned)*
- `reppo register-agent --name <s> --description <s>` *(planned)*
- `reppo swap <from> <to> --amount <n>` *(planned, mainnet only)*

## Idempotency

Every write command accepts `--idempotency-key <stable-string>`. The CLI caches the result (in `~/.reppo/cli-state.db`); repeat calls with the same key skip signing and return the prior tx hash. Critical for agent retry loops.

## Dry run

Every write command accepts `--dry-run`. Simulates via `eth_call`, decodes custom errors, returns gas estimate. Exits 0 if would succeed, non-zero with a structured error if would revert.

## Claude Code skill

Also available as a Claude Code skill that teaches agents how to invoke this CLI:

```bash
claude plugin install reppo
```

The skill ships with the same v0.1.0 alpha feature subset.

## License

MIT — see [LICENSE](./LICENSE).
