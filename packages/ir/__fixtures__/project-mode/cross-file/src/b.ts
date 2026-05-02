// Fixture: cross-file/src/b.ts
// Purpose: imports from ./a.js (relative cross-file edge) to prove that project mode
// resolves the import via the real tsconfig and emits zero no-untyped-imports violations.
// Isolated mode against this file alone DOES emit a false positive because the
// in-memory project does not know about a.ts.

import { a } from "./a.js";
export const b = a + 1;
