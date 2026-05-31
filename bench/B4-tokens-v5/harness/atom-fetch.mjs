// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v5/harness/atom-fetch.mjs
//
// @decision DEC-BENCH-B4-V5-ATOM-FETCH-001
// @title Atom body fetch for substitution oracle — reuses production getBlock() query
// @status accepted
// @rationale
//   When the model emits `yakcc compile <atom_id>`, the substitution oracle must
//   run against the atom's REAL impl body, not a stub comment.  This module
//   fetches `impl_source` from the registry SQLite using the same
//   `SELECT impl_source FROM blocks WHERE block_merkle_root = ?` query that
//   storage.ts#getBlock() issues — reuse of the production read path
//   (Sacred Practice #12).  We use better-sqlite3 via createRequire from the
//   registry package so we get the same binary that the production stack uses;
//   no duplicate native addon loading.
//
//   sqlite-vec is loaded to satisfy the vec0 virtual table referenced by the
//   schema even though our query doesn't touch the vector table.  Omitting it
//   causes "no such module: vec0" on prepare().
//
// Exports:
//   fetchAtomImplSource(registryPath, atomId) → { implSource: string } | { error: string }

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the true repo root that has packages/registry/node_modules installed.
// In a git worktree, process.env.YAKCC_REPO_ROOT should be set to the main repo.
// Fallback: walk up from __dirname until we find a root with better-sqlite3.
// This avoids assuming a fixed depth, which breaks in worktrees.
function findRepoRoot() {
  const envRoot = process.env.YAKCC_REPO_ROOT;
  if (envRoot && existsSync(join(envRoot, "packages", "registry", "package.json"))) return envRoot;

  // Walk up from bench/B4-tokens-v5/harness looking for the root with registry node_modules.
  let candidate = resolve(__dirname, "../../..");
  for (let i = 0; i < 4; i++) {
    const betterSqlite = join(candidate, "packages", "registry", "node_modules", "better-sqlite3");
    if (existsSync(betterSqlite)) return candidate;
    candidate = resolve(candidate, "..");
  }
  // Last resort: env var or 3-levels-up (may fail at load time with a clear error)
  return resolve(__dirname, "../../..");
}

const REPO_ROOT = findRepoRoot();

// Resolve better-sqlite3 and sqlite-vec from the registry package's node_modules.
// The registry package is the production authority for the SQLite binding
// (DEC-STORAGE-LIBRARY-001 in packages/registry/src/storage.ts).
const REGISTRY_STORAGE_JS = join(REPO_ROOT, "packages", "registry", "dist", "storage.js");

// createRequire resolves CJS modules relative to the given file/directory path.
const registryRequire = createRequire(REGISTRY_STORAGE_JS);

let _Database = null;
let _sqliteVec = null;

function getBetterSqlite3() {
  if (!_Database) {
    _Database = registryRequire("better-sqlite3");
  }
  return _Database;
}

function getSqliteVec() {
  if (!_sqliteVec) {
    _sqliteVec = registryRequire("sqlite-vec");
  }
  return _sqliteVec;
}

/**
 * Return the total number of atoms (blocks) in the registry.
 * Used to populate registry_atom_count in rep_meta (PROTOCOL.md §3.4).
 *
 * @param {string} registryPath  Absolute path to the registry SQLite file.
 * @returns {number}  Count, or -1 if the registry can't be opened.
 */
export function countRegistryAtoms(registryPath) {
  if (!existsSync(registryPath)) return -1;
  let db = null;
  try {
    const Database = getBetterSqlite3();
    const sqliteVec = getSqliteVec();
    db = new Database(registryPath, { readonly: true });
    sqliteVec.load(db);
    const row = db.prepare("SELECT COUNT(*) AS n FROM blocks").get();
    return row?.n ?? -1;
  } catch (_) {
    return -1;
  } finally {
    if (db) {
      try {
        db.close();
      } catch (_) {}
    }
  }
}

/**
 * Fetch the impl_source for an atom by its block merkle root.
 *
 * This is the same query storage.ts#getBlock() issues:
 *   SELECT * FROM blocks WHERE block_merkle_root = ?
 * but we only read impl_source to keep the bench harness free of the full
 * registry type stack.
 *
 * @param {string} registryPath  Absolute path to the registry SQLite file.
 * @param {string} atomId        The block_merkle_root (64-char hex).
 * @returns {{ implSource: string } | { error: string, failure_class: string }}
 */
export function fetchAtomImplSource(registryPath, atomId) {
  if (!existsSync(registryPath)) {
    return {
      error: `Registry not found: ${registryPath}`,
      failure_class: "atom_fetch_failed",
    };
  }
  if (!atomId || typeof atomId !== "string" || !/^[a-f0-9]{1,64}$/i.test(atomId)) {
    return {
      error: `Invalid atom_id format: ${atomId}`,
      failure_class: "atom_fetch_failed",
    };
  }

  let db = null;
  try {
    const Database = getBetterSqlite3();
    const sqliteVec = getSqliteVec();

    db = new Database(registryPath, { readonly: true });
    sqliteVec.load(db);

    const row = db
      .prepare("SELECT impl_source FROM blocks WHERE block_merkle_root = ?")
      .get(atomId);

    if (row === undefined) {
      return {
        error: `Atom not found in registry: ${atomId}`,
        failure_class: "atom_fetch_failed",
      };
    }

    return { implSource: row.impl_source };
  } catch (err) {
    return {
      error: `SQLite error fetching atom ${atomId}: ${err.message ?? String(err)}`,
      failure_class: "atom_fetch_failed",
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch (_) {}
    }
  }
}
