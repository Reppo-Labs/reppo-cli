<!-- Generated: 2026-05-25 | Files scanned: 31 | Token estimate: ~700 -->

# Architecture

`@reppo/cli` v0.4.0 — TypeScript ESM CLI for the Reppo protocol on Base.
Built primarily for AI agents; JSON output + stable error codes are the public contract.

## Shape
Single-package CLI (no monorepo, no frontend, no DB). Dispatch via clipanion v4.
On-chain RW via viem 2.x. Persistent state is a single JSON file under `~/.reppo/`.

## Layers
```
        ┌─────────────────────────────────────────┐
 entry  │ src/bin.ts (clipanion CLI registry)     │
        └────────────────┬────────────────────────┘
                         │ subcommand dispatch
        ┌────────────────▼────────────────────────┐
 cmd    │ src/commands/*.ts (one per subcommand)  │
        │   _base.ts: shared flags + handleError  │
        └──┬───────────────┬───────────────┬──────┘
           │               │               │
       ┌───▼───┐       ┌───▼───┐      ┌────▼─────┐
chain  │chain/ │  api  │ api/  │ state│ state/   │
       │viem   │       │ HTTP  │      │ JSON+lock│
       └───┬───┘       └───┬───┘      └──────────┘
           │               │
       Base RPC      reppo.ai +
                     api.reppo.xyz
```

## Entry & dispatch
- `src/bin.ts` — registers all 16 commands + clipanion builtins (help/version).
- `src/commands/_base.ts` — `BaseCommand` (44 lines): exposes `--network`, `--json`, `--rpc-url`; provides `loadConfig()` and `handleError()`.

## Public surfaces
| Channel | Contract |
|---|---|
| stdout success | Single JSON object, exit 0 |
| stderr failure | `{error:{code,message,hint?}}`, exit non-zero, always JSON |
| `--json` | Suppresses human-formatted lines; JSON only |

Match on `code` (stable), never `message` (may drift).

## Cross-cutting modules
| Module | Role |
|---|---|
| `src/output/format.ts` | `cliError`, `emit`, `fail`, output-mode flag |
| `src/config/load.ts` | Layered config: flag > env > cwd > home > default |
| `src/state/idempotency.ts` | Two-phase write protocol (begin → markSubmitted → markConfirmed/Failed) |
| `src/state/db.ts` | JSON file at `~/.reppo/cli-state.json`, proper-lockfile-serialized |
| `src/chain/receipt.ts` | `waitForWriteReceipt` — maps viem timeout → `TX_RECEIPT_TIMEOUT` |
| `src/commands/write-cache.ts` | `handleSubmittedCacheDecision` — auto-reconciles `submitted`→`confirmed` on retry |

## Networks
`mainnet` (default) and `testnet`, both on Base. Addresses pinned per network in `src/chain/addresses.ts`; placeholder entries throw on write, return `null` via `tryX()` on read.

## See also
- `backend.md` — command-by-command map.
- `data.md` — state schema and idempotency protocol.
- `dependencies.md` — external endpoints and packages.
