// @decision DEC-CLI-HOOKS-INSTALL-001: hooks claude-code install writes a CLAUDE.md
// slash-command stub to the target directory's .claude/ folder. In v0 this is a
// facade: the slash command exists and is documented, but its handler returns the
// stubbed-flow message ("v0.5 feature") rather than performing a live registry search.
// Status: implemented (WI-009)
// Rationale: DEC-V0-HOOK-002 locks the install/command surface in v0 so that v0.5 is
// a behavioral change, not an interface change. The install command must work and exit 0
// now; the actual synthesis and registry-hit paths land in v0.5.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Logger } from "../index.js";

/**
 * The v0 stub message returned when the /yakcc slash command is invoked.
 * v0.5 replaces this with real registry search + synthesis-required routing.
 */
export const SLASH_COMMAND_STUB_MESSAGE =
  "[yakcc v0.5 feature] Real-time registry lookup and block synthesis are not yet wired. " +
  "Use `yakcc compile` + `yakcc seed` to assemble programs from the seed corpus manually.";

/**
 * The CLAUDE.md content written to the target project's .claude/ directory.
 * Documents the /yakcc slash command surface so Claude Code sees it on startup.
 */
function buildClaudeMdContent(): string {
  return `# Yakcc slash command

This project has Yakcc installed. The \`/yakcc\` slash command is available in
Claude Code to look up content-addressed basic blocks from the local registry.

## /yakcc <intent>

Searches the Yakcc registry for a block matching \`<intent>\`. If a registry hit
is found, it returns the block's ContractId so you can reference it in your
compile step. If no match is found, it starts the manual block-authoring flow.

**v0 status:** This command is a facade. Registry search and synthesis are
wired in v0.5. The command will acknowledge your intent and instruct you to use
\`yakcc compile\` manually for now.

**Response (v0):** ${SLASH_COMMAND_STUB_MESSAGE}
`;
}

/**
 * Handler for `yakcc hooks claude-code install [--target <dir>]`.
 *
 * Writes .claude/CLAUDE.md to the target directory documenting the /yakcc
 * slash-command surface. Exits 0 on success.
 *
 * @param argv - Remaining argv after `hooks claude-code install` has been consumed.
 * @param logger - Output sink.
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function hooksClaudeCodeInstall(
  argv: readonly string[],
  logger: Logger,
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      target: { type: "string", short: "t" },
    },
    allowPositionals: false,
    strict: true,
  });

  const targetDir = values.target ?? ".";
  const claudeDir = join(targetDir, ".claude");
  const claudeMdPath = join(claudeDir, "CLAUDE.md");

  try {
    mkdirSync(claudeDir, { recursive: true });
  } catch (err) {
    logger.error(`error: cannot create ${claudeDir}: ${String(err)}`);
    return 1;
  }

  try {
    writeFileSync(claudeMdPath, buildClaudeMdContent(), "utf-8");
  } catch (err) {
    logger.error(`error: cannot write ${claudeMdPath}: ${String(err)}`);
    return 1;
  }

  logger.log(`yakcc hooks installed at ${claudeMdPath}`);
  logger.log("slash command: /yakcc <intent>");
  logger.log(`stub response: ${SLASH_COMMAND_STUB_MESSAGE}`);
  return 0;
}
