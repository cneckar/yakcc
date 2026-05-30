// SPDX-License-Identifier: MIT
// Intentionally violates strict-subset: uses eval() which is forbidden.
// Used by emit-atom exit-3 test (DEC-WI954-012).

export function clamp(value: number, min: number, max: number): number {
  // eval is forbidden by the strict-subset rules (no-eval rule)
  // biome-ignore lint: intentional strict-subset violation for fixture
  return eval("Math.min(Math.max(value, min), max)") as number;
}
