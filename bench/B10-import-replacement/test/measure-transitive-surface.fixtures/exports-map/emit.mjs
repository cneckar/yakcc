// T8 fixture: modern-pkg uses package.json#exports conditional map
// The "import" condition should resolve to dist/esm.mjs (2 functions)
// Expected: emit(1) + modern-pkg/dist/esm.mjs(2) = 3 reachable_functions
import { modernFn } from "modern-pkg";
export function emitFn() { return modernFn(); }
