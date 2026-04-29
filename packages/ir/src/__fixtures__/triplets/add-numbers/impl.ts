// Fixture: impl.ts for the add-numbers triplet block.
// Returns the sum of two numbers. Used by parseBlockTriplet tests as a
// third distinct fixture with no sub-block imports, verifying that blocks
// without composition references parse correctly.

export function addNumbers(a: number, b: number): number {
  return a + b;
}
