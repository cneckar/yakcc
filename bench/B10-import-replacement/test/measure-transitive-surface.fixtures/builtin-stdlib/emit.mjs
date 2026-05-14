// T7 fixture: node builtins and JSON.parse usage
// node:fs -> builtin, excluded from traversal
// JSON.parse -> stdlib, excluded from traversal
// Expected: emit(1) reachable_function (the emitFn itself)
//           builtin_imports >= 1, excluded_stdlib_files_seen: 0 (JSON.parse is not a file import)
//           reachable_functions from builtin/stdlib edges: 0
import { readFileSync } from "node:fs";
import { join } from "node:path";
export function emitFn(p) {
  const content = readFileSync(join(p, "x.json"), "utf8");
  return JSON.parse(content);
}
