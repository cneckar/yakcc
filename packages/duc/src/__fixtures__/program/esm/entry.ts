// ECMAScript module linking (#1333): live bindings, renames, re-exports, `export *`, namespaces,
// default exports, evaluation order, and a cycle.
import counter, { bump, count as n } from "./counter.js";
import { even } from "./cycle-a.js";
import { doubled, log } from "./order-b.js";
import * as ns from "./star.js";
export { bump as increment } from "./counter.js";

log.push("entry");

// A read of the live binding `n` sees every write before it. (Read before a call that writes it, the
// lowering does not order it yet: #1375.)
export function probe(k: number): unknown {
  bump(k);
  return [n, counter(), ns.fromA, ns.fromB, ns.renamed, doubled(k), log.slice(), even(k)];
}
