// SPDX-License-Identifier: MIT
// clamp — fixture for emit-atom happy-path test (DEC-WI954-012)

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
