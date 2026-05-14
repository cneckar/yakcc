// T4 fixture: barrel index re-exports impl; impl's functions counted once
// Expected: emit(1) + barrel-pkg/index(0 own) + barrel-pkg/impl(2) = 3 total
import { fn1, fn2 } from "barrel-pkg";
export function emitFn() { return fn1() + fn2(); }
