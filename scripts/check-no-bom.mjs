#!/usr/bin/env node
/**
 * @decision DEC-CI-NO-BOM-GUARD-001
 * Title:    Workspace-wide BOM CI gate — pure node:fs walker, zero deps
 * Status:   accepted (WI-755)
 * Rationale: Biome 1.9.4 has no first-party noUtf8Bom rule; a 30-LOC pure-node
 *            walker is simpler, dependency-free, and easier to debug than a
 *            third-party lint plugin. Wired into `pnpm -w lint` after
 *            `turbo run lint` — one authority, one failure mode, zero CI YAML
 *            changes. See plans/wi-755-bom-strip.md §2 and §9 for full
 *            decision record.
 *
 * Usage:
 *   node scripts/check-no-bom.mjs          # exits 0 (clean) or 1 (violations)
 *   pnpm check-bom                          # same, via package.json script alias
 *
 * Extensions:
 *   To add skip dirs, extend SKIP_DIRS below.
 *   To scan additional extensions, extend SCAN_EXTS below.
 *   The scanner never modifies files — it is read-only and safe to run at any time.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = process.cwd();

// Directories whose contents are never scanned.
// "docs" is excluded because docs/archive/developer/MASTER_PLAN.md is a
// governance-write-restricted file intentionally outside this WI's scope.
// All other entries are standard generated/vendor/build-output dirs.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".turbo",
  ".worktrees",
  "tmp",
  "runtime",
  ".pnpm-store",
  ".vscode",
  "docs",
]);

// Text-file extensions checked for a leading BOM.
const SCAN_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yaml",
  ".yml",
  ".md",
]);

const BOM_0 = 0xef;
const BOM_1 = 0xbb;
const BOM_2 = 0xbf;

let scannedDirs = 0;
let scannedFiles = 0;
const offenders = [];

/**
 * Recursively walk `dir`, skipping SKIP_DIRS, collecting BOM-bearing files.
 * Only the first 3 bytes of each candidate file are examined (Buffer.subarray
 * avoids a full read, but the underlying readFileSync does read the whole
 * inode into the V8 heap; for 5-10k workspace files this is still <500 ms on
 * NTFS/ext4 in practice — see DEC-CI-NO-BOM-GUARD-001 tradeoff note).
 *
 * @param {string} dir - Absolute path of directory to scan.
 */
function walk(dir) {
  scannedDirs += 1;
  /** @type {import("node:fs").Dirent[]} */
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // Unreadable directory (permissions, broken symlink) — skip silently.
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full);
      continue;
    }

    if (!entry.isFile()) continue;

    // Fast extension filter — avoids stat + read for non-candidate files.
    const dot = entry.name.lastIndexOf(".");
    if (dot < 0) continue;
    const ext = entry.name.slice(dot);
    if (!SCAN_EXTS.has(ext)) continue;

    scannedFiles += 1;

    try {
      // Read the entire file to get a Buffer, then look at only the first 3
      // bytes.  Switching to open()+read() with a 3-byte buffer would be
      // faster on large files, but the current workspace is small enough that
      // the simpler readFileSync path is acceptable (DEC-CI-NO-BOM-GUARD-001).
      const buf = readFileSync(full);
      if (buf.length >= 3 && buf[0] === BOM_0 && buf[1] === BOM_1 && buf[2] === BOM_2) {
        offenders.push(relative(REPO_ROOT, full));
      }
    } catch {
      // Unreadable file (permissions, transient error) — skip silently.
    }
  }
}

walk(REPO_ROOT);

if (offenders.length > 0) {
  process.stderr.write(
    `check-no-bom: UTF-8 BOM detected in ${offenders.length} file(s):\n`,
  );
  for (const f of offenders) {
    process.stderr.write(`  ${f}\n`);
  }
  process.stderr.write("\n");
  process.stderr.write("Strip the leading 3 bytes (EF BB BF). One-liner per file:\n");
  process.stderr.write(
    "  tail -c +4 <file> > <file>.nobom && mv <file>.nobom <file>\n",
  );
  process.exit(1);
}

process.stdout.write(
  `check-no-bom: OK no BOM found (${scannedFiles} files, ${scannedDirs} dirs)\n`,
);
process.exit(0);
