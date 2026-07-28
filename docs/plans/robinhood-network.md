# Plan: `--network robinhood` (Robinhood Chain, 4663)

Reppo is live on Robinhood Chain mainnet with the **RBV1** contract variant. This plan adds
`robinhood` as a third network to the CLI so agent nodes (orquestra) can vote/mint there.

## Verified facts (2026-07-27)

| Item | Value | Source |
|---|---|---|
| Chain id | 4663 (`0x1237`) | `eth_chainId` on `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://explorer.mainnet.chain.robinhood.com` | host verified (301 → app) |
| PodManagerRBV1 | `0xeAd1A577B02829b7F634aD7eE30Fbbc2CDF7e478` | robinhood.reppo.ai `contracts/podManagerRBV1.ts` (production) |
| SubnetManagerRBV1 | `0xDAd72306b2ee410B20795D353cF7913AA7Eb15aa` | ditto |
| VeReppoRBV1 | `0x15949C1727076a546eB055e9AB9E5bD32f069Db2` | ditto |
| Public catalog API | `https://robinhood.reppo.ai/api/v1/public/subnets` | live; same DTO as reppo.ai except `accessFee` (single) replaces `accessFeeREPPO` |
| REPPO / USDC / Uniswap | none on 4663 | RBV1 sources; fees are paid in each subnet's own ERC-20 (`getSubnetToken`) |

## RBV1 protocol differences (from `Reppo-Labs/economic-contracts`)

- **No staking on chain 4663.** `VeReppoRBV1` = `votingPowerOf/currentEpoch/epochLength/epochEnd`
  + admin-only `setVotingPower`. Voting power is mirrored from the operator's **Base** veREPPO
  position by robinhood.reppo.ai (Privy-authed `PATCH /api/v1/me/voting-power-sync/<addr>`).
  → `lock` / `extend-lock` / `unlock` are meaningless on robinhood.
- **Single-token fees.** `SubnetManagerRBV1`: `getAccessFee`, `getPublishingFee`,
  `getRepublishFee`, `getSubnetToken`, `accessSubnet(subnetId,to)`. `PodManagerRBV1`:
  `mintPod(to,subnetId)` collects `getPublishingFee` in the subnet token via `transferFrom`.
  No `*WithREPPO` / `*WithPrimaryToken` split.
- **Identical surfaces** (safe to reuse existing ABIs against the RBV1 address):
  `vote(uint256,uint256,bool)`, `podValid`, `ownerOf`, `claimPodOwnerEmissions`,
  `claimVoterEmissions`, `hasPodOwnerClaimedEmissions`, `hasUserClaimedEmissions`,
  `getVotersUpVotesForPodInEpoch`, `getVotersDownVotesForPodInEpoch`,
  `votingPowerOf`, `currentEpoch`, `epochLength`, `epochEnd`.

## Command matrix on `--network robinhood`

| Command | Status | Notes |
|---|---|---|
| vote | ✅ works | same ABI subset, RBV1 address |
| mint-pod | ✅ new path | `mintPod(to,subnetId)`; fee token = `getSubnetToken`; auto-approve subnet token; `--token` flag rejected |
| grant-access | ✅ new path | `getAccessFee` + `getSubnetToken` + `accessSubnet` |
| claim-emissions / claim-voter-emissions | ✅ works | same ABI subset |
| query epoch / pod / voter-emissions-due / voting-power | ✅ works | `voting-power`: veReppo `balanceOf` degrades to null (RBV1 is not an NFT) |
| query balance | ✅ degraded | native ETH + votingPowerOf; REPPO/USDC rows `unavailable` |
| query datanet | ✅ new path | RBV1 fee getters; catalog from robinhood public API |
| list datanets | ✅ | per-network public API base → `https://robinhood.reppo.ai` |
| lock / extend-lock / unlock | ❌ `UNSUPPORTED_ON_NETWORK` | error explains: lock on Base, sync at robinhood.reppo.ai |
| approve | ❌ named tokens | `reppo`/`usdc` don't exist on 4663; auto-approve inside mint/grant covers the real need |
| auth / list pods / query emissions-due | ❌ `PLATFORM_API_NOT_CONFIGURED` | robinhood platform is Privy-authed; no wallet-auth API today (product gap, flagged) |
| register-agent | unchanged | reppo.ai agents API is network-agnostic |

## Implementation steps

1. **Network type + validation.** `addresses.ts:12` `Network = 'mainnet'|'testnet'|'robinhood'`;
   `getAddresses` ternary → `Record<Network, AddressBundle>`; add `ROBINHOOD` bundle
   (reppoToken/usdc = TBD sentinel, uniswap null). Widen `config/load.ts:88` and
   `_base.ts:23-30` validations + flag description + `INVALID_NETWORK` messages.
2. **Viem chain.** Installed viem 2.48.4 lacks chain 4663 → local `defineChain` (id 4663,
   RPC `https://rpc.mainnet.chain.robinhood.com`, explorer). `clients.ts` ternaries →
   `Record<Network, Chain>`.
3. **RBV1 ABIs** (`abis.ts`): `SUBNET_MANAGER_RBV1_ABI` (validSubnet, hasSubnetAccess,
   getAccessFee, getPublishingFee, getSubnetToken, accessSubnet, subnetOwner),
   `POD_MANAGER_RBV1_ABI` (mintPod(to,subnetId) + PodMinted event + shared read fns).
   `contracts.ts`: add `podManagerRb`/`subnetManagerRb` accessors; existing accessors keep
   V2 types (no union fallout) — robinhood-aware commands branch explicitly.
4. **Command branches** per matrix above. Explorer URL: extend `basescanTxUrl` helper to a
   `txUrl(network, tx)` with robinhood branch; replace the 9 inline copies.
5. **Platform API config.** `load.ts:101`: robinhood default `apiUrl` stays `undefined`
   (honest `PLATFORM_API_NOT_CONFIGURED`). Public API base becomes per-network:
   `robinhood → https://robinhood.reppo.ai` in `api/public.ts` (same `/api/v1/public/*` DTOs;
   map `accessFee` → the existing field).
6. **Tests.** Third `describe('robinhood')` in `contracts.test.ts` (addresses + ABI surface
   asserts e.g. no `mintPodWithPrimaryToken`); `load.test.ts` accepts `robinhood`;
   `makeCmd('robinhood')` runs for vote/mint-pod/grant-access/query datanet/epoch;
   unsupported-command error tests for lock family.
7. **Release.** Version bump, changelog, PR.

## Product gaps to flag to the Reppo team (out of CLI scope)

- No wallet-auth (headless) way to trigger voting-power sync on robinhood.reppo.ai —
  operators must sync via the web UI after changing their Base lock.
- No wallet-auth platform API for robinhood pods (list pods / emissions-due / pod metadata
  registration at mint). Pods minted by CLI have no platform metadata until this exists.

## Follow-up (orquestra, separate repo)

Per-network address table for direct-RPC readers, skip veREPPO-lock setup when
`REPPO_NETWORK=robinhood` (lock lives on Base), network-aware mint-fee reader (subnet token,
not REPPO), rubric loader already works (same onboarding fields via `query datanet`).
