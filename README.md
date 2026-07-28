# @reppo/cli

Command-line interface for [Reppo](https://reppo.ai) — mint pods, vote, lock REPPO, manage datanets. Built for **AI agents** as the primary user, but humans can use it too.

> **Status:** v0.4.0 — fully wired against PodManager V2 on mainnet. Shipped: `approve`, `auth`, `query balance`, `query datanet`, `query epoch`, `query emissions-due`, `query pod`, `query voting-power`, `list datanets`, `list pods` (incl. `--all`), `claim-emissions`, `extend-lock`, `grant-access`, `lock`, `mint-pod`, `register-agent`, `unlock`, `vote`. Remaining 2 commands (`create-datanet`, `swap`) are scaffolded but not yet wired.

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
| `REPPO_NETWORK` | All commands (optional) | `mainnet` (default), `testnet`, or `robinhood` |
| `REPPO_RPC_URL` | All commands (optional) | Override RPC endpoint |
| `REPPO_API_URL` | Platform-API commands (optional) | Override Reppo API base |
| `REPPO_API_KEY` | `register-agent`, `create-datanet` | Reppo platform API key |
| `REPPO_AGENT_ID` | `mint-pod` Phase-2 publishing | Agent id from `register-agent`; identifies the `/agents/{id}/pods` POST |
| `REPPO_AGENT_API_KEY` | `mint-pod` Phase-2 publishing (optional) | Agent Bearer key from `register-agent`; falls back to `REPPO_API_KEY` |
| `PINATA_JWT` | `mint-pod --dataset` (optional) | Pinata JWT for pinning a dataset to IPFS before publishing |

Network can also be set per-call via `--network mainnet|testnet|robinhood`.

### Robinhood Chain (`--network robinhood`)

Robinhood Chain mainnet (chain id 4663) runs the RBV1 contract variant, which differs from Base:

- **Fees are paid in each datanet's own token** (e.g. PAW, PONS) — there is no REPPO or USDC
  on the chain. `mint-pod` and `grant-access` resolve the fee token on-chain and auto-approve it;
  the `--token` flag does not apply.
- **No staking**: `lock` / `extend-lock` / `unlock` error with `UNSUPPORTED_ON_NETWORK`. Voting
  power is mirrored from your **Base** veREPPO position — lock on Base, then sync at
  [robinhood.reppo.ai](https://robinhood.reppo.ai).
- **Catalog** comes from `robinhood.reppo.ai` (`list datanets`, `query datanet` metadata).
- **Platform-API commands** (`auth`, `list pods`, `query emissions-due`, mint-pod Phase-2
  publishing) are not available — the robinhood platform has no wallet-authed API yet.

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
- `reppo query datanet <datanetId> [--for <addr>]` — on-chain validity + REPPO access fee (`accessFeeREPPO`) and, for datanets that charge in their own token, the primary-token access fee (`accessFeePrimaryToken` + `primaryToken: { address, symbol, decimals }` — present only for a real non-zero primary token; best-effort — `{ unavailable }` with distinct wording for "datanet has no primary token" vs a read failure) (optionally check access for an address) + the current on-chain epoch, plus off-chain catalog metadata: name, description, native token (symbol/address/decimals), per-epoch emissions, vote volumes, publisher/voter onboarding guidance, and the platform `subnetUuid` (the `--subnet-uuid` for `mint-pod` publishing). Catalog enrichment is best-effort — a platform outage degrades `metadata` to `{ unavailable }` without affecting the on-chain answer.
- `reppo query epoch` — current on-chain epoch, read directly from `veReppo.currentEpoch()` (the protocol's epoch time-base). JSON: `{ network, epoch, epochStart, epochDurationSeconds, secondsRemaining }`. Epochs are fixed ~48h windows; the timing fields are derived from `epochEnd`/`epochLength` and degrade to `null` if those getters are unavailable. Pure read — no signer, no gas. Honor `--rpc-url` against a private RPC (the public Base RPC rate-limits).
- `reppo query emissions-due` — list unclaimed REPPO emissions across all pods owned by the configured wallet (uses platform API)

### List

- `reppo list datanets [--status ACTIVE|ALL] [--token-symbol <sym>] [--limit <n>]` — list all datanets on the platform (public endpoint, no auth required)
- `reppo list pods [--datanet <id>] [--include-emissions] [--limit <n>]` — list pods owned by the configured wallet, optionally scoped to a single datanet (uses platform API)
- `reppo list pods --all [--datanet <id>] [--limit <n>]` — list pods published by *any* wallet, so a voter can discover pods to vote on (public endpoint, no auth required); each row's `podId` feeds straight into `reppo vote --pod <podId>`

### Write

- `reppo approve --spender <pod-manager|subnet-manager|ve-reppo|0x…> [--amount <units|max>] [--token reppo|usdc|0x…]` — set an ERC20 allowance so subsequent writes (lock, grant-access, mint-pod) don't fail with INSUFFICIENT_ALLOWANCE. `--token` accepts the `reppo`/`usdc` aliases or an arbitrary ERC20 token address (0x…) — e.g. a datanet's primary token, so an operator can approve it for the SubnetManager; for an address the token's `decimals()` is read on-chain for amount scaling. Defaults to unlimited (`max`); reads the current allowance first and emits `{status:'no-op'}` if it already covers the request.
- `reppo vote --pod <id> --votes <n> --like|--dislike` — cast a vote on a pod, spending `<n>` voting power
- `reppo mint-pod --datanet <id> [--token reppo|primary] [--to <addr>]` — mint a pod into a datanet. Add `--pod-name <s>` to also publish metadata (Phase 2): after the on-chain mint, register the pod with the platform (`POST /agents/{id}/pods`). Requires `--subnet-uuid <cuid>` (the platform UUID, **not** the numeric `--datanet` id), `--agree-to-terms`, and `REPPO_AGENT_ID` + agent key. Optionally `--pod-description`, `--category`, `--platform`, `--url`, and a dataset: `--dataset <file>` (pinned to IPFS via `PINATA_JWT`) or `--dataset-uri <url>` (used as-is). A Phase-2 failure does not fail the mint — it exits 0 with `metadata.published:false`; re-run with the same `--idempotency-key` to retry.
- `reppo lock <amount> --duration <seconds>` — lock REPPO into veREPPO for voting power. Auto-approves veREPPO for REPPO when the allowance is short (no manual `approve` needed); emits `autoApproveTx` when it does.
- `reppo unlock <lockupId> [--to <addr>]` — withdraw an expired veREPPO lockup, returning the locked REPPO
- `reppo extend-lock <lockupId> --duration <seconds>` — extend an existing veREPPO lockup
- `reppo grant-access --datanet <id> [--to <addr>] [--token reppo|primary]` — pay the datanet access fee and grant `--to` access. Defaults to REPPO; `--token primary` pays in the datanet's primary token (e.g. $EXY). Auto-approves the SubnetManager for the fee token when the allowance is short (no manual `approve` needed); emits `autoApproveTx` when it does. Output: `feeAmount` (on-chain fee quote), `feePaid` (receipt-derived actual), `feeToken: { symbol, address, decimals }`, and `token`. On the REPPO path the legacy `reppoFee` field is also emitted for back-compat (pre-0.8.5 consumers).
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
