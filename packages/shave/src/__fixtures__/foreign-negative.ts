// SPDX-License-Identifier: MIT
// Negative fixture: no foreign-block entries for WI-V2-04 L5.
// All imports here must NOT produce ForeignLeafEntry:
//   - `import type` → type-only erasure (no runtime import)
//   - relative import → not foreign (starts with '.')
//   - @yakcc/ workspace import → not foreign (workspace prefix)
// Authority: packages/shave/src/__fixtures__/ (L5-I1)
import type { PathLike } from "node:fs"; // type-only: erased at compile time
import { localUtil } from "./local-helper.js"; // relative: not foreign

export function pure(x: number): number {
  const _p: PathLike = String(x); // uses the type-only import (erased)
  return localUtil(x);
}
