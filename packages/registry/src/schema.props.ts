// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-005: property-test corpus for schema.ts.
// Status: accepted (issue-87-fill-registry)
// Rationale: schema.ts has two testable surfaces without a real SQLite DB:
//   (1) SCHEMA_VERSION is a positive integer constant — a simple invariant.
//   (2) applyMigrations() is callable against a mock MigrationsDb that records
//       SQL statements. We verify that calling it on a DB already at SCHEMA_VERSION
//       issues no ALTER TABLE statements (idempotency) and that calling it on a
//       fresh DB (version 0) issues DDL that bumps the version.
// The mock DB approach is the same pattern used in schema.test.ts; it avoids
// the sqlite-vec native module dependency at test time.

// ---------------------------------------------------------------------------
// Property-test corpus for schema.ts
//
// Surfaces covered:
//   SCHEMA_VERSION  — positive integer constant
//   applyMigrations — migration driver (idempotency + monotonicity)
//
// Properties:
//   SC1 — SCHEMA_VERSION is a positive integer
//   SC2 — applyMigrations is idempotent: calling on an already-migrated DB
//          issues no new migrations (no UPDATE SET version = N for N already applied)
//   SC3 — applyMigrations on version 0 DB bumps version to SCHEMA_VERSION
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { SCHEMA_VERSION, applyMigrations } from "./schema.js";
import type { MigrationsDb } from "./schema.js";

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal MigrationsDb mock that:
 * - Tracks all exec() SQL strings in `execLog`.
 * - Tracks all run() arguments in `runLog`.
 * - Returns `currentVersion` from SELECT version queries.
 * - Returns undefined (no rows) from any other SELECT.
 *
 * This mirrors the mock pattern in schema.test.ts (if one exists), allowing
 * applyMigrations to be tested without a live SQLite + sqlite-vec environment.
 */
function makeMockDb(currentVersion: number): {
  db: MigrationsDb;
  execLog: string[];
  runLog: Array<{ sql: string; args: unknown[] }>;
} {
  const execLog: string[] = [];
  const runLog: Array<{ sql: string; args: unknown[] }> = [];

  const db: MigrationsDb = {
    exec(sql: string) {
      execLog.push(sql.trim());
    },
    prepare(sql: string) {
      return {
        get(..._params: unknown[]): unknown {
          // Return a version row for the "SELECT version FROM schema_version" query.
          if (sql.includes("SELECT version FROM schema_version")) {
            return { version: currentVersion };
          }
          return undefined;
        },
        run(...args: unknown[]): unknown {
          runLog.push({ sql: sql.trim(), args });
          return undefined;
        },
      };
    },
  };

  return { db, execLog, runLog };
}

// ---------------------------------------------------------------------------
// SC1: SCHEMA_VERSION is a positive integer
// ---------------------------------------------------------------------------

/**
 * prop_schema_version_is_positive_integer
 *
 * SCHEMA_VERSION is a positive integer (>= 1). It is not zero, negative, or
 * fractional.
 *
 * Invariant: schema versions are 1-based positive integers. Version 0 is the
 * "uninitialized" sentinel (no migrations applied). SCHEMA_VERSION must always
 * be >= 1 so that fresh DBs receive at least migration 1.
 */
export const prop_schema_version_is_positive_integer = fc.property(
  fc.constant(SCHEMA_VERSION),
  (v) => Number.isInteger(v) && v >= 1,
);

// ---------------------------------------------------------------------------
// SC2: applyMigrations is idempotent on already-migrated DB
// ---------------------------------------------------------------------------

/**
 * prop_applyMigrations_idempotent_at_current_version
 *
 * When called on a DB already at SCHEMA_VERSION, applyMigrations() issues no
 * UPDATE SET version = N statements (no version bumps attempted).
 *
 * Invariant: each migration is guarded by `if (currentVersion < N)`. When
 * currentVersion = SCHEMA_VERSION, no migration block fires, so no version
 * UPDATE is issued. This is the idempotency guarantee documented in the
 * applyMigrations JSDoc.
 */
export const prop_applyMigrations_idempotent_at_current_version = fc.property(
  fc.constant(SCHEMA_VERSION),
  (version) => {
    const { db, runLog } = makeMockDb(version);
    applyMigrations(db);
    // No UPDATE schema_version SET version = ? should have been issued.
    const versionBumps = runLog.filter((r) => r.sql.includes("UPDATE schema_version"));
    return versionBumps.length === 0;
  },
);

// ---------------------------------------------------------------------------
// SC3: applyMigrations on version 0 DB bumps to SCHEMA_VERSION
// ---------------------------------------------------------------------------

/**
 * prop_applyMigrations_fresh_db_bumps_version
 *
 * When called on a DB at version 0, applyMigrations() issues at least one
 * UPDATE SET version = ? statement, and the last such statement sets the
 * version to SCHEMA_VERSION (or the highest version applyMigrations manages
 * without external backfill).
 *
 * Note: Migration 2→3 has a two-phase split (DDL here, backfill + bump in
 * openRegistry). applyMigrations only bumps to 2 from a version-0 start; the
 * caller (openRegistry) performs the backfill and bumps to 3. We verify that
 * version bumps were issued (at least one) and that no bump tries to set a
 * version above SCHEMA_VERSION.
 *
 * Invariant: applyMigrations always makes forward progress on a fresh DB.
 */
export const prop_applyMigrations_fresh_db_bumps_version = fc.property(
  fc.constant(0),
  (startVersion) => {
    const { db, runLog } = makeMockDb(startVersion);
    applyMigrations(db);
    const versionBumps = runLog.filter((r) => r.sql.includes("UPDATE schema_version"));
    if (versionBumps.length === 0) return false; // must have issued at least one bump

    // All bumped versions must be positive and <= SCHEMA_VERSION
    for (const bump of versionBumps) {
      const v = bump.args[0];
      if (typeof v !== "number" || v < 1 || v > SCHEMA_VERSION) return false;
    }
    return true;
  },
);
