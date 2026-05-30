// SPDX-License-Identifier: MIT
// clamp — valid impl, but spec.yak is missing the required "level" field.
// Used by emit-atom exit-2 test (DEC-WI954-012).

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
