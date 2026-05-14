// T2 fixture: 3-deep prod chain + devDep excluded
// prod-dep (2 fns) -> deep-dep (1 fn); dev-dep (4 fns) is devDependency -> excluded
// Expected: emit(1) + prod-dep(2) + deep-dep(1) = 4 reachable_functions
// dev-dep's 4 functions must NOT appear
import { prodFn } from "prod-dep";
export function emitEntry() { return prodFn(); }
