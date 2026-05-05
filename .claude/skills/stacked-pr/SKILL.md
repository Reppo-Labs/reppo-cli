---
name: stacked-pr
description: Manage a stacked-PR queue against GitHub. Branches new work off a non-main base, opens the PR with --base set to the upstream branch, and surgically retargets to main once the upstream merges. Use when one logical change builds on another open PR's content.
disable-model-invocation: true
---

# stacked-pr

Codifies the branch-off-base / retarget-on-merge workflow this repo has used 6+ times. The git primitive most people don't know — `git rebase --onto <newbase> <upstream> <branch>` — is the surgical core.

## When to use

- A new PR's diff depends on helpers/changes from another open PR (e.g. `feat/query-voting-power` depends on `refactor/command-helpers` because it uses `tryVeReppo`).
- Multiple parallel PRs depend on the same base (e.g. PR #11 and PR #12 both off PR #9 — neither depends on the other, just both need the helpers).

**Don't use for:**
- A standalone PR with no upstream dependency (just branch off main directly).
- A series where each PR strictly depends on the previous (consider squashing or one-PR-with-multiple-commits).

## The shape

```
main
 ↑
 PR #A (upstream — open)
 ↑
 PR #B (this PR — base = PR #A's branch)
```

When PR #A merges, PR #B's base needs to retarget to `main`, and the local branch needs to be rebased so the diff stays clean.

## Workflow

### Creating a stacked PR

```bash
# Branch from the upstream PR's branch, NOT main
git checkout <upstream-branch>     # e.g. refactor/command-helpers
git checkout -b <new-branch>       # e.g. feat/query-voting-power

# ... make changes, commit ...

git push -u origin <new-branch>

# Open PR with explicit base
gh pr create \
  --base <upstream-branch> \
  --title "..." \
  --body "**Stacked on #<upstream-num>**. Rebases to main when #<upstream-num> merges."
```

### Retargeting after upstream merges

```bash
git fetch origin --prune
git checkout main
git pull --ff-only origin main

# Surgical rebase: replay only the commits unique to this branch
# onto main, dropping anything that was already on the upstream.
git checkout <new-branch>
git rebase --onto main <upstream-branch> <new-branch>

# Force-push (with-lease for safety) and retarget the PR base
git push --force-with-lease origin <new-branch>
gh pr edit <pr-num> --base main
```

## Why `--onto` not plain `git rebase main`

`git rebase main` would replay EVERY commit not on main onto main — including the upstream PR's commits, which are about to be merged via the upstream PR. The result is duplicate commits and a confusing diff.

`git rebase --onto main <upstream> <branch>` says: "take the commits unique to `<branch>` (relative to `<upstream>`) and replay them onto `main`." Only your own commits move; the upstream's stay where they are.

## Conflict resolution

If two parallel stacked PRs (e.g. PR #11 + PR #12, both off PR #9) edit the same line — typically the README status line — the second one to merge will hit a conflict. Resolve with the OTHER PR's content already merged:

```bash
git fetch origin
git checkout <new-branch>
git rebase origin/main
# Resolve conflicts manually — usually keep both edits
git push --force-with-lease origin <new-branch>
```

## Naming convention

- `chore/...` — config / CI / tooling
- `refactor/...` — internal restructure, no public surface change
- `feat/...` — new user-visible capability
- `test/...` — test-only additions
- `fix/...` — bug fix

This repo uses these consistently; PR titles inherit from the type prefix.

## Anti-patterns

- **Stacking 4+ deep** — review queue gets confusing, conflicts compound. If you're at depth 4, pause and get the lower PRs reviewed/merged first.
- **Stacking PRs that don't actually depend on each other** — branch them all off the common base in parallel instead. Reviewers can read in any order.
- **Force-push without `--force-with-lease`** — accidentally clobbering upstream pushes is hard to recover from.
