<!-- Generated: 2026-05-25 | Files scanned: 31 | Token estimate: ~650 -->

# Dependencies

## External services
| Service | Host | Usage | Auth | Touchpoint |
|---|---|---|---|---|
| Base RPC | viem default or `REPPO_RPC_URL` | All on-chain reads + tx submission | None | `chain/clients.ts` |
| Reppo platform (agents) | `https://reppo.ai/api/v1` (hardcoded) | `register-agent` registers an identity; returns `{id, apiKey}` | None on register; Bearer for `/agents/{id}/*` | `commands/register-agent.ts` |
| Reppo platform (catalog) | `https://reppo.ai/...` (default in `api/public.ts`) | `list datanets`, `list pods` | None | `api/public.ts`, `commands/list/*` |
| Reppo platform (wallet-auth) | `api.reppo.xyz` via `REPPO_API_URL` | `auth` SIWE → session token; future authed endpoints | Privy SIWE → 24h Bearer | `api/platform.ts`, `commands/auth.ts` |

## Smart contracts (Base)
ABIs in `src/chain/abis.ts` (all `parseAbi`'d). Addresses in `src/chain/addresses.ts` (network-pinned; placeholders throw on write).

| Contract | Role | Key methods used |
|---|---|---|
| `PodManager` (V2 unified) | Mint/vote/grant-access/claim | `mintPodWithREPPO`, `mintPodWithPrimaryToken`, `vote(podId,votes,upVote)`, `grantAccess`, `claimEmissions`, `ownerOf`, `exists` |
| `SubnetManager` | Datanet fee + access lookup | `getAccessFeeREPPO(subnetId)`, validity checks |
| `veREPPO` | Voting power lockup | `lock`, `extendLockup`, `withdraw`, `votingPowerOf`, `lockupCount`, `lockupData`, `previewPoints` |
| `REPPO` (ERC20, 18d) | Stake/fee token | `balanceOf`, `approve`, `transfer` |
| `USDC` (ERC20, 6d) | Optional primary token | `balanceOf` |
| `UniswapRouter` + `Quoter` | (Reserved for `swap`) | Not yet wired into any shipped command |

**Decimals trap:** REPPO / veREPPO / ETH are 18; USDC is 6. Mixing yields wrong values silently — see `CLAUDE.md` "bug surface".

## npm dependencies (production)
| Package | Used for |
|---|---|
| `clipanion@^4.0.0-rc.4` | CLI dispatch, flag parsing, help generation |
| `typanion@^3.14.0` | Runtime validation for clipanion options |
| `viem@^2.21.0` | All RPC, ABI, signing, account, tx receipt |
| `proper-lockfile@^4.1.2` | Serialize concurrent CLI runs on `~/.reppo/cli-state.json` |

## dev dependencies (selection)
`typescript`, `tsx` (dev runner), `vitest` + `@vitest/coverage-v8`, `eslint` + `@typescript-eslint/*`, `@types/node`, `@types/proper-lockfile`.

## Repo-side infra
| Path | Role |
|---|---|
| `.mcp.json` | Team-shared MCP servers (context7, github). |
| `.claude/settings.json` | PostToolUse ESLint --fix hook; PreToolUse blocks on `dist/`, `package-lock.json`, `coverage/`, `*/.reppo/cli-state.json`. |
| `.claude/skills/stacked-pr/` | Stacked-PR workflow primitive. |
| `.github/workflows/` | CI matrix: Node 20+22 × Ubuntu+macOS. Integration tests gated on `workflow_dispatch`. |

## Environment variables (full table)
| Var | Used by | Notes |
|---|---|---|
| `REPPO_PRIVATE_KEY` | All write commands | 64 hex chars, optional `0x` prefix. |
| `REPPO_VOTER_PRIVATE_KEY` | `vote` only | Separate EOA from publisher. |
| `REPPO_NETWORK` | All | `mainnet` (default) or `testnet`. |
| `REPPO_RPC_URL` | All | Override viem's Base RPC. |
| `REPPO_API_URL` | `auth`, future `create-datanet` | Defaults to api.reppo.xyz. |
| `REPPO_API_KEY` | `api.reppo.xyz` calls | Obtained via `auth`. |
| `REPPO_STATE_PATH` | All | Override `~/.reppo/cli-state.json` (tests). |
