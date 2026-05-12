// SPDX-License-Identifier: MIT
//
// @decision DEC-DIST-PACKAGING-002
// @title pkg SEA binary: sqlite3_load_extension intercept for snapshot-resident .so files
// @status accepted
// @rationale
//   pkg bundles files inside a virtual snapshot at /snapshot/<worktree>/...
//   Node.js modules loaded from the snapshot (via the VFS fs-hook) work correctly,
//   but native extensions loaded via SQLite's sqlite3_load_extension() call
//   dlopen() directly at the OS level, bypassing the VFS.  The OS dlopen() cannot
//   open files inside the virtual /snapshot path.
//
//   The pkg bootstrap already patches process.dlopen for .node addons (extracting
//   them to ~/.cache/pkg/<hash>/<name>/ before loading), but that patch only
//   applies to Node's process.dlopen, not to sqlite3_load_extension's internal dlopen.
//
//   This module patches Database.prototype.loadExtension early (before any registry
//   command runs) so that when sqlite-vec calls db.loadExtension('/snapshot/.../vec0.so'),
//   the file is first extracted from the VFS to a real temp path and the real path is
//   passed instead.
//
//   The snapshot check uses the same /snapshot prefix convention that pkg injects.
//   The extraction cache mirrors patchDlopen's convention: ~/.cache/pkg/<sha256>/<basename>.
//   This is a no-op when running from source (non-snapshot paths pass through unchanged).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** Returns true when the path lives inside the pkg snapshot virtual filesystem. */
function insideSnapshot(p: string): boolean {
  return p.startsWith("/snapshot/") || p.startsWith("/snapshot");
}

/**
 * Extracts a file from the pkg snapshot to a stable on-disk location and
 * returns the real path.  Safe to call multiple times for the same file
 * (idempotent via SHA-256 content check).
 */
function extractFromSnapshot(snapshotPath: string): string {
  const content = readFileSync(snapshotPath); // reads via pkg VFS
  const hash = createHash("sha256").update(content).digest("hex");
  const cacheBase = process.env.PKG_NATIVE_CACHE_PATH ?? join(homedir(), ".cache");
  const cacheDir = join(cacheBase, "pkg", hash);
  mkdirSync(cacheDir, { recursive: true });
  const dest = join(cacheDir, basename(snapshotPath));
  if (existsSync(dest)) {
    // Same hash → same content, no need to rewrite.
    const existing = readFileSync(dest);
    if (createHash("sha256").update(existing).digest("hex") === hash) {
      return dest;
    }
  }
  writeFileSync(dest, content, { mode: 0o755 });
  return dest;
}

/**
 * Applies the snapshot extraction patch to a better-sqlite3 Database prototype.
 * Called once at startup; idempotent (guarded by a brand symbol).
 *
 * @param Database - The Database constructor from better-sqlite3.
 */
const PATCHED_BRAND = Symbol.for("pkg-native-compat-patched");

export function patchSqliteDatabase(Database: {
  prototype: { loadExtension?: (...args: unknown[]) => unknown };
}): void {
  // Guard against double-patching (e.g. multiple imports of this module).
  if ((Database as Record<symbol, unknown>)[PATCHED_BRAND]) return;
  (Database as Record<symbol, unknown>)[PATCHED_BRAND] = true;

  const original = Database.prototype.loadExtension;
  if (typeof original !== "function") return;

  Database.prototype.loadExtension = function patchedLoadExtension(...args: unknown[]) {
    const path = args[0];
    if (typeof path === "string" && insideSnapshot(path)) {
      args[0] = extractFromSnapshot(path);
    }
    return original.call(this, ...args);
  };
}
