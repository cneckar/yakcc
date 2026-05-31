// SPDX-License-Identifier: MIT
//
// claude-md-config.ts — idempotent CLAUDE.md context-injection writer
//
// @decision DEC-1008-CLAUDE-MD-CONTEXT-INJECT-001
// title: CLAUDE.md @-import is the load-bearing mechanism for injecting
//        yakcc-discovery guidance into the LLM context — distinct from hook wiring
// status: accepted (WI-1008-discovery-inject)
// rationale:
//   PROBLEM:
//     docs/system-prompts/yakcc-discovery.md (score bands, self-check,
//     descent-and-compose, compile-and-stop, triplet format) never reaches the
//     LLM context.  discovery-snippet.ts only writes a promptRef reference inside
//     .claude/settings.json; nothing causes Claude Code to load the body into the
//     model's working context.  B4-v5 trace evidence: Sonnet hedged and Haiku
//     tried to re-fetch the body — behaviors the full guidance would address.
//
//   MECHANISM CHOICE — @-import in CLAUDE.md:
//     Claude Code auto-loads every CLAUDE.md in the project hierarchy into model
//     context on session start (confirmed: ~/.claude/CLAUDE.md uses "@RTK.md" to
//     import RTK.md).  A project-root CLAUDE.md line of the form
//       @docs/system-prompts/yakcc-discovery.md
//     causes Claude Code to splice the file contents inline at load time.  The LLM
//     receives the full 299-line guidance without the CLI needing to inline the body.
//
//   RELATION TO DEC-CLI-HOOKS-INSTALL-002 / DEC-953B-SURFACE-SETTINGS-001:
//     Those decisions retired the v0 CLAUDE.md *hook-wiring* facade (which wrote
//     a settings.json hook entry via CLAUDE.md instructions — a wrong layer).
//     This write is for *instruction-context loading* — a different concern.
//     The hook wiring still lives in .claude/settings.json (unchanged).
//     The discovery body injection lives in CLAUDE.md (new, additive).
//     Two concerns, two surfaces, one authority each.  No parallel mechanisms.
//
//   SINGLE-AUTHORITY:
//     The canonical 299-line body is still docs/system-prompts/yakcc-discovery.md
//     governed by DEC-V3-DISCOVERY-D4-001.  This file never copies or re-states
//     the body; it only writes the @-import directive that causes Claude Code to
//     load it.  The body remains the single authority; this file is an adapter.
//
//   IDEMPOTENCY:
//     The managed section is delimited by sentinels so re-running `yakcc init`
//     never duplicates content or stomps user customizations outside the section.
//     Existing CLAUDE.md content (project-specific instructions) is preserved.
//
//   ROLLBACK:
//     Revert the WI-1008 slice PR; the managed section is additive and guarded by
//     sentinels so existing CLAUDE.md content is never lost even if this file is
//     removed.  Any CLAUDE.md written by this helper can be safely deleted by the
//     user without affecting the registry or hook wiring.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Relative path (from the project root) to the canonical discovery prompt body.
 * Governed by DEC-V3-DISCOVERY-D4-001.
 */
const CANONICAL_PROMPT_PATH = "docs/system-prompts/yakcc-discovery.md";

/**
 * Sentinel markers that delimit the yakcc-managed section in CLAUDE.md.
 * The section content is idempotently updated in-place; text outside the
 * sentinel range is never touched.
 */
const SECTION_START = "<!-- yakcc-discovery:start -->";
const SECTION_END = "<!-- yakcc-discovery:end -->";

/**
 * The managed section body.
 *
 * Uses the Claude Code @-import directive so the 299-line discovery prompt
 * body is spliced into the model context at session load time without being
 * duplicated in this file (DEC-1008-CLAUDE-MD-CONTEXT-INJECT-001).
 */
const MANAGED_SECTION = `${SECTION_START}
## yakcc discovery

@${CANONICAL_PROMPT_PATH}
${SECTION_END}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result returned by writeCLaudeMdDiscovery.
 */
export interface WriteCLaudeMdResult {
  /** True when the section was already present and up-to-date (no write). */
  alreadyInstalled: boolean;
  /** True when CLAUDE.md did not exist and was freshly created. */
  created: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Read CLAUDE.md content from the given path.
 * Returns empty string when the file does not exist.
 */
function readCLaudeMd(claudeMdPath: string): string {
  if (!existsSync(claudeMdPath)) return "";
  return readFileSync(claudeMdPath, "utf-8");
}

/**
 * Return true when the managed section is already present verbatim in
 * the given CLAUDE.md content.
 *
 * We check for the start sentinel to detect presence (the body may change
 * across yakcc versions; presence of the start marker is sufficient for
 * the idempotency check; the section is replaced in-place if the body
 * has drifted from the current MANAGED_SECTION).
 */
export function hasManagedSection(content: string): boolean {
  return content.includes(SECTION_START);
}

/**
 * Replace an existing managed section in `content` with the current
 * MANAGED_SECTION body, or append it if no section is present.
 *
 * Preserves all text outside the sentinel range unchanged.
 */
function upsertManagedSection(content: string): string {
  if (content.includes(SECTION_START)) {
    // Replace the existing section (start through end, inclusive).
    // Use a regex so we replace the full block regardless of trailing newlines.
    const replaced = content.replace(
      new RegExp(`${escapeRegex(SECTION_START)}[\\s\\S]*?${escapeRegex(SECTION_END)}`),
      MANAGED_SECTION,
    );
    return replaced;
  }

  // Append: ensure a clean newline separation before the section.
  const separator =
    content.length > 0 && !content.endsWith("\n") ? "\n\n" : content.length > 0 ? "\n" : "";
  return `${content}${separator}${MANAGED_SECTION}\n`;
}

/** Escape special regex metacharacters in a literal string. */
function escapeRegex(s: string): string {
  return s.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Idempotently write (or update) the yakcc-discovery managed section into
 * the project-root CLAUDE.md so Claude Code auto-loads the discovery guidance
 * into the LLM context on every session start.
 *
 * Called from `yakcc init` after the claude-code hook installer completes
 * (DEC-1008-CLAUDE-MD-CONTEXT-INJECT-001).
 *
 * Behavior:
 *  - If CLAUDE.md does not exist: creates it with only the managed section.
 *  - If CLAUDE.md exists and contains the section start sentinel: replaces
 *    the existing section (safe for body-drift between yakcc versions) — all
 *    text outside the sentinel range is preserved.
 *  - If CLAUDE.md exists without the section: appends the section, separated
 *    by a blank line from the last line of existing content.
 *
 * Re-entrant: calling this function N times produces the same result as once.
 *
 * @param targetDir - Project root (same as the `--target` flag to `yakcc init`).
 * @returns WriteCLaudeMdResult with alreadyInstalled and created flags.
 */
export function writeCLaudeMdDiscovery(targetDir: string): WriteCLaudeMdResult {
  const claudeMdPath = join(targetDir, "CLAUDE.md");
  const existing = readCLaudeMd(claudeMdPath);
  const created = !existsSync(claudeMdPath);

  if (hasManagedSection(existing)) {
    // Check whether the existing section body is up-to-date.
    const startIdx = existing.indexOf(SECTION_START);
    const endIdx = existing.indexOf(SECTION_END, startIdx);
    if (endIdx !== -1) {
      const currentBody = existing.slice(startIdx, endIdx + SECTION_END.length);
      if (currentBody === MANAGED_SECTION) {
        // Verbatim match — genuinely idempotent, no write needed.
        return { alreadyInstalled: true, created: false };
      }
    }
  }

  const updated = upsertManagedSection(existing);
  writeFileSync(claudeMdPath, updated, "utf-8");
  return { alreadyInstalled: false, created };
}
