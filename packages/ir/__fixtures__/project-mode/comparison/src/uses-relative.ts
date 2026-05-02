// Fixture: comparison/src/uses-relative.ts
// Purpose: imports from a relative cross-file path to exercise the false-positive
// comparison case. Project mode resolves ./shared.js; isolated mode emits
// no-untyped-imports because the in-memory project has no shared.ts source.

import { SHARED_VALUE } from "./shared.js";

export const result: string = `${SHARED_VALUE}-processed`;
