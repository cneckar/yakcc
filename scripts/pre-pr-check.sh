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
  echo "If any of these files are outside your WI's scope manifest, your"
  echo "branch is in stale-rebase damage. See AGENTS.md \"Before you open"
  echo "a PR\" for the cherry-pick-onto-fresh recovery path."
  echo
  exit 1
fi

echo "OK — no deletions detected against origin/main."
echo
echo "Reminder: also confirm the diff stat matches your scope manifest's"
echo "expected size. A clean diff stat is necessary but not sufficient;"
echo "additions in files outside your scope are also a stale-rebase signal."
