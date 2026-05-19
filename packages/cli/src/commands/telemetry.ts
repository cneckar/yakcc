// SPDX-License-Identifier: MIT
//
// telemetry.ts — handler for `yakcc telemetry [--path] [--tail N]`
//
// @decision DEC-CLI-TELEMETRY-COMMAND-001
// title: `yakcc telemetry` surfaces telemetry-dir location and session event logs
// status: accepted (WI-760)
// rationale:
//   Alpha testers look in <project>/.yakcc/telemetry/ (intuitive but wrong) and
//   conclude the hook is broken. This command provides a CLI affordance to discover
//   and inspect ~/.yakcc/telemetry/ without knowing the path a priori. Three
//   sub-actions: --path (print resolved dir), --tail N (last N lines from newest
//   session), and the default listing (session files with event counts + last-seen
//   timestamps). Zero network I/O; pure local reads (B6 air-gap compliance).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolveTelemetryDir } from "@yakcc/hooks-base/telemetry.js";
import type { Logger } from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count the number of non-empty JSONL lines in a file. */
function countLines(filePath: string): number {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/** Read the last N non-empty lines from a file. */
function lastNLines(filePath: string, n: number): string[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

/** Format a Date as a human-readable relative timestamp. */
function relativeTime(ms: number): string {
  const diffMs = Date.now() - ms;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc telemetry [--path] [--tail <n>]`.
 *
 * Default (no flags): lists all session JSONL files in the telemetry dir with
 * event counts and last-modified timestamps.
 *
 * --path: prints the resolved telemetry directory (honouring YAKCC_TELEMETRY_DIR).
 * --tail N: prints the last N events from the most recent session JSONL file.
 *
 * @param argv   - Remaining argv after `telemetry` has been consumed.
 * @param logger - Output sink.
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function telemetry(argv: readonly string[], logger: Logger): Promise<number> {
  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        path: { type: "boolean" };
        tail: { type: "string" };
      };
    }>
  >;

  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        path: { type: "boolean" },
        tail: { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    logger.error(`error: ${(err as Error).message}`);
    logger.error("Usage: yakcc telemetry [--path] [--tail <n>]");
    return 1;
  }

  const dir = resolveTelemetryDir();

  // --path: just print the resolved directory
  if (parsed.values.path === true) {
    logger.log(dir);
    return 0;
  }

  // Validate --tail early (before any I/O) so bad values always error regardless of dir state.
  const tailRaw = parsed.values.tail;
  let tailN: number | undefined;
  if (tailRaw !== undefined) {
    const n = Number.parseInt(tailRaw, 10);
    if (Number.isNaN(n) || n < 1) {
      logger.error(`error: --tail requires a positive integer, got: ${tailRaw}`);
      return 1;
    }
    tailN = n;
  }

  // Ensure the directory exists (may never have been written to yet)
  if (!existsSync(dir)) {
    logger.log(`${dir}`);
    logger.log(
      "  (no sessions yet — use Claude Code with the hook installed to generate telemetry)",
    );
    return 0;
  }

  // Collect .jsonl files
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(dir, f));
  } catch (err) {
    logger.error(`error: cannot read telemetry dir ${dir}: ${String(err)}`);
    return 1;
  }

  if (files.length === 0) {
    logger.log(`${dir}`);
    logger.log(
      "  (no session files yet — use Claude Code with the hook installed to generate telemetry)",
    );
    return 0;
  }

  // Sort by mtime descending (newest first)
  const withStats = files
    .map((f) => {
      try {
        const st = statSync(f);
        return { path: f, name: f.split("/").pop() ?? f, mtime: st.mtimeMs };
      } catch {
        return { path: f, name: f.split("/").pop() ?? f, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime);

  // --tail N: print last N events from the newest session (tailN already validated above)
  if (tailN !== undefined) {
    const newest = withStats[0];
    if (newest === undefined) {
      logger.log("(no sessions)");
      return 0;
    }
    const lines = lastNLines(newest.path, tailN);
    if (lines.length === 0) {
      logger.log(`(${newest.name} — no events)`);
      return 0;
    }
    for (const line of lines) {
      logger.log(line);
    }
    return 0;
  }

  // Default: listing
  logger.log(`${dir}`);
  for (const { name, path: filePath, mtime } of withStats) {
    const count = countLines(filePath);
    const rel = mtime > 0 ? relativeTime(mtime) : "unknown";
    logger.log(`  ${name}   (${count} events, latest ${rel})`);
  }
  logger.log("");
  logger.log("Tip: yakcc telemetry --tail 10   to inspect recent events");
  logger.log("     yakcc telemetry --path        to print the directory path");

  return 0;
}
