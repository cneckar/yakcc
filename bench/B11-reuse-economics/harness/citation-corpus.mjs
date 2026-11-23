import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
const req = createRequire(resolve("packages/shave/package.json"));
const { Project, ScriptKind, Node } = req("ts-morph");
const { citeBehavior } = await import(resolve("packages/shave/dist/retrieval/citation.js"));
const roots = [resolve("packages/shave/src/__fixtures__/module-graph")];
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|ts)$/.test(f) && !f.endsWith(".d.ts")) files.push(p);
  }
};
roots.forEach(walk);
let total = 0,
  cited = 0;
const reasons = {};
const misses = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const sf = project.createSourceFile("m.ts", text, { scriptKind: ScriptKind.TS });
  for (const fn of sf.getFunctions()) {
    const docs = fn.getJsDocs();
    if (docs.length === 0) continue;
    const desc = docs[docs.length - 1].getDescription().trim();
    if (desc.length === 0) continue;
    total++;
    const behavior = desc.length <= 200 ? desc : `${desc.slice(0, 197)}...`;
    const r = citeBehavior(text, behavior);
    if (r.status === "cited") cited++;
    else {
      reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
      if (misses.length < 8)
        misses.push(`${file.split("module-graph/")[1]}: ${behavior.slice(0, 70)}`);
    }
  }
}
console.log(
  `files ${files.length}; JSDoc summaries ${total}; cited ${cited} (${total ? ((100 * cited) / total).toFixed(1) : 0}%)`,
);
console.log("uncited reasons:", JSON.stringify(reasons));
console.log("misses:\n  " + misses.join("\n  "));

// Sensitivity: a one-character edit inside each summary must make the old claim uncited.
let caught = 0,
  probed = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const sf = project.createSourceFile("m.ts", text, { scriptKind: ScriptKind.TS });
  for (const fn of sf.getFunctions()) {
    const docs = fn.getJsDocs();
    if (docs.length === 0) continue;
    const desc = docs[docs.length - 1].getDescription().trim();
    if (desc.length < 8) continue;
    const behavior = desc.length <= 200 ? desc : `${desc.slice(0, 197)}...`;
    const idx = text.indexOf(desc.split("\n")[0].trim());
    if (idx < 0) continue;
    const pos = idx + Math.min(3, desc.split("\n")[0].trim().length - 1);
    const edited = text.slice(0, pos) + (text[pos] === "x" ? "y" : "x") + text.slice(pos + 1);
    probed++;
    if (citeBehavior(edited, behavior).status === "uncited") caught++;
  }
}
console.log(
  `sensitivity: a one-character change in the summary is caught in ${caught}/${probed} probes`,
);
