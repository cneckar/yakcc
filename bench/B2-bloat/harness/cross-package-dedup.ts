// SPDX-License-Identifier: MIT
// B2: how much would content-addressing save across real packages? Each corpus package (the 19
// real ones of packages/shave's module-graph fixtures) is lifted from its entry points as
// yakcc's program record lifts a program (programRecord: every module it reaches, each top-level
// statement a graph); each graph's identity (graphIdentity, exact) is counted per package. A
// graph two packages both hold is stored once by content: what that saves is the bound on
// cross-package deduplication, the one size win atoms have that a bundler's module-level
// deduplication does not.
//
//   pnpm --dir packages/duc exec tsx ../../bench/B2-bloat/harness/cross-package-dedup.ts
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { graphIdentity } from "../../../packages/duc/src/canonical.js";
import { programRecord } from "../../../packages/duc/src/program.js";
const FX = fileURLToPath(
  new URL("../../../packages/shave/src/__fixtures__/module-graph", import.meta.url),
);
const PKGS: [string, string][] = [
  ["base64-js-1.5.1", "index.js"],
  ["bcryptjs-2.4.3", "index.js"],
  ["csv-parse-6.2.1", "lib/index.js"],
  ["date-fns-4.1.0", "parseISO.cjs"],
  ["date-fns-4.1.0", "formatISO.cjs"],
  ["fastest-levenshtein-1.0.16", "esm/mod.js"],
  ["jsonpointer-5.0.1", "jsonpointer.js"],
  ["jsonwebtoken-9.0.2", "index.js"],
  ["lodash-4.17.21", "cloneDeep.js"],
  ["lodash-4.17.21", "merge.js"],
  ["lodash-4.17.21", "set.js"],
  ["lodash-4.17.21", "debounce.js"],
  ["lodash-4.17.21", "get.js"],
  ["lodash-4.17.21", "throttle.js"],
  ["lru-cache-11.3.6", "dist/esm/index.js"],
  ["ms-2.1.3", "index.js"],
  ["nanoid-3.3.12", "index.cjs"],
  ["semver-7.8.0", "index.js"],
  ["toposort-2.0.2", "index.js"],
  ["uuid-11.1.1", "dist/cjs/index.js"],
  ["validator-13.15.35", "index.js"],
  ["zod-3.25.76", "index.cjs"],
];
const where = new Map<string, Set<string>>(); // identity -> packages
const sizeOf = new Map<string, number>();
const seenModules = new Set<string>();
const per: Record<string, { modules: number; statements: number; refused?: string }> = {};
for (const [pkg, entry] of PKGS) {
  try {
    const p = programRecord(join(FX, pkg, entry), FX);
    let n = per[pkg]?.statements ?? 0;
    for (const m of p.modules) {
      if (!m.id.startsWith(pkg) || seenModules.has(m.id)) continue; // its own modules, once
      seenModules.add(m.id);
      for (const st of m.statements) {
        n++;
        let id: string;
        try {
          id = graphIdentity(st.graph);
        } catch {
          continue;
        }
        if (!where.has(id)) where.set(id, new Set());
        where.get(id)!.add(pkg);
        sizeOf.set(id, JSON.stringify(st.graph).length);
      }
    }
    per[pkg] = {
      modules: [...seenModules].filter((id) => id.startsWith(pkg)).length,
      statements: n,
    };
  } catch (e) {
    per[pkg] = { modules: 0, statements: 0, refused: (e as Error).message.slice(0, 160) };
  }
}
const shared = [...where].filter(([, s]) => s.size > 1);
const total = [...sizeOf.values()].reduce((a, b) => a + b, 0);
const sharedBytes = shared.reduce((a, [id, s]) => a + (sizeOf.get(id) ?? 0) * (s.size - 1), 0);
console.log(JSON.stringify(per, null, 1));
console.log(
  "distinct graphs",
  where.size,
  "shared across packages",
  shared.length,
  "graph bytes",
  total,
  "saved by sharing",
  sharedBytes,
  `${((100 * sharedBytes) / (total + sharedBytes)).toFixed(2)}%`,
);
for (const [id, s] of shared
  .sort((a, b) => (sizeOf.get(b[0]) ?? 0) - (sizeOf.get(a[0]) ?? 0))
  .slice(0, 12))
  console.log(" ", sizeOf.get(id), [...s].join(","));
