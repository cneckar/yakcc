// Closure of every stored atom (P7, #1275), from an atom cache of {pkg, source} records.
// Reports how many atoms are closed with no linking, and which unlinked names block the rest.
// Usage: node scripts/closure-measure.mjs <atoms.json>
import { readFileSync } from "node:fs";
import { liftAtom } from "../packages/duc/dist/lift.js";
import { closureOf } from "../packages/duc/dist/closure.js";

const atoms = JSON.parse(readFileSync(process.argv[2], "utf8"));
let closed = 0, lifted = 0;
const blockers = new Map();
for (const a of atoms) {
  let g;
  try { g = liftAtom(a.source); } catch { continue; }
  lifted++;
  const r = closureOf(g);
  if (r.closed) closed++;
  for (const name of r.unlinked) blockers.set(name, (blockers.get(name) ?? 0) + 1);
}
const top = [...blockers.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15);
console.log(JSON.stringify({ atoms: atoms.length, lifted, closedWithoutLinking: closed, closedFraction: +(closed / lifted).toFixed(3), topUnlinked: top }, null, 2));
