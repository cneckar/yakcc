// SPDX-License-Identifier: MIT
// Deliberately broken clamp: returns value unclamped.
// The LLM-authored property tests in proof/ will catch this.
// Used by emit-atom exit-5 test (DEC-WI954-012).

export function clamp(value: number, _min: number, _max: number): number {
  // Bug: ignores min/max entirely
  return value;
}
