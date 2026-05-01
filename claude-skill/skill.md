---
name: reppo
description: Use when the user wants to take any action on Reppo (mint a pod, vote, lock REPPO into veReppo, claim emissions, create a datanet, grant subnet access, swap REPPO/USDC). The CLI exposes the full Reppo on-chain surface as `@reppo-labs/cli`.
---

# Reppo skill

You can take actions on Reppo (Base mainnet, chain id 8453, or Base Sepolia testnet, chain id 84532) by invoking the `reppo` CLI via Bash. The CLI is a thin shell over Reppo's contracts; it does the chain plumbing so you don't have to.

## Setup check

Before running any command, verify the CLI is installed:

```bash
reppo --version
```

If it's missing, ask the user to run `npm i -g @reppo-labs/cli` (requires Node ≥20). Don't try to install it yourself — the user owns their environment.

## Required environment

| Variable | When |
|---|---|
| `REPPO_PRIVATE_KEY` | Any write command (mint, vote, lock, claim, etc.) |
| `REPPO_VOTER_PRIVATE_KEY` | `vote` only — should be a *different* EOA from the publisher (publishers cannot vote on their own pods) |
| `REPPO_NETWORK` | `mainnet` (default) or `testnet` — alternatively pass `--network` per call |
| `REPPO_API_KEY` | Only `register-agent` and `create-datanet` (Reppo platform API) |

If a write command needs a key that isn't set, the CLI exits with `code: MISSING_PRIVATE_KEY`. Ask the user — never attempt to generate or guess one.

## Always pass `--json`

Whenever you capture command output programmatically, pass `--json`. The CLI's human mode is for terminal users; you want structured output you can parse:

```bash
reppo query balance --json
# → {"address":"0x…","network":"mainnet","balances":{"eth":{...},"reppo":{...}, ...}}
```

Errors **always** emit JSON on stderr regardless of `--json`, with a stable `code` field. Match on `code`, not on `message`.

## Always dry-run write commands first

Every write command accepts `--dry-run`. Run it before the real call to catch reverts before spending gas:

```bash
reppo vote --pod 34 --subnet 19 --like --dry-run --json
# Exits 0 with simulated:true if would succeed.
# Exits non-zero with structured error if would revert.
```

Only proceed to the real call if the dry-run exits 0.

## Use idempotency keys

Every write command accepts `--idempotency-key <stable-string>`. The CLI caches results locally; repeat calls with the same key return the prior tx hash without re-sending. If you might retry a command (network blip, timeout, etc.), pass an idempotency key derived from the *intent* (e.g. `--idempotency-key vote-job-3858-pod-34`).

## Action recipes

### Vote on a pod

Voting requires:
1. Voter has voting power (veREPPO > 0)
2. Voter has subnet access
3. Voter is not the pod's publisher

The CLI checks #1 and #2 and emits structured errors with recovery hints. For #3, ensure `REPPO_VOTER_PRIVATE_KEY` is a different EOA than the one that minted the pod.

```bash
# Dry-run first
reppo vote --pod 34 --subnet 19 --like --dry-run --json

# If clean, cast for real
reppo vote --pod 34 --subnet 19 --like --json --idempotency-key vote-pod-34-like
```

If you get `code: INSUFFICIENT_VOTING_POWER`, run `reppo lock` first.

If you get `code: VOTER_LACKS_SUBNET_ACCESS`, run `reppo grant-access --subnet 19` first.

### Lock REPPO for voting power

```bash
# Lock 1000 REPPO for 2 hours (testnet minimum)
reppo lock 1000 --duration 7200 --json --idempotency-key lock-1000-2h
```

The result includes `votingPowerGained`. Pass that to `reppo query voting-power` to verify.

### Mint a pod

```bash
reppo mint-pod --subnet 19 --json --idempotency-key mint-pod-tweet-12345
```

The result includes the on-chain `podId` and `txHash`. Capture both — you'll need `podId` for downstream `vote` and `claim-emissions` calls.

### Claim emissions across all owned pods

```bash
# 1. Find what's claimable
reppo query emissions-due --json
# → {"totalDueREPPO":"1234.5","byPod":[{"podId":"42","epoch":3940,"amount":"100"},…]}

# 2. Claim each one (loop in your shell)
for pod in 42 43 44; do
  reppo claim-emissions --pod $pod --json --idempotency-key claim-$pod-$(date +%s)
done
```

### Create a new datanet

```bash
reppo create-datanet --name "My A/B Tests" \
                    --token 0xMY_ERC20 \
                    --fee 10 \
                    --description "Public A/B testing datanet" \
                    --json
# → {"txHash":"0x…","subnetId":"42","datanetName":"My A/B Tests"}
```

`--token` is the native ERC-20 for the datanet on Base. `--fee` is the publishing fee in REPPO (whole tokens). The CLI handles the two-step Reppo platform flow (draft → on-chain publish → record tx) automatically.

## Error codes you'll see

| `code` | Recovery |
|---|---|
| `INSUFFICIENT_VOTING_POWER` | `reppo lock <amount> --duration 7200` first |
| `VOTER_LACKS_SUBNET_ACCESS` | `reppo grant-access --subnet <id>` first |
| `PUBLISHER_LACKS_SUBNET_ACCESS` | `reppo grant-access --subnet <id>` for the publisher EOA |
| `VOTE_REJECTED_PRECONDITION` | Voter is likely the publisher — use a different `REPPO_VOTER_PRIVATE_KEY` |
| `INSUFFICIENT_ALLOWANCE` | The CLI normally handles approvals; re-run with `--debug` to inspect |
| `MISSING_PRIVATE_KEY` | Ask the user to set `REPPO_PRIVATE_KEY` (or `REPPO_VOTER_PRIVATE_KEY` for votes) |
| `MISSING_ADDRESS` | Pass an address argument or set `REPPO_PRIVATE_KEY` |
| `INVALID_VOTE` | `--like` and `--dislike` are mutually exclusive; pass exactly one |
| `TX_REVERTED` | Tx was mined but reverted — re-check preconditions |
| `INTERNAL_ERROR` | Bug in the CLI — capture full stderr and ask the user to file an issue |

## Network selection

Default is mainnet. For testnet (Base Sepolia, Reppo's staging API):

```bash
reppo vote --pod 34 --subnet 19 --like --network testnet
# or
export REPPO_NETWORK=testnet
```

Testnet REPPO and veREPPO are different contract addresses than mainnet — the CLI handles that automatically based on `--network`.

## What this skill does NOT cover

- Reppo's economics, governance, or epoch math — see https://docs.reppo.ai
- Wallet creation or key management — the user provides keys via env
- Listening for on-chain events — the CLI is one-shot per command
- Account abstraction / paymaster flows — direct EOA only in v0.1
