#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Which documented APIs can a naming scheme resolve to a corpus definition, and what would it
// take for the rest? Reads the needs that needs-from-readme.mjs could not resolve (saved as
// `unresolved` in its output) and tries simple rules, in order, each on what the earlier ones
// left. No model calls. Input for #1309 (how shave should name roots).
//
//   node harness/api-resolution.mjs [--queries queries/readme-run2.json]
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { corpusDefinitions } from "../../B11-reuse-economics/harness/retrieve.mjs";
import { FIXTURES } from "../../B12-need-to-code/harness/sandbox.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bench = resolve(here, "..");

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const parts = (api) => api.replace(/\(.*$/, "").split(/[.#]/).filter(Boolean);

/** The files of a fixture package, relative to the package directory. */
function files(pkg) {
  const out = [];
  const walk = (d, rel) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p, `${rel}${f}/`);
      else out.push(`${rel}${f}`);
    }
  };
  if (existsSync(join(FIXTURES, pkg))) walk(join(FIXTURES, pkg), "");
  return out;
}

/** The rules, in order: each returns a reason string when it would resolve the API. */
export function rules(defsByPkg) {
  const has = (pkg, name) => (defsByPkg.get(pkg) ?? new Set()).has(name);
  const sources = new Map();
  const sourceOf = (pkg) => {
    if (!sources.has(pkg))
      sources.set(
        pkg,
        files(pkg)
          .filter((f) => /\.(c|m)?js$|\.ts$/.test(f) && !f.endsWith(".d.ts"))
          .map((f) => readFileSync(join(FIXTURES, pkg, f), "utf8"))
          .join("\n"),
      );
    return sources.get(pkg);
  };
  return [
    {
      id: "call signature: the name without its arguments exists (a parsing slip, now fixed in the generator)",
      try: (pkg, api) => {
        const name = api.replace(/\(.*$/, "").split(/[.#]/).filter(Boolean).pop() ?? "";
        return /\(/.test(api) && has(pkg, name) ? `${api} → ${name}` : null;
      },
    },
    {
      id: "case-insensitive name",
      try: (pkg, api) => {
        const last = parts(api).pop() ?? "";
        const names = [...(defsByPkg.get(pkg) ?? [])];
        const hit = names.find((n) => n.toLowerCase() === last.toLowerCase() && n !== last);
        return hit ? `${last} → ${hit}` : null;
      },
    },
    {
      id: "factory → class (z.object → ZodObject)",
      try: (pkg, api) => {
        const last = parts(api).pop() ?? "";
        for (const prefix of ["Zod", ""]) {
          const cls = `${prefix}${cap(last)}`;
          if (cls !== last && has(pkg, cls)) return `${last} → ${cls}`;
        }
        return null;
      },
    },
    {
      id: "method → its class (Range.test → Range)",
      try: (pkg, api) => {
        const ps = parts(api);
        if (ps.length < 2) return null;
        for (let i = ps.length - 2; i >= 0; i--)
          if (has(pkg, ps[i]) && /^[A-Z]/.test(ps[i])) return `${ps.at(-1)} → class ${ps[i]}`;
        return null;
      },
    },
    {
      id: "property-assigned function (obj.name = function …; needs #1309 to name it)",
      try: (pkg, api) => {
        const last = parts(api).pop() ?? "";
        return new RegExp(`\\.${last}\\s*=\\s*(async\\s+)?function\\b`).test(sourceOf(pkg))
          ? `${api} → assigned property ${last}`
          : null;
      },
    },
    {
      id: "anonymous default export of a same-named file (needs #1309 to name it)",
      try: (pkg, api) => {
        const last = (parts(api).pop() ?? "").toLowerCase();
        const f = files(pkg).find(
          (x) =>
            x
              .replace(/\.(c|m)?js$|\.ts$/, "")
              .split("/")
              .pop()
              ?.toLowerCase() === last,
        );
        return f ? `${api} → ${f} (default export)` : null;
      },
    },
    {
      id: "member of an object a factory returns (the factory's root covers it)",
      try: (pkg, api) => {
        const ps = parts(api);
        return ps.length >= 2 && /^[a-z]/.test(ps[0]) && !has(pkg, ps[0])
          ? `${api} → member of ${ps[0]}`
          : null;
      },
    },
    {
      id: "not an API: a CLI flag, a concept heading, an option or a type",
      try: (_pkg, api) =>
        /^-|\s|^[A-Z][a-z]+s$|^(alg|options|infer|includePrerelease|rejectOnClear)$/.test(api)
          ? api
          : null,
    },
  ];
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--queries");
  const file = resolve(i >= 0 ? argv[i + 1] : join(bench, "queries", "readme-run2.json"));
  const { unresolved = [] } = JSON.parse(readFileSync(file, "utf8"));
  const defsByPkg = new Map();
  for (const d of corpusDefinitions({ dedupe: false })) {
    if (!defsByPkg.has(d.pkg)) defsByPkg.set(d.pkg, new Set());
    defsByPkg.get(d.pkg).add(d.name);
  }
  const rs = rules(defsByPkg);
  const counts = Object.fromEntries(
    [...rs.map((r) => r.id), "not resolvable by these rules"].map((k) => [k, 0]),
  );
  const rows = [];
  for (const u of unresolved) {
    let by = "not resolvable by these rules";
    let how = null;
    for (const r of rs) {
      how = r.try(u.pkg, u.api);
      if (how) {
        by = r.id;
        break;
      }
    }
    counts[by]++;
    rows.push({ pkg: u.pkg, api: u.api, by, how });
  }
  const report = { file: file.split("/").pop(), unresolved: unresolved.length, counts, rows };
  writeFileSync(
    join(bench, "results", "api-resolution.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`unresolved APIs: ${unresolved.length}`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${String(v).padStart(3)}  ${k}`);
  const rest = rows.filter((r) => r.by === "not resolvable by these rules");
  console.log(
    "examples left:",
    rest
      .slice(0, 14)
      .map((r) => `${r.pkg.replace(/-\d.*$/, "")}:${r.api}`)
      .join(", "),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
