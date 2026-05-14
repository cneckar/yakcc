// T1 fixture: emit imports pkg-a (2 functions), which imports pkg-b (3 functions)
// Total expected: emit(0) + pkg-a(2) + pkg-b(3) = 5 reachable_functions
// reachable_files: 3, unique_non_builtin_imports: 1 (pkg-a from emit)
import { doA } from "pkg-a";
export function emitFn() { return doA(); }
