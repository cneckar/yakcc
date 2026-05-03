// SPDX-License-Identifier: MIT
// Fixture A: foreign-block test fixture for WI-V2-04 L5.
// Tests the classifyForeign + policy gate path for node:fs#readFileSync.
// Authority: packages/shave/src/__fixtures__/ (L5-I1)
import { readFileSync } from "node:fs";

export function readContents(path: string): string {
  return readFileSync(path, "utf-8");
}
