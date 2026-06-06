#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# bench/proof-requirement/run-modes.sh
#
# Wrapper: runs harness.mjs in each of the four proof_requirement modes and
# captures per-mode metrics. Passes --dry-run unless ANTHROPIC_API_KEY is set.
#
# Usage:
#   ./run-modes.sh               # dry-run all four modes
#   ./run-modes.sh smoke         # dry-run smoke subset (one task per domain)
#   ANTHROPIC_API_KEY=sk-... ./run-modes.sh   # live run
#   ANTHROPIC_API_KEY=sk-... ./run-modes.sh smoke  # live smoke

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="$SCRIPT_DIR/harness.mjs"

MODES=("required" "preferred" "ignored" "per_block")

DRY_RUN_FLAG=""
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "[run-modes] No ANTHROPIC_API_KEY found — running in dry-run (simulation) mode."
  DRY_RUN_FLAG="--dry-run"
fi

SMOKE_FLAG=""
if [ "${1:-}" = "smoke" ]; then
  echo "[run-modes] Smoke mode: one task per domain."
  SMOKE_FLAG="--smoke"
fi

echo "[run-modes] Starting proof-requirement benchmark (4 modes)"
echo "  Harness: $HARNESS"
echo "  Dry-run: ${DRY_RUN_FLAG:-no (live)}"
echo ""

for mode in "${MODES[@]}"; do
  echo "========================================"
  echo "[run-modes] Mode: $mode"
  echo "========================================"
  node "$HARNESS" --mode="$mode" $DRY_RUN_FLAG $SMOKE_FLAG
  echo ""
done

echo "[run-modes] All modes complete. Results in: $SCRIPT_DIR/results/"
