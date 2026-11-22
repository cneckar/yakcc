// Closure of every shaved atom with references linked (#1281). Reads a module cache made by
// shaving the corpus with module structure kept ({dir, name, root, entryPath, modules: [{filePath,
// source, atoms}]}), resolves each reference an atom makes through its module's scope, and reports:
// how many atoms are closed without linking, how many with linking (every reference resolves to a
// stored atom, a platform module or primitive), how many are closed transitively (and so are the
// atoms they link to), and the remaining holes by cause.
// Usage: node scripts/link-closure-measure.mjs <modules.json>
import { readFileSync } from "node:fs";
import { liftAtom } from "../packages/duc/dist/lift.js";
import { closureOf } from "../packages/duc/dist/closure.js";
import { NODE } from "../packages/duc/dist/base-set.js";
import { ReferenceResolver, isImportBinding } from "../packages/shave/dist/persist/reference-resolver.js";

const packages = JSON.parse(readFileSync(process.argv[2], "utf8")).map((p) => ({ ...p, modules: p.modules.filter((m) => m.filePath !== undefined) }));
const resolver = new ReferenceResolver(packages);

const atoms = [];
const key = (file, i) => `${file}#${i}`;
let bindings = 0;
for (const pkg of packages) {
  for (const mod of pkg.modules) {
    mod.atoms.forEach((source, i) => {
      if (isImportBinding(source)) { bindings++; return; }
      let g;
      try { g = liftAtom(source); } catch { atoms.push({ pkg: pkg.dir, key: key(mod.filePath, i), lifted: false }); return; }
      const r = closureOf(g, { baseSet: NODE });
      const links = [];
      const holes = [];
      for (const sym of r.unlinked) {
        const res = resolver.resolve(mod.filePath, sym, source);
        if (res.kind === "hole") holes.push({ sym, cause: res.cause });
        else if (res.kind === "atom") links.push(key(res.filePath, res.atom));
      }
      atoms.push({ pkg: pkg.dir, key: key(mod.filePath, i), lifted: true, closedWithout: r.closed, holes, links });
    });
  }
}

const byKey = new Map(atoms.map((a) => [a.key, a]));
// Transitive: closed, and every linked atom is a stored atom that is closed transitively.
const memo = new Map();
const transitive = (k, path = new Set()) => {
  if (memo.has(k)) return memo.get(k);
  if (path.has(k)) return true; // A cycle closes on itself.
  const a = byKey.get(k);
  if (a === undefined || !a.lifted || a.holes.length > 0) { memo.set(k, false); return false; }
  path.add(k);
  const ok = a.links.every((l) => transitive(l, path));
  path.delete(k);
  memo.set(k, ok);
  return ok;
};

const lifted = atoms.filter((a) => a.lifted);
const closedWithout = lifted.filter((a) => a.closedWithout).length;
const closedWith = lifted.filter((a) => a.holes.length === 0).length;
const closedTransitive = lifted.filter((a) => transitive(a.key)).length;
const causes = new Map();
for (const a of lifted) for (const h of a.holes) {
  const c = causes.get(h.cause) ?? { atoms: new Set(), symbols: new Map() };
  c.atoms.add(a.key);
  c.symbols.set(h.sym, (c.symbols.get(h.sym) ?? 0) + 1);
  causes.set(h.cause, c);
}
const perPkg = {};
for (const a of lifted) {
  const p = (perPkg[a.pkg] ??= { atoms: 0, closed: 0 });
  p.atoms++;
  if (a.holes.length === 0) p.closed++;
}
const frac = (n) => +(n / lifted.length).toFixed(3);
console.log(JSON.stringify({
  atoms: atoms.length,
  importBindings: bindings,
  lifted: lifted.length,
  closedWithoutLinking: closedWithout, fractionWithout: frac(closedWithout),
  closedWithLinking: closedWith, fractionWith: frac(closedWith),
  closedTransitively: closedTransitive, fractionTransitive: frac(closedTransitive),
  holesByCause: Object.fromEntries([...causes].sort((x, y) => y[1].atoms.size - x[1].atoms.size).map(([c, v]) => [c, {
    atoms: v.atoms.size,
    top: [...v.symbols].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([s, n]) => `${s} ${n}`),
  }])),
  perPackage: perPkg,
}, null, 2));
