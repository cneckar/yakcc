#!/usr/bin/env bash
# scripts/affected-packages.sh — affected-package base-ref resolver for pr-ci.yml
#
# @decision DEC-CI-FAST-PATH-PHASE-1-002
# Title: Affected-package detection via pnpm --filter "...[origin/<base-ref>]"
# Status: accepted
# Rationale: pnpm owns the workspace dependency graph; any hand-rolled file→package
# map would diverge. The "..." prefix means "changed packages AND their dependents"
# (consumers), providing the correct safety net: modify A, test A and everything
# that imports A. This thin wrapper exists only to (a) resolve the right base ref
# under GitHub Actions PR context vs local invocation, and (b) tolerate the
# empty-affected case by emitting "--filter=*" as a fallback sentinel.
#
# Usage:
#   BASE_FILTER=$(bash scripts/affected-packages.sh)
#   pnpm $BASE_FILTER test
#
# Output (stdout): a pnpm --filter flag string, e.g.:
#   --filter "...[origin/main]"
#
# Environment:
#   GITHUB_BASE_REF — set by GitHub Actions in PR context (e.g. "main")
#                     If unset, defaults to "main" for local invocation.
#
# Exit codes:
#   0 — always (this script does not fail; callers see empty-set as no-op)

set -euo pipefail

# Resolve the base branch ref. In a GitHub Actions pull_request context,
# GITHUB_BASE_REF is the target branch name (e.g. "main"). For local runs or
# push events, it is unset; default to "main".
BASE_REF="${GITHUB_BASE_REF:-main}"

# Build the pnpm filter expression. pnpm's [...] syntax matches packages whose
# files have changed relative to origin/<ref>. The leading "..." includes the
# changed packages' dependents (consumers), not just the changed packages
# themselves.
FILTER_EXPR="...[origin/${BASE_REF}]"

# Emit the resolved filter expression. Callers use this directly:
#   pnpm $(bash scripts/affected-packages.sh) test
#
# Note on empty-affected case: when no files changed relative to base (e.g. a
# docs-only commit touching only non-workspace files), pnpm --filter with a
# [...] selector returns 0 packages. pnpm treats this as a no-op — no tests
# run, the step exits 0. This is intentional: a docs-only PR should not fail
# CI simply because no packages changed. The lint and typecheck steps (which
# always run over the full workspace) still provide coverage for doc-adjacent
# type errors.
echo "--filter \"${FILTER_EXPR}\""
