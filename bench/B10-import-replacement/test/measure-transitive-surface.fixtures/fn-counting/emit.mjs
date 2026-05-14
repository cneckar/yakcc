// T10 fixture: one of each node type -- only body-bearing ones counted
// Counted (body-bearing): FunctionDeclaration(1), ArrowFunction(1),
//   MethodDeclaration(1), Constructor(1), GetAccessor(1), SetAccessor(1),
//   FunctionExpression(1) = 7
// NOT counted: interface (type only), type alias, ambient declare function (no body)
// Expected: reachable_functions = 7

// FunctionDeclaration with body -- COUNTED
export function declFn() { return 1; }

// ArrowFunction -- COUNTED
export const arrowFn = () => 2;

// FunctionExpression -- COUNTED
export const exprFn = function() { return 3; };

class MyClass {
  // Constructor with body -- COUNTED
  constructor() { this.x = 0; }

  // MethodDeclaration with body -- COUNTED
  myMethod() { return this.x; }

  // GetAccessor -- COUNTED
  get value() { return this.x; }

  // SetAccessor -- COUNTED
  set value(v) { this.x = v; }
}

export { MyClass };

// These are NOT counted:
// interface -- type only, erased at compile time
// (Can't use interface in .mjs but we document the rule; tested via .ts in T5)

// Overload signature (no body) would not be counted -- not representable in .mjs
