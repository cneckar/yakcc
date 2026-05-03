// @ts-nocheck
// SPDX-License-Identifier: MIT
// Fixture B: foreign-block test fixture for WI-V2-04 L5.
// Tests the classifyForeign + policy gate path for sqlite-vec#load (aliased loadVec).
// @ts-nocheck: sqlite-vec is not a declared dependency of @yakcc/shave; it is
// intentionally present as an import declaration for classifyForeign() to detect.
// classifyForeign() parses source text via in-memory ts-morph and does not resolve
// modules, so this fixture need not compile with strict type resolution.
// Authority: packages/shave/src/__fixtures__/ (L5-I1)
import { load as loadVec } from "sqlite-vec";

export function attachVectorSearch(db: unknown): void {
  loadVec(db);
}
