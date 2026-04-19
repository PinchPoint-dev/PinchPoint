# Per-Bot Worktrees

A recommended workflow for multi-bot fleets that edit code in the same repo. Validated in production on the Novolaw project (Sprint 30C, 2026-04-18) after atomic commit+push coordination failed to prevent stacked-commit and race conditions under sustained parallel work.

## The problem

If every bot in your fleet has its `workDir` pointed at the same checkout, they share a single git index and a single working tree. That creates three classes of failure under parallel work:

1. **Shared `git status`.** When Bot A runs `git status`, it sees Bot B's uncommitted edits as if they were its own. Bot A's "review my diff" to the operator is actually "review the combined diff," and the operator can't easily tell whose work is whose.
2. **Stacked commits.** If Bot A commits before Bot B pushes, Bot B's next commit stacks on top of A's. The operator signing off on B's PR is signing off on A's unreviewed work too.
3. **File-edit races.** Two bots editing the same file at roughly the same time produce interleaved writes. The result may parse, may lint, and still be silently broken.

Workflow fixes ("commit + push atomically," "announce before editing") are social band-aids. They work until they don't, and they fail silently when they fail.

## The fix

One [git worktree](https://git-scm.com/docs/git-worktree) per bot, each on its own `bot/<name>` branch. `main` becomes a merge-target only.

```
ParentDir/
  YourRepo/               # main tree — branch `main` — merge target ONLY
  YourRepo-bee/           # Bee's worktree — branch `bot/bee`
  YourRepo-beaver/        # Beaver's worktree — branch `bot/beaver`
  YourRepo-owl/           # Owl's worktree — branch `bot/owl` (or skipped if review-only)
```

Every bot gets a physically separate checkout of the same repo, sharing the same `.git` object store but with independent working trees, indexes, and HEADs. File-edit races, shared `git status`, and stacked-commit coordination all disappear — not because the rules got tighter, but because the substrate changed.

## Setup

### 1. Create a worktree per code-editing bot

From the main tree:

```bash
git worktree add -b bot/bee ../YourRepo-bee main
git worktree add -b bot/beaver ../YourRepo-beaver main
# ...repeat for each code-editing bot
```

Review-only bots (e.g., an Owl that never commits) don't need a worktree — they can read from the main tree or any bot's branch.

### 2. Point each bot's `workDir` at its worktree

In `bots.json`:

```json
{
  "Bee": {
    "workDir": "/abs/path/to/YourRepo-bee",
    "promptFile": "/abs/path/to/YourRepo/.pinchme/cord/prompts/bee.md",
    ...
  },
  "Beaver": {
    "workDir": "/abs/path/to/YourRepo-beaver",
    ...
  }
}
```

Note that `promptFile` still points into the main tree (prompts are shared infra), while `workDir` points into the bot's own worktree.

### 3. Propagate `.env` into new worktrees

Git doesn't copy untracked files (like `.env`) into a new worktree. Add a `.worktreeinclude` at the repo root listing files that should propagate:

```
.env
.env.local
```

Then in your worktree-creation tooling, after `git worktree add`, copy each file listed in `.worktreeinclude` from the main tree into the new worktree.

### 4. Teach each bot about its worktree

Add a header to each bot's system prompt:

```markdown
**Worktree:** you work in `/abs/path/to/YourRepo-bee/` on branch `bot/bee`. Do NOT commit to the main tree or to `main` directly. Commit + push to `bot/bee`; the reviewer bot merges to `main` on approval via `merge-bot.sh bee`. Before each new task, run `git fetch origin && git rebase origin/main` to keep your branch linear on top of main.
```

### 5. Give the reviewer a merge script

See [`cord/tools/merge-bot.sh`](../cord/tools/merge-bot.sh) for a reference implementation. The reviewer bot runs it from the main tree; it fast-forwards the bot's branch into `main` if possible, falls back to a merge commit if the branches have diverged, and pushes.

## Bot workflow

1. Start from main: `git fetch origin && git rebase origin/main` in your worktree. Keeps your branch linear on top of main.
2. Work on your branch. Commit as often as you want — your branch is a WIP buffer.
3. Push to your branch (`git push origin bot/<name>`). No gate on push-to-own-branch.
4. Post a summary + commit range (`git log main..bot/<name>`) to the reviewer.
5. On approval, the reviewer merges to main via `merge-bot.sh <name>`.
6. Rebase on new main before the next task (step 1 again).

## What this retires

- **Atomic commit+push coordination.** With per-bot worktrees, committing locally is safe — your branch is yours. No more "always push immediately so your commit doesn't stack on someone else's."
- **Diff-based reviews.** Reviews target pushed commits with stable hashes, not staged diffs whose meaning changes as other bots edit the same tree.
- **Announce-before-editing etiquette.** File-edit races on shared paths now surface as standard git merge conflicts at merge time — resolvable via rebase, not invisible until runtime.

## What it doesn't solve

- **Merge conflicts still exist.** Two bots editing the same file on different branches will conflict when the second branch merges. Worktrees don't eliminate conflicts — they convert invisible runtime corruption into visible git conflicts that standard tooling resolves.
- **Disk usage.** Each worktree is a full checkout. For a 1 GB repo and 6 bots, that's ~6 GB on disk. The `.git` object store is shared, so the marginal cost per worktree is one working-tree copy, not a full clone.
- **Cross-branch visibility.** A bot editing in its own worktree doesn't see another bot's in-flight work until the other bot pushes. That's a feature, not a bug — bots should review committed work, not mid-edit state.

## Review-only bots

If a bot's role is review or audit (it never commits), skip the worktree. It reads from the main tree, uses `git fetch` to pull other bots' pushed branches, and reviews via `git diff main...origin/bot/<name>` (remote ref — the reviewer won't have a local branch). Adding a worktree for a bot that doesn't edit code is pure overhead.

## Migration from a shared-tree fleet

If you already have a running fleet on a shared tree:

1. Land any in-flight bot commits to `main` first (shared-tree cleanup is harder than you think).
2. Add `.worktreeinclude` at repo root.
3. For each code-editing bot: `git worktree add -b bot/<name> ../Repo-<name> main` and copy `.env` files.
4. Update each bot's `workDir` in `bots.json`.
5. Add the worktree header to each bot's prompt.
6. Add `cord/tools/merge-bot.sh` (or equivalent) for the reviewer.
7. Kill and relaunch the bots — launchers read `workDir` at session start, not at runtime.

Expect a few rounds of "wait, which worktree am I in?" from the bots for the first day. The header + a `pwd` check in the prompt handles it.
