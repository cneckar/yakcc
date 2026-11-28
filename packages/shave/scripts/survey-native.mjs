// SPDX-License-Identifier: Apache-2.0
// Native-lowering survey of a closure (#1361, #1370): every top-level statement of every listed
// module, lifted as `programRecord` splits a module, and lowered natively with `emitNativeModules`.
// The module is lowered whole; when it refuses, each statement alone (the module's other
// declarations as bindings) names what refuses. Unlike a build, it does not stop at the first
// refusal. It is static: what the lowering refuses, not what fails when it runs. Run after building:
//   node scripts/survey-native.mjs <file list> <report.json> [max statement bytes]
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { atomShape, emitNativeModules, liftAtom } from "@yakcc/duc";

const ts = createRequire(import.meta.url)("typescript");

const [list, out, maxArg] = process.argv.slice(2);
const MAX = Number(maxArg ?? 2_000_000);
const files = readFileSync(list, "utf8").split("\n").filter(Boolean);

const pkgOf = (f) => {
  let m = f.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\/(?!.*node_modules)/);
  if (m) return m[1];
  m = f.match(/\/packages\/([^/]+)\//);
  if (m) return `@yakcc/${m[1]}`;
  m = f.match(/\/node-lib\/|\/lib\/(internal\/)?/);
  return m ? "node" : "other";
};
// A reason without its particulars: quoted names, numbers, paths.
const norm = (msg) =>
  String(msg)
    .split("\n")[0]
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .replace(/`[^`]*`/g, "`…`")
    .replace(/\b\d+\b/g, "N")
    .slice(0, 160);

const byReason = new Map();
const perPkg = {};
let statements = 0,
  lowered = 0,
  skipped = 0;
const note = (stage, msg, pkg, file, text) => {
  const key = `${stage}: ${norm(msg)}`;
  let r = byReason.get(key);
  if (r === undefined) byReason.set(key, (r = { count: 0, bytes: 0, pkgs: {}, examples: [] }));
  r.count++;
  r.bytes += text.length;
  r.pkgs[pkg] = (r.pkgs[pkg] ?? 0) + 1;
  if (r.examples.length < 3)
    r.examples.push({
      file: file,
      msg: String(msg).split("\n")[0].slice(0, 200),
      text: text.slice(0, 160),
    });
};

for (const file of files) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const pkg = pkgOf(file);
  const p = (perPkg[pkg] ??= {
    statements: 0,
    lowered: 0,
    liftFails: 0,
    lowerFails: 0,
    bytes: 0,
    loweredBytes: 0,
  });
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const mod = [];
  for (const st of sf.statements) {
    if (
      ts.isImportDeclaration(st) ||
      ts.isImportEqualsDeclaration(st) ||
      ts.isExportDeclaration(st)
    )
      continue;
    if (
      ts.isInterfaceDeclaration(st) ||
      ts.isTypeAliasDeclaration(st) ||
      ts.isModuleDeclaration(st)
    )
      continue;
    if (st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) continue;
    if (ts.isEmptyStatement(st)) continue;
    let text = st.getText(sf);
    if (ts.isExportAssignment(st)) text = `const __default = ${st.expression.getText(sf)};`;
    else
      text = text
        .replace(/^export\s+default\s+((?:async\s+)?function\s*\*?)\s*\(/, "$1 __default(")
        .replace(/^export\s+default\s+class\s*(\{|extends\b)/, "class __default $1")
        .replace(/^export\s+default\s+(?=(async\s+)?(function|class)\b)/, "")
        .replace(/^export\s+/, "");
    if (text.length > MAX) {
      skipped++;
      continue;
    }
    statements++;
    p.statements++;
    p.bytes += text.length;
    let graph, shape;
    try {
      shape = atomShape(text);
      graph = liftAtom(text);
    } catch (e) {
      p.liftFails++;
      note("lift", e.message, pkg, file, text);
      continue;
    }
    const stmt = {
      kind: shape.kind,
      declares:
        shape.kind === "function" ? (shape.name !== undefined ? [shape.name] : []) : shape.names,
      graph,
    };
    mod.push({ stmt, text });
  }
  // The module whole, as a build lowers it; when it refuses, each statement alone with the module's
  // other statements' declarations as bindings, to name what refuses.
  let whole = false;
  try {
    emitNativeModules([{ id: "m", statements: mod.map((x) => x.stmt) }]);
    whole = true;
  } catch {}
  for (const [i, { stmt, text }] of mod.entries()) {
    let err;
    if (!whole) {
      const others = mod.filter((_, j) => j !== i).flatMap((x) => x.stmt.declares);
      const decl =
        others.length > 0
          ? [{ kind: "statement", declares: others, graph: liftAtom(`let ${others.join(", ")};`) }]
          : [];
      try {
        emitNativeModules([{ id: "m", statements: [...decl, stmt] }]);
      } catch (e) {
        err = e;
      }
    }
    if (err === undefined) {
      lowered++;
      p.lowered++;
      p.loweredBytes += text.length;
    } else {
      p.lowerFails++;
      note(
        err.constructor?.name === "LlvmEmitError" ? "lower" : `lower(${err.constructor?.name})`,
        err.message,
        pkg,
        file,
        text,
      );
    }
  }
}
const reasons = [...byReason.entries()]
  .sort((a, b) => b[1].count - a[1].count)
  .map(([reason, r]) => ({ reason, ...r }));
writeFileSync(out, JSON.stringify({ statements, lowered, skipped, perPkg, reasons }, null, 1));
console.log(
  `statements ${statements}, lowered ${lowered} (${((100 * lowered) / Math.max(1, statements)).toFixed(1)}%), skipped (over ${MAX} bytes) ${skipped}`,
);
for (const r of reasons.slice(0, 25)) console.log(`${String(r.count).padStart(6)}  ${r.reason}`);
