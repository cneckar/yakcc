#!/usr/bin/env bash
# Pre-PR branch-hygiene check.
#
# Detects the stale-rebase damage class that has repeatedly burned PR review
# time: a branch authored before sibling work landed, "rebased" onto current
# main with conflicts resolved by --ours for files outside the WI's scope,
# silently deletes other sisters' landed work.
#
# Run before opening any PR. See AGENTS.md "Before you open a PR".

set -euo pipefail

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "error: not in a git repository" >&2
  exit 1
fi

echo "Fetching origin/main..."
git fetch origin main >/dev/null 2>&1 || {
  echo "error: failed to fetch origin/main" >&2
  exit 1
}

echo
echo "Diff vs origin/main:"
git diff --stat origin/main..HEAD | tail -1
echo

deleted_files=$(git diff --diff-filter=D --name-only origin/main..HEAD || true)
if [ -n "$deleted_files" ]; then
  echo "WARNING — this branch DELETES the following files vs origin/main:"
  echo
  echo "$deleted_files" | sed 's/^/  /'
  echo
  # Honor [intentional-deletions] marker in any commit message on this branch.
  # This allows legitimate subtractive refactors (e.g. removing a feature module
  # by operator DEC) without triggering the stale-rebase false-positive exit.
  # Operator/reviewer must still confirm the deletions match the WI's scope manifest.
  if git log --format=%B origin/main..HEAD | grep -qF "[intentional-deletions]"; then
    echo "OK — [intentional-deletions] marker found in commit log; deletions accepted."
    echo "Operator/reviewer should still confirm the deletions match the WI's scope manifest."
    echo
  else
    echo "If any of these files are outside your WI's scope manifest, your"
    echo "branch is in stale-rebase damage. See AGENTS.md \"Before you open"
    echo "a PR\" for the cherry-pick-onto-fresh recovery path."
    echo
    echo "If the deletions are intentional (subtractive refactor per WI DEC),"
    echo "add the marker \"[intentional-deletions]\" to one of your commit"
    echo "messages and re-push. The hygiene check will warn-only on that signal."
    echo
    exit 1
  fi
fi

echo "OK — no deletions detected against origin/main."
echo
echo "Reminder: also confirm the diff stat matches your scope manifest's"
echo "expected size. A clean diff stat is necessary but not sufficient;"
echo "additions in files outside your scope are also a stale-rebase signal."
