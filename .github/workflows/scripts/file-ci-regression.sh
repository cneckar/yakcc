#!/usr/bin/env bash
# file-ci-regression.sh — auto-file or comment on a ci-regression GitHub Issue
#
# @decision DEC-CI-POSTMERGE-ADVISORY-GATE-001
# Title: Auto-file regression issues with dedup-by-open-issue-title (D3+D4)
# Status: accepted
# Rationale: When pr-ci-test-advisory.yml fires on push:main and the test step
# fails, this script is invoked by the on-failure step. It:
#   1. Builds an issue body with header (run URL, SHA, author, timestamp),
#      best-effort merge-PR# extraction, step name, log tail from
#      tmp/test-advisory.log, optional revert hint, and DEC-ID footer.
#   2. Creates the ci-regression label idempotently (--force).
#   3. Deduplicates by searching for an open issue with the same step-name prefix.
#      If found: appends a comment. If not: files a new issue.
# This avoids spam on flaky regressions (D3) and keeps the issue body consistent
# with D4's content specification.
#
# Required env vars (supplied by GitHub Actions):
#   GITHUB_SHA           — full commit SHA that triggered the workflow run
#   GITHUB_REPOSITORY    — owner/repo (e.g. cneckar/yakcc)
#   GITHUB_SERVER_URL    — https://github.com
#   GITHUB_RUN_ID        — numeric run ID
#   GH_TOKEN             — GitHub token with issues:write (from secrets.GITHUB_TOKEN)
#
# Optional env vars (available on push:main events):
#   GITHUB_ACTOR         — the actor who triggered the run (may differ from commit author)
#
# The log file tmp/test-advisory.log is produced by the test step's tee command.
# If it does not exist (e.g. failure before the tee step), a fallback message
# is used.

set -euo pipefail

# ---------------------------------------------------------------------------
# 1. Build header fields
# ---------------------------------------------------------------------------
STEP_NAME="test (affected packages, advisory)"
SHA_FULL="${GITHUB_SHA}"
SHA_SHORT="${GITHUB_SHA:0:7}"
RUN_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"

# Commit message first line (for merge-PR extraction and header display)
COMMIT_MSG=$(git log -1 --format="%s" "${SHA_FULL}" 2>/dev/null || echo "")

# Commit author name + email from git (more reliable than event payload on
# push:main events where GITHUB_EVENT_PATH contents vary by workflow context)
COMMIT_AUTHOR=$(git log -1 --format="%an <%ae>" "${SHA_FULL}" 2>/dev/null || echo "unknown")

# Commit timestamp (ISO 8601)
COMMIT_TIMESTAMP=$(git log -1 --format="%cI" "${SHA_FULL}" 2>/dev/null || echo "unknown")

# ---------------------------------------------------------------------------
# 2. Best-effort merge-PR# extraction from squash-merge commit message
#    Pattern: matches (#NNN) at end of line — the squash-merge convention
#    used on this repo (verified against recent merged PRs).
# ---------------------------------------------------------------------------
MERGE_PR_NUM=""
if echo "${COMMIT_MSG}" | grep -qE '\(#[0-9]+\)'; then
    MERGE_PR_NUM=$(echo "${COMMIT_MSG}" | grep -oE '#[0-9]+' | tail -1 | tr -d '#')
fi

# ---------------------------------------------------------------------------
# 3. Log tail — from tmp/test-advisory.log (D4: NOT gh api run logs)
# ---------------------------------------------------------------------------
LOG_TAIL=""
if [ -f "tmp/test-advisory.log" ]; then
    LOG_TAIL=$(tail -100 tmp/test-advisory.log)
else
    LOG_TAIL="(log file tmp/test-advisory.log not found — failure may have occurred before the test step)"
fi

# ---------------------------------------------------------------------------
# 4. Build issue body (D4 content spec)
# ---------------------------------------------------------------------------
build_body() {
    local context_sha="${1:-${SHA_SHORT}}"

    cat <<EOF
## CI Regression on main

**Workflow run:** ${RUN_URL}
**Commit:** \`${SHA_FULL}\`
**Short SHA:** \`${context_sha}\`
**Commit message:** ${COMMIT_MSG}
**Author:** ${COMMIT_AUTHOR}
**Timestamp:** ${COMMIT_TIMESTAMP}
EOF

    if [ -n "${MERGE_PR_NUM}" ]; then
        echo "**Merge PR:** #${MERGE_PR_NUM}"
    fi

    cat <<EOF

**Failing step:** \`${STEP_NAME}\`

<details>
<summary>Log tail (last 100 lines)</summary>

\`\`\`
${LOG_TAIL}
\`\`\`

</details>
EOF

    if [ -n "${MERGE_PR_NUM}" ]; then
        echo ""
        echo "**Suggested follow-up:** If this is a clean regression, \`gh pr revert ${MERGE_PR_NUM}\` may be appropriate. Otherwise investigate and close this issue when resolved."
    fi

    cat <<EOF

---
*auto-filed by \`.github/workflows/pr-ci-test-advisory.yml\` (DEC-CI-POSTMERGE-ADVISORY-GATE-001)*
EOF
}

# ---------------------------------------------------------------------------
# 5. Create ci-regression label idempotently (--force succeeds if it exists)
# ---------------------------------------------------------------------------
gh label create ci-regression \
    --color C5DEF5 \
    --description "Auto-filed CI regression on main" \
    --force

# ---------------------------------------------------------------------------
# 6. Dedup check: search for an open issue with the same step-name prefix (D3)
#    Key: workflow step name, not individual test-case — failure is at step level.
# ---------------------------------------------------------------------------
DEDUP_SEARCH="CI regression on main: ${STEP_NAME}"

EXISTING_ISSUE=$(gh issue list \
    --state open \
    --label ci-regression \
    --search "${DEDUP_SEARCH}" \
    --json number \
    --jq '.[0].number' \
    2>/dev/null || echo "")

# ---------------------------------------------------------------------------
# 7. File new issue or append comment to existing open issue
# ---------------------------------------------------------------------------
ISSUE_TITLE="CI regression on main: ${STEP_NAME} failed at commit ${SHA_SHORT}"
BODY=$(build_body "${SHA_SHORT}")

if [ -n "${EXISTING_ISSUE}" ] && [ "${EXISTING_ISSUE}" != "null" ]; then
    echo "Open ci-regression issue #${EXISTING_ISSUE} already exists — appending comment."
    gh issue comment "${EXISTING_ISSUE}" --body "${BODY}"
    echo "Commented on issue #${EXISTING_ISSUE}: ${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/issues/${EXISTING_ISSUE}"
else
    echo "No open ci-regression issue found — filing new issue."
    gh issue create \
        --title "${ISSUE_TITLE}" \
        --body "${BODY}" \
        --label "ci-regression,claude-todo"
    echo "Filed new ci-regression issue."
fi
