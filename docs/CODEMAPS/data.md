<!-- Generated: 2026-05-25 | Files scanned: 3 | Token estimate: ~700 -->

# Data

No database. The only persistent store is a single JSON file under the user's home.

## State file
- **Path:** `~/.reppo/cli-state.json` (overridable via `REPPO_STATE_PATH`, used in tests).
- **Concurrency:** every read-modify-write is wrapped in `withLockedState`, which acquires a `proper-lockfile` lock on the file path before reading. Concurrent CLI invocations queue.
- **Permissions:** mode `0600` (chmod after create).
- **Single source:** `src/state/db.ts`.

## Schema
```ts
{
  idempotency: { [key]: IdempotencyEntry },
  sessions:    { [`${network}:${name}`]: SessionEntry }
}
```

### `IdempotencyEntry`
| Field | Type | Notes |
|---|---|---|
| `command` | `string` | Command path, e.g. `vote`, `mint-pod`. |
| `argsFingerprint` | `string` | SHA-256 of canonicalized args. Detects same-key reuse with different intent → `IDEMPOTENCY_ARGS_MISMATCH`. |
| `status` | `'pending' \| 'submitted' \| 'confirmed' \| 'failed'` | Two-phase state machine. |
| `result` | `Record<string,unknown>` | Command-specific payload (rich object on confirm; partial on submitted). |
| `txHash` | `string \| null` | Set on `submitted` / `confirmed` / `failed`-after-broadcast. |
| `createdAt` / `updatedAt` | `number` | Epoch ms. |

### `SessionEntry`
| Field | Type | Notes |
|---|---|---|
| `agentId` | `string?` | Set for `/api/v1/agents/*` persistent tokens. |
| `accessToken` | `string` | Bearer token. |
| `walletAddress` | `string \| null` | EOA bound to the session. |
| `expiresAt` | `number?` | Epoch ms; set for `api.reppo.xyz` 24h tokens. |
| `createdAt` | `number` | Epoch ms. |

## Idempotency state machine (protocol)
```
                begin()
   (none) ────────────────────> pending
                                  │
                                  │ markSubmitted(txHash, result?)
                                  ▼
                               submitted ──────┐
                                  │            │ peekIdempotent on retry
                                  │            │  → handleSubmittedCacheDecision
                                  │            │  → reconcile via getTransactionReceipt
                                  │            ▼
                                  │         confirmed (terminal)
                                  │
                  markFailed()────┴─────> failed
```

- `pending` older than `PENDING_STALE_MS` (10 min) is treated as stale and `peekIdempotent` returns `{kind:'proceed'}` — recovery path for crashes between `begin` and `markSubmitted`.
- `confirmed` is terminal: re-upsert throws `IDEMPOTENCY_TERMINAL_STATE`.
- `failed` may be retried under a fresh key (caller policy).
- See `src/state/idempotency.ts` top-of-file comment — the protocol spec.

## Chain reads (transient — not persisted)
On every command run, view calls are made fresh via viem `publicClient`. There is no chain-data cache. See `chain/contracts.ts` for the `throwing` / `tryX` helper pairs.

## Migrations
None. Schema is forward-compatible (unknown keys preserved on round-trip). Test setups override `REPPO_STATE_PATH` to isolate from the user's real cache.
