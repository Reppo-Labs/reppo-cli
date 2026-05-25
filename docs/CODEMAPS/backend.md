<!-- Generated: 2026-05-25 | Files scanned: 17 commands | Token estimate: ~950 -->

# Commands

CLI dispatch table. Each row: `path → command file → primary chain/api target`.

## Write commands (RPC + signing, idempotency-aware)
| Subcommand | File | Target | Notes |
|---|---|---|---|
| `vote` | `commands/vote.ts` | `PodManager.vote(podId, votes, upVote)` | Uses `REPPO_VOTER_PRIVATE_KEY` (separate EOA). Canonical write reference. |
| `lock` | `commands/lock.ts` | `veReppo.lock(amount, duration)` | Stakes REPPO into veREPPO. |
| `extend-lock` | `commands/extend-lock.ts` | `veReppo.extendLockup(id, duration)` | Lockup extension. |
| `unlock` | `commands/unlock.ts` | `veReppo.withdraw(lockupId)` | Withdraw expired lockup. |
| `grant-access` | `commands/grant-access.ts` | `PodManager.grantAccess` + `SubnetManager.getAccessFeeREPPO` | Pays REPPO fee for datanet access. |
| `mint-pod` | `commands/mint-pod.ts` | `PodManager.mintPodWithREPPO / mintPodWithPrimaryToken` | V2 unified shape on both networks. |
| `claim-emissions` | `commands/claim-emissions.ts` | `PodManager.claimEmissions(epoch, podId)` | Per-epoch claim. |
| `register-agent` | `commands/register-agent.ts` | HTTP `POST reppo.ai/api/v1/agents/register` | Permissionless; returns `{id, apiKey}`. No private key. |
| `auth` | `commands/auth.ts` | `api/platform.ts` (Privy SIWE) | Persists session for `api.reppo.xyz` calls. |

## Read commands (chain views, no signing)
| Subcommand | File | Target |
|---|---|---|
| `query balance` | `commands/query/balance.ts` | REPPO + veREPPO + USDC + ETH balances. Canonical read reference. |
| `query voting-power` | `commands/query/voting-power.ts` | `veReppo.votingPowerOf` + `lockupCount` |
| `query pod` | `commands/query/pod.ts` | `PodManager.ownerOf` / `exists` |
| `query datanet` | `commands/query/datanet.ts` | Validity + REPPO fee + caller-access |
| `query emissions-due` | `commands/query/emissions-due.ts` | Pending emissions per pod/epoch |

## List commands (Reppo public API)
| Subcommand | File | Target |
|---|---|---|
| `list datanets` | `commands/list/datanets.ts` | `GET reppo.ai/...` catalog |
| `list pods` | `commands/list/pods.ts` | Catalog with `--datanet <id>` filter and `--all` community-pod scan |

## Standard call chain
```
bin.ts → CommandClass.execute()
  → BaseCommand.loadConfig()                       (config/load.ts)
  → peekIdempotent(key, cmd, args, isDryRun)       (state/idempotency.ts)   [WRITE only]
    ├─ proceed       → continue
    ├─ return-confirmed → emit cached, exit 0
    ├─ return-submitted → handleSubmittedCacheDecision (commands/write-cache.ts)
    └─ refuse/mismatch  → throw cliError
  → contract helper                                 (chain/contracts.ts: throwing or tryX)
  → begin → writeContract → markSubmitted          (state/idempotency.ts)
  → waitForWriteReceipt                            (chain/receipt.ts)
  → markConfirmed | markFailed                     (state/idempotency.ts)
  → emit(result, humanLines?)                      (output/format.ts)
  catch err → handleError → fail({code,message,hint}) on stderr, exit non-zero
```

## Shared error codes (selection)
| Code | Source | Meaning |
|---|---|---|
| `TX_RECEIPT_TIMEOUT` | `chain/receipt.ts` | Receipt wait timed out; retry with `--idempotency-key` to reconcile |
| `TX_REVERTED` | `chain/errors.ts` decodeRevert | On-chain revert; selector decoded when known |
| `IDEMPOTENCY_IN_FLIGHT` | `state/idempotency.ts` | `pending` entry not stale; another invocation mid-flight |
| `IDEMPOTENCY_ARGS_MISMATCH` | `state/idempotency.ts` | Same key used with different intent |
| `IDEMPOTENCY_TERMINAL_STATE` | `state/db.ts` | Attempted upsert on `confirmed` entry |
| `PLATFORM_API_*` | `api/platform.ts`, `register-agent.ts` | Reppo platform HTTP failure |

## Canonical patterns for new commands
See `CLAUDE.md` "Canonical patterns" (1-9). Reference implementations: `commands/vote.ts` (write), `commands/query/balance.ts` (read).
