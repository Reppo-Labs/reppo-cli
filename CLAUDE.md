# reppo-cli — orientation for Claude Code agents

Command-line interface for [Reppo](https://reppo.ai) on Base. TypeScript ESM CLI, clipanion v4, viem 2.x for chain. Built primarily for AI agents — JSON output is the canonical interface; structured `{error: {code, hint?}}` on stderr is the public contract for failure handling.

Read this first when picking up the project. It's the durable map; commit history has the changes.

## Commands

```bash
npm run dev          # tsx src/bin.ts <args>     — run CLI in dev mode
npm run lint         # eslint src --max-warnings 0
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run test:coverage
npm run build        # tsc -p tsconfig.build.json — emits dist/bin.js
```

`prepublishOnly` runs lint → typecheck → test → build. CI runs the same matrix on Node 20+22 × Ubuntu+macOS.

## Env vars (read by `src/config/load.ts`)

| Var | When |
|---|---|
| `REPPO_PRIVATE_KEY` | All write commands |
| `REPPO_VOTER_PRIVATE_KEY` | `vote` only (separate from publisher EOA) |
| `REPPO_NETWORK` | `mainnet` (default) or `testnet` |
| `REPPO_RPC_URL` | Override RPC endpoint |
| `REPPO_API_URL` / `REPPO_API_KEY` | Reserved for `register-agent` / `create-datanet` (not yet implemented) |
| `REPPO_STATE_PATH` | Override `~/.reppo/cli-state.json` (used in tests) |

## Project shape

```
src/
  bin.ts                       # entry point — registers every command
  commands/
    _base.ts                   # BaseCommand (--network, --json, --rpc-url, loadConfig, handleError)
    vote.ts                    # canonical write command (peekIdempotent + two-phase)
    extend-lock.ts             # write — extend a veREPPO lockup
    grant-access.ts            # write — pay REPPO fee, grant datanet access
    lock.ts                    # write — stake REPPO into veREPPO
    mint-pod.ts                # write — branches on network (--share mainnet, --datanet testnet)
    claim-emissions.ts         # write — claim pod emissions for an epoch
    query/
      balance.ts               # canonical read command (uses tryX helpers)
      datanet.ts               # validity + REPPO fee + caller-access
      pod.ts                   # ownerOf, exists/owner
      voting-power.ts          # votingPowerOf + lockupCount
  chain/
    abis.ts                    # parseAbi'd ABIs — mainnet vs testnet PodManager param-variant
    addresses.ts               # pinned addresses per network; TBD placeholders
    contracts.ts               # throwing + tryX() helpers
    clients.ts                 # viem public + wallet client factories
    errors.ts                  # decodeRevert (selector → code+hint map)
  config/load.ts               # layered config: override > env > cwd > home > default
  output/format.ts             # cliError, emit, fail, setOutputMode
  state/
    db.ts                      # ~/.reppo/cli-state.json (proper-lockfile-serialized)
    idempotency.ts             # peekIdempotent + two-phase write protocol
# Unit tests are colocated as src/**/*.test.ts (vitest auto-discovers).
# An anvil-fork integration suite is on PR #8 (RPC-secret-blocked); not on main.
.claude/                       # automations — see below
.mcp.json                      # team-shared MCP servers (context7, github)
```

## Canonical patterns

When writing a new command, ALWAYS:

1. **Errors:** `cliError(code, message, hint?)` from `src/output/format.ts`. Never `Object.assign(new Error, { code, hint })`.

2. **Contract resolution:**
   - Read commands → `tryX()` (returns `null` for TBD networks; render `{ unavailable: "..." }`).
   - Write commands → throwing variant (must fail loud on TBD; never silently send to `0x0`).

3. **Address validation:** viem's `isAddress()`. Never hand-rolled `/^0x[0-9a-fA-F]{40}$/` regex.

4. **Idempotency cache decision:** `peekIdempotent<R>(key, command, args, isDryRun)` from `src/state/idempotency.ts`. Switch on `decision.kind`. Never inline the 5-state check.

5. **Two-phase write order:** `begin → writeContract → markSubmitted → waitForReceipt → markConfirmed/markFailed`. `markSubmitted` MUST persist BEFORE `waitForReceipt`.

6. **Dry-run isolation:** `peekIdempotent` skips the cache when `isDryRun=true`. Never write to the cache inside a dry-run branch.

7. **No type-cast assertions on viem returns:** `parseAbi` already infers `bigint`/`boolean`/`string`. `(v as bigint).toString()` is dead weight.

## The bug surface to be paranoid about

Three classes have produced production bugs:

- **mainnet vs testnet PodManager param-variant** — mainnet uses `mintPod(to, share)` (canonical production); testnet uses `mintPodWithREPPO(to, subnetId)` (forked from mainnet, subnet logic added for a client experiment). Same method family, different parameters. Use the helpers; never hardcode the ABI.
- **Decimals** — REPPO/veReppo/ETH are 18; USDC is 6. Mismatch silently shows wrong values.
- **Idempotency two-phase ordering** — past commits `6b9a227` and `091e45a` were both bugs here. The `markSubmitted-before-receipt-wait` invariant is the load-bearing one.

The `idempotency-reviewer` and `abi-pairing-reviewer` subagents catch these. Use them on any PR touching write commands or chain interaction.

## Workflow

- **Stacked PRs** are the norm — see `.claude/skills/stacked-pr/SKILL.md`. The `--onto` rebase is the surgical primitive.
- **`command-scaffold` skill** generates a new command file with the canonical patterns wired up. Use it for #5 sub-tasks.
- **CI**: 4-job matrix (Node 20+22 × Ubuntu+macOS) on every PR. Coverage uploaded from one canonical job. Integration tests behind `workflow_dispatch`.
- **Hooks** (in `.claude/settings.json`):
  - PostToolUse: ESLint `--fix` on edited TS files.
  - PreToolUse: blocks edits to `dist/`, `package-lock.json`, `coverage/`, `*/.reppo/cli-state.json`.

## Output contract (for agents using this CLI)

Every command supports `--json`. Output:
- **Success** → single JSON object on stdout, exit 0.
- **Failure** → `{error: {code, message, hint?}}` on stderr (always JSON regardless of `--json`), exit non-zero.

Match on `code`, never on `message`. Codes are stable; messages can drift.

## Reference

- **Issue #5** — the 13-commands epic. 8/13 shipped; the 5 blocked (`unlock` — no withdraw ABI; `create-datanet` + `register-agent` — need platform API spec; `query emissions-due` — needs pod enumeration; `swap` — Uniswap V3 multi-tx scope) are documented in [issue #5 comments](https://github.com/Reppo-Labs/reppo-cli/issues/5).
- **README.md** — user-facing CLI docs; status line lists what's actually shipped.
- **`src/chain/abis.ts:5-10`** — comment explaining the mainnet vs testnet param variant.
- **`src/state/idempotency.ts`** — top-of-file comment is the protocol spec.
- **`src/commands/vote.ts`** — canonical write command; reference for new write implementations.
- **`src/commands/query/balance.ts`** — canonical read command; reference for new read implementations.
