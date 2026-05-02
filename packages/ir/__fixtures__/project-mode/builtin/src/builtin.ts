// Fixture: builtin/src/builtin.ts
// Purpose: imports from node:fs and node:path (Node built-ins) to verify that
// project mode resolves @types/node declarations and emits zero no-untyped-imports
// violations. Isolated mode (in-memory project without @types/node) emits a false
// positive for these imports because no declaration files are available.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export function read(p: string): string {
  return readFileSync(join(".", p), "utf-8");
}
