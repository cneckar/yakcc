// SPDX-License-Identifier: MIT
/**
 * system-prompt.ts — Authority surface for the yakcc discovery system prompt.
 *
 * @decision DEC-HOOK-PROMPT-DESCENT-001
 * @title Descent-and-compose discovery system prompt path constant and loader
 * @status accepted
 * @rationale
 *   WI-578 (#578, load-bearing) rewrote docs/system-prompts/yakcc-discovery.md from
 *   a polite-suggestion tone to an imperative descent-and-compose discipline. This
 *   module exports the canonical path constant and a loadDiscoveryPrompt() reader so
 *   tests can import and inspect the live prompt file without duplicating the path.
 *
 *   IMPORTANT: This module does NOT export the prompt text itself — the prompt lives
 *   exclusively in docs/system-prompts/yakcc-discovery.md. This module only provides
 *   access to it. Duplicating the text here would violate the single-source-of-truth
 *   invariant (DEC-V3-DISCOVERY-D4-001).
 *
 *   Cross-references:
 *     DEC-V3-DISCOVERY-D4-001  — D4 ADR governing the prompt file
 *     docs/adr/discovery-llm-interaction.md §Q8 — WI-578 revision record
 *     docs/system-prompts/yakcc-discovery.md — the canonical prompt text
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Workspace-root-relative path to the canonical yakcc discovery system prompt.
 * This value is the single source of truth for the path; IDE adapter packages
 * (hooks-claude-code, hooks-cursor) duplicate it as a local constant — that
 * duplication is a known marker, not a content-drift risk (they point at the
 * same file). See plan §4 for the trade-off.
 */
export const DISCOVERY_PROMPT_PATH = "docs/system-prompts/yakcc-discovery.md";

/**
 * Load the discovery system prompt from the canonical location.
 *
 * @param workspaceRoot - Absolute path to the workspace root. Defaults to
 *   process.cwd(). Tests should supply a deterministic absolute path.
 * @returns The prompt text as a UTF-8 string.
 * @throws If the file cannot be read (missing, permission error, etc.).
 */
export function loadDiscoveryPrompt(workspaceRoot?: string): string {
  const root = workspaceRoot ?? process.cwd();
  const fullPath = join(root, DISCOVERY_PROMPT_PATH);
  return readFileSync(fullPath, "utf-8");
}
