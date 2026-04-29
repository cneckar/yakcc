// Fixture: impl.ts for the invalid-uses-any triplet block.
// This file deliberately uses the `any` type, which the strict-subset
// validator rejects under the no-any rule. It exists solely to exercise
// the rejection path in strict-subset.test.ts path-discovery tests.
//
// @decision: DEC-IR-FIXTURE-001 — invalid-uses-any exists solely as a
// strict-subset rejection fixture; `any` usage is load-bearing for the test.
// DO NOT fix the type; fixing it would break the test that asserts rejection.
// biome-ignore lint/suspicious/noExplicitAny: intentional rejection fixture
export function badIdentity(x: any): any {
  return x;
}
