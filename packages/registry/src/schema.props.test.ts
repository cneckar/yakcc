// SPDX-License-Identifier: MIT
// Vitest harness for schema.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling schema.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_applyMigrations_fresh_db_bumps_version,
  prop_applyMigrations_idempotent_at_current_version,
  prop_schema_version_is_positive_integer,
} from "./schema.props.js";

// applyMigrations runs against an in-memory mock DB — no SQLite, no sqlite-vec.
// numRuns: 100 is sufficient (properties use fc.constant, so the arbitrary space is trivial).
const opts = { numRuns: 100 };

it("property: prop_schema_version_is_positive_integer", () => {
  fc.assert(prop_schema_version_is_positive_integer, opts);
});

it("property: prop_applyMigrations_idempotent_at_current_version", () => {
  fc.assert(prop_applyMigrations_idempotent_at_current_version, opts);
});

it("property: prop_applyMigrations_fresh_db_bumps_version", () => {
  fc.assert(prop_applyMigrations_fresh_db_bumps_version, opts);
});
