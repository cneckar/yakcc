// T3 fixture: cycle a -> b -> a
// Expected: terminates, emit(1) + pkg-a(1) + pkg-b(1) = 3 functions, no infinite loop
import { cycleA } from "pkg-a";
export function emitFn() { return cycleA(); }
