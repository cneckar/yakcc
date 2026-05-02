// Fixture: real-violations/src/violations.ts
// Purpose: contains deliberate strict-subset violations for project-mode validation tests.
// Rules violated by this file: no-any, no-eval, no-mutable-globals, no-throw-non-error,
//   no-top-level-side-effects, no-runtime-reflection (6 rules).
// Note: no-with cannot be included in a .ts module file because TypeScript strict mode
//   rejects `with` at parse time. The no-with rule is verified via inline source string
//   in strict-subset.test.ts and in the project-mode test suite.
// The project-mode validator MUST surface all 6 rule kinds present here.

// Violation: no-mutable-globals (top-level let)
let counter = 0;

// Violation: no-any (explicit any parameter)
// biome-ignore lint/suspicious/noExplicitAny: intentional fixture violation
export function processValue(x: any): string {
  counter += 1;
  return String(x);
}

// Violation: no-eval (new Function is forbidden by the no-eval rule)
export function runCode(code: string): unknown {
  const fn = new Function(`return ${code}`);
  return fn();
}

// Violation: no-throw-non-error
export function failHard(): never {
  throw "something went wrong";
}

// Violation: no-top-level-side-effects (top-level expression statement)
console.log("module side-effect");

// Violation: no-runtime-reflection
Object.defineProperty(globalThis, "__fixtureMarker__", { value: 1 });
