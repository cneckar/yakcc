// T5 fixture: type-only import -- contributes 0 to fn/byte/file counts
// import type ... should be excluded; typed-pkg's functions not counted
// Expected: emit(1) + 0 from type-only = 1 reachable_function
// type_only_imports >= 1
import type { MyType } from "typed-pkg";
export function emitFn() { return "hello"; }
