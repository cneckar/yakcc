// SPDX-License-Identifier: MIT
// Companion helper for foreign-negative.ts fixture (WI-V2-04 L5).
// Provides localUtil so the relative import in foreign-negative.ts resolves.
// Not itself a foreign-block fixture — it contains no foreign imports.
export function localUtil(x: number): number {
  return x * 2;
}
