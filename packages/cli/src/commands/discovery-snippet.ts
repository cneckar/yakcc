// SPDX-License-Identifier: MIT
//
// discovery-snippet.ts — idempotent discovery-instruction writer for `.claude/settings.json`
//
// @decision DEC-953B-SNIPPET-REFERENCE-001
// title: snippet REFERENCES docs/system-prompts/yakcc-discovery.md — does NOT inline the body
// status: accepted (WI-953, bite 2)
// rationale:
//   The canonical 12.5 KB system-prompt body lives in
//   docs/system-prompts/yakcc-discovery.md and is governed by D4 ADR
//   (discovery-llm-interaction.md).  Inlining it into settings.json would create
//   a second copy that drifts independently of the ADR authority.  Instead, the
//   snippet embeds a short imperative ("call yakcc_resolve before emitting code")
//   plus an explicit reference to the file path so the operator/IDE can surface
//   the full body without any duplication.
//
// @decision DEC-953B-SURFACE-SETTINGS-001
// title: claude-code discovery instruction rides .claude/settings.json — no CLAUDE.md resurrect
// status: accepted (WI-953, bite 2)
// rationale:
//   DEC-CLI-HOOKS-INSTALL-002 deliberately retired the v0 `.claude/CLAUDE.md`
//   facade.  Per Sacred Practice #12 only one instruction surface may exist for a
//   given IDE.  The existing installer (hooksClaudeCodeInstall) already owns
//   `.claude/settings.json`; the discovery snippet extends that surface by adding
//   a `yakcc-discovery` key inside the same JSON file.  No parallel writer, no
//   new file, no CLAUDE.md resurrection.
//
//   Cross-references:
//     DEC-CLI-HOOKS-INSTALL-002 — CLAUDE.md retirement decision
//     DEC-HOOK-PROACTIVE-A-001  — discovery initiative umbrella
//     docs/system-prompts/yakcc-discovery.md — the canonical discovery prompt body

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Marker key written into .claude/settings.json under "yakcc-discovery".
 * The installer checks for its presence to provide idempotency.
 */
const DISCOVERY_MARKER_KEY = "yakcc-discovery";

/**
 * Sentinel string stored in settings.json["yakcc-discovery"]._marker so the
 * reader can reliably detect "already installed" vs any other value on that key.
 */
const DISCOVERY_MARKER_VERSION = "yakcc-discovery-v1";

/**
 * Relative path (from the project root) to the canonical discovery prompt.
 * DEC-953B-SNIPPET-REFERENCE-001: store the path, not the body.
 */
const CANONICAL_PROMPT_REF = "docs/system-prompts/yakcc-discovery.md";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The shape written under `settings["yakcc-discovery"]`.
 *
 * Fields:
 *  _marker   — version sentinel for idempotency detection.
 *  promptRef — relative path to the D4-ADR-governed discovery prompt body.
 *  instruction — the operative imperative shown to the LLM host.
 */
export interface DiscoverySnippet {
  _marker: typeof DISCOVERY_MARKER_VERSION;
  promptRef: string;
  instruction: string;
}

/**
 * Minimal settings shape for our read-modify-write (other keys are preserved).
 */
interface ClaudeSettings {
  "yakcc-discovery"?: DiscoverySnippet;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Discovery instruction text (operationalizes DEC-953B-SNIPPET-REFERENCE-001)
// ---------------------------------------------------------------------------

/**
 * The short operative imperative embedded in settings.json.
 *
 * This text tells the LLM host what to do; the full "when to call" guidance
 * rides the `yakcc_resolve` MCP tool description (bite 1).  We keep this
 * minimal so the settings.json remains human-readable.  Operators who want the
 * full prompt text load it from promptRef.
 */
const DISCOVERY_INSTRUCTION =
  "Before emitting any code (Edit/Write/MultiEdit), call the yakcc_resolve MCP tool " +
  "with an IntentCard describing your intent. Full guidance in promptRef.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readSettings(settingsPath: string): ClaudeSettings {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, "utf-8")) as ClaudeSettings;
  } catch {
    return {};
  }
}

function writeSettings(settingsPath: string, settings: ClaudeSettings): void {
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

function isDiscoveryInstalled(settings: ClaudeSettings): boolean {
  const d = settings[DISCOVERY_MARKER_KEY];
  return (
    d !== undefined &&
    d !== null &&
    typeof d === "object" &&
    (d as unknown as Record<string, unknown>)._marker === DISCOVERY_MARKER_VERSION
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Result returned by writeDiscoverySnippet.
 */
export interface WriteDiscoveryResult {
  /** True if the snippet was already present (idempotent no-op). */
  alreadyInstalled: boolean;
}

/**
 * Idempotently write (or verify) the yakcc discovery instruction into the IDE
 * instruction surface for the given IDE.
 *
 * Currently only "claude-code" is supported — the instruction rides the existing
 * `.claude/settings.json` surface owned by hooksClaudeCodeInstall
 * (DEC-953B-SURFACE-SETTINGS-001).  Other IDE surfaces are a follow-up.
 *
 * The function is called AFTER installHookForIde() has already created
 * `.claude/settings.json` (the directory and file are guaranteed to exist for
 * claude-code at this point).  For other IDEs the call is a no-op so the call
 * site in init.ts can be unconditional.
 *
 * Idempotency: the `_marker` sentinel ensures re-running init does not
 * duplicate the snippet or overwrite user customisations on the key.
 *
 * @param ide       - IDE name from installHookForIde dispatch.
 * @param targetDir - Project root (same as the --target flag).
 * @returns WriteDiscoveryResult with alreadyInstalled flag.
 */
export function writeDiscoverySnippet(ide: string, targetDir: string): WriteDiscoveryResult {
  // Only claude-code currently has a supported settings.json surface.
  // Other IDEs are future follow-ups (their surfaces are less stable — see
  // hooks-cursor-install.ts / hooks-cline-install.ts comments).
  if (ide !== "claude-code") {
    return { alreadyInstalled: false };
  }

  const claudeDir = join(targetDir, ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  // Ensure .claude/ exists (hooksClaudeCodeInstall creates it; defensive mkdir
  // for the case where writeDiscoverySnippet is called standalone in tests).
  mkdirSync(claudeDir, { recursive: true });

  const settings = readSettings(settingsPath);

  if (isDiscoveryInstalled(settings)) {
    return { alreadyInstalled: true };
  }

  const snippet: DiscoverySnippet = {
    _marker: DISCOVERY_MARKER_VERSION,
    promptRef: CANONICAL_PROMPT_REF,
    instruction: DISCOVERY_INSTRUCTION,
  };

  const updated: ClaudeSettings = {
    ...settings,
    [DISCOVERY_MARKER_KEY]: snippet,
  };

  writeSettings(settingsPath, updated);
  return { alreadyInstalled: false };
}
