// SPDX-License-Identifier: MIT
// Valid impl; the proof/manifest.json uses a forbidden artifact kind.
// Used by emit-atom exit-4 test (DEC-WI954-012).

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
