#!/usr/bin/env bash
# merge-bot.sh — merge an approved bot branch into main.
#
# The reviewer bot runs this after approving a bot's branch. Operates
# in the main worktree (not a bot's worktree). Prefers fast-forward
# merge; falls back to a merge-commit if the branch has diverged.
#
# Usage:
#     cord/tools/merge-bot.sh <botname>
#
# Example:
#     cord/tools/merge-bot.sh bee
#
# Preconditions:
#   - bot/<botname> has been pushed to origin
#   - main tree is clean (no uncommitted changes)
#   - Reviewer has reviewed `git diff main...origin/bot/<botname>`
#
# Env:
#   MAIN_TREE   Path to the main-branch worktree. Defaults to the
#               script's repo root (two levels up from cord/tools/).

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <botname>" >&2
  echo "Example: $0 bee" >&2
  exit 2
fi

BOT="$1"
BRANCH="bot/${BOT}"
REMOTE_BRANCH="origin/${BRANCH}"

if [ -z "${MAIN_TREE:-}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  MAIN_TREE="$(cd "${SCRIPT_DIR}/../.." && pwd)"
fi

if [ ! -d "$MAIN_TREE" ]; then
  echo "Main tree not found at $MAIN_TREE" >&2
  exit 1
fi

cd "$MAIN_TREE"

current_branch=$(git branch --show-current)
if [ "$current_branch" != "main" ]; then
  echo "Main tree is on branch '$current_branch', not main." >&2
  echo "Refusing to merge. Check out main first." >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Main tree has uncommitted changes. Refusing to merge." >&2
  git status --short >&2
  exit 1
fi

echo "Fetching origin…"
git fetch origin

if ! git show-ref --verify --quiet "refs/remotes/${REMOTE_BRANCH}"; then
  echo "Remote branch '${REMOTE_BRANCH}' not found after fetch." >&2
  echo "Make sure the bot has pushed ${BRANCH} to origin." >&2
  exit 1
fi

echo "Ensuring main is current with origin/main…"
git merge --ff-only origin/main

echo "Attempting fast-forward merge of ${REMOTE_BRANCH}…"
if git merge --ff-only "$REMOTE_BRANCH"; then
  echo "  Fast-forward merged ${REMOTE_BRANCH} into main."
else
  echo "  Fast-forward not possible; performing merge-commit."
  git merge "$REMOTE_BRANCH" -m "merge: ${BRANCH} → main"
  echo "  Merge-commit created."
fi

echo "Pushing main to origin…"
git push origin main

echo ""
echo "Done. ${BRANCH} is now integrated into main."
echo "Bot should run 'git fetch origin && git rebase origin/main' before their next task."
