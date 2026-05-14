// T9 fixture: imports a package that does not exist in node_modules
// Expected: unresolved_imports has 1 entry for "nonexistent-pkg"
//           reachable_functions: 1 (just emitFn), exit code 0
import { something } from "nonexistent-pkg";
export function emitFn() { return something; }
