// Fixture: comparison/src/uses-builtin.ts
// Purpose: imports from node:path (Node built-in) to exercise the false-positive
// comparison case. Project mode resolves @types/node declarations; isolated mode
// emits no-untyped-imports because the in-memory project lacks @types/node.

import { basename } from "node:path";

export function getBase(p: string): string {
  return basename(p);
}
