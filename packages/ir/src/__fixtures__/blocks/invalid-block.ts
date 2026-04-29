// Fixture: invalid block (violates no-any) used by strict-subset path-discovery tests.
// This block intentionally uses `any` to trigger the no-any rule.
// biome-ignore lint/suspicious/noExplicitAny: intentional fixture for strict-subset negative test
export function bad(x: any): any {
  return x;
}
