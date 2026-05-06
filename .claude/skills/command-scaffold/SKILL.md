---
name: command-scaffold
description: Scaffold a new reppo CLI command (read or write) following the project's clipanion + tryX + cliError + peekIdempotent patterns. Updates bin.ts, README, and registers the command. Use when implementing any of the 12 remaining commands tracked in issue #5.
---

# command-scaffold

Generates a new `reppo` CLI command file with the project's canonical patterns wired up. Designed to compress the per-command PR ceremony so each sub-task in #5 lands as a small, focused diff.

## When to use

- Issue #5 sub-tasks (any of the 12 unimplemented commands).
- Any new clipanion command that follows the `BaseCommand` extension pattern.

**Don't use for:**
- Refactoring an existing command (use a normal edit).
- Commands that don't extend `BaseCommand` (e.g. a one-off debug command).

## Workflow

1. **Ask the user for the command spec** if not supplied:
   - Path: e.g. `query pod` or `mint-pod`
   - Type: `read` (no signing key, no idempotency) or `write` (uses `peekIdempotent` + two-phase protocol)
   - Args: positional + flags
   - Contract calls: which functions on which contracts

2. **Pick the right template** based on type:
   - Read → `templates/read-command.ts`
   - Write → `templates/write-command.ts`

3. **Generate the file** at `src/commands/<group>/<name>.ts`. Use kebab-case for the path segments (matches `query/voting-power.ts`, `query/balance.ts`).

4. **Register in `src/bin.ts`**:
   - Add the import alphabetically among the other `Query*Command` / write-command imports.
   - Add the `cli.register(...)` call alphabetically.
   - Decrement the "remaining N commands" comment.
   - Remove the new command name from the planned list in the comment.

5. **Update `README.md`**:
   - Move the command's bullet from `*(planned)*` to a description matching neighboring shipped commands.
   - Update the status line at the top with the new command name.

6. **Smoke-test before committing**:
   ```bash
   npx tsx src/bin.ts <command-path> --help
   npx tsx src/bin.ts <command-path> <bad-args> --json --network mainnet
   ```
   Both must exit cleanly (the second exits non-zero with a structured `{error: {code, message}}` JSON on stderr).

7. **Run the pipeline**:
   ```bash
   npm run lint && npm run typecheck && npm test && npm run build
   ```

## Patterns (post-#9)

All new commands MUST use:

- **`cliError(code, message, hint?)`** from `src/output/format.ts` instead of `Object.assign(new Error(...), { code, hint })`.
- **`tryX()` helpers** from `src/chain/contracts.ts` for read commands when the contract address might be TBD on the chosen network. Use the throwing variants (`podManager`, `subnetManager`, etc.) for write commands.
- **`peekIdempotent<R>(key, command, args, isDryRun)`** from `src/state/idempotency.ts` for write commands — switch on `decision.kind` instead of inlining the cache decision.
- **viem's `isAddress()`** instead of hand-rolled `/^0x[0-9a-fA-F]{40}$/` regex.
- **viem's typed return values** — no `(v as bigint).toString()` casts; viem's `parseAbi` already infers the return types.

## Common traps

- **`valid: boolean | { unavailable }`** over-typing: if the unavailable case takes an early return, type the variable as plain `boolean`. TypeScript will complain about a `never` branch otherwise.
- **`getAccessFeeREPPO(invalidId)`** reverts: skip the fee read if `validSubnet` returned false.
- **Decimals**: REPPO and veReppo are 18; USDC is 6. ABIs may share `balanceOf`, but the formatter must use the right decimals.
- **mainnet vs testnet PodManager param variant**: mainnet uses `mintPod(to, share)` (canonical production), testnet uses `mintPodWithREPPO(to, subnetId)` (forked, subnet logic added for a client). Same method family, different parameters. `tryPodManager()` returns the right ABI for the network — never paste a function name without checking which ABI is returned.

## Templates

- [templates/read-command.ts](templates/read-command.ts) — minimal read pattern (single contract call, no auth)
- [templates/write-command.ts](templates/write-command.ts) — full write pattern (idempotency + dry-run + two-phase + revert decoding)

## Related

- Issue #5 — the 13-commands epic
- PR #9 — refactor helpers this skill assumes
- PRs #11 (voting-power) and #12 (subnet) — reference implementations
