#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// A bench prototype of #1309: deterministic, property-carrying names for corpus definitions,
// built from the source alone (no model). It exists to measure which fields help discovery
// before lane:core builds the real thing in shave. Static estimates, not measurements:
//   - identity: package, file, local name, exported or not, path from the nearest entry point
//   - signature: parameter names, TypeScript or JSDoc types where written
//   - doc: the JSDoc summary
//   - composition: a call graph over the package's top-level definitions (same file, and
//     relative CommonJS / ESM imports), the closure, its size, direct callees, fan-in
//   - effects: host APIs touched, throws, async or generator
//   - performance hints: loop nesting depth across the closure, recursion, regex, allocation
//     inside loops
//   - domain tokens: identifier parts and format-like string literals from the closure
//
//   node harness/names.mjs [--out .cache/names.json]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { corpusDefinitions } from "../../B11-reuse-economics/harness/retrieve.mjs";
import { docAbove, paramNames } from "./cards.mjs";
import { FIXTURES } from "./sandbox.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const benchDir = resolve(here, "..");
const repo = resolve(benchDir, "..", "..");
const ts = createRequire(join(repo, "packages/shave/package.json"))("typescript");

/** The version of the naming rules, stamped on the output. */
export const NAMES_VERSION = 1;

const HOST = {
  time: /^(Date|performance)$/,
  random: /^(crypto|getRandomValues)$/,
  io: /^(fs|process|console|fetch|XMLHttpRequest|require)$/,
  timers: /^(setTimeout|setInterval|setImmediate|queueMicrotask)$/,
};
const ITERATING_METHODS = new Set([
  "map",
  "forEach",
  "reduce",
  "filter",
  "some",
  "every",
  "find",
  "flatMap",
  "reduceRight",
  "findIndex",
]);

/** Split an identifier into lowercase words (camelCase, snake_case, digits). */
export function words(id) {
  return id
    .replace(/[$_]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

const isFnInit = (n) => n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));

/** Parse one file: its top-level definitions, imports and exports. */
function parseFile(file) {
  const text = readFileSync(join(FIXTURES, file), "utf8");
  const kind = /\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, kind);
  const defs = new Map(); // local name -> node
  const imports = new Map(); // local name -> { spec, imported: "default" | "*" | name }
  const exportsMap = new Map(); // exported name -> local name
  const addImport = (local, spec, imported) => {
    if (spec.startsWith(".")) imports.set(local, { spec, imported });
  };
  for (const st of sf.statements) {
    const exported = st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
      defs.set(st.name.text, st);
      if (exported)
        exportsMap.set(
          st.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
            ? "default"
            : st.name.text,
          st.name.text,
        );
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) {
          // const { a, b: c } = require("./x")
          if (ts.isObjectBindingPattern(d.name) && d.initializer && isRequire(d.initializer))
            for (const el of d.name.elements)
              if (ts.isIdentifier(el.name))
                addImport(
                  el.name.text,
                  requireSpec(d.initializer),
                  (el.propertyName ?? el.name).text,
                );
          continue;
        }
        const name = d.name.text;
        if (d.initializer && isRequire(d.initializer))
          addImport(name, requireSpec(d.initializer), "*");
        else if (
          d.initializer &&
          ts.isCallExpression(d.initializer) &&
          /^_interop/.test(d.initializer.expression.getText?.() ?? "")
        ) {
          // var _x = _interopRequireDefault(require("./x"))
          const inner = d.initializer.arguments[0];
          if (inner && isRequire(inner)) addImport(name, requireSpec(inner), "*");
        } else if (
          isFnInit(d.initializer) ||
          (d.initializer && ts.isClassExpression(d.initializer))
        ) {
          defs.set(name, d);
          if (exported) exportsMap.set(name, name);
        }
      }
    } else if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const c = st.importClause;
      if (c?.name) addImport(c.name.text, spec, "default");
      if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings))
        addImport(c.namedBindings.name.text, spec, "*");
      if (c?.namedBindings && ts.isNamedImports(c.namedBindings))
        for (const el of c.namedBindings.elements)
          addImport(el.name.text, spec, (el.propertyName ?? el.name).text);
    } else if (
      ts.isExportDeclaration(st) &&
      st.exportClause &&
      ts.isNamedExports(st.exportClause)
    ) {
      for (const el of st.exportClause.elements)
        exportsMap.set(el.name.text, (el.propertyName ?? el.name).text);
    } else if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression)) {
      exportsMap.set("default", st.expression.text);
    } else if (
      ts.isExpressionStatement(st) &&
      ts.isBinaryExpression(st.expression) &&
      st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      // module.exports = x; module.exports.a = b; exports.a = b
      const lhs = st.expression.left.getText();
      const rhs = st.expression.right;
      const m = /^(?:module\.)?exports(?:\.(\w+))?$/.exec(lhs);
      if (m && ts.isIdentifier(rhs)) exportsMap.set(m[1] ?? "default", rhs.text);
      if (m && !m[1] && ts.isObjectLiteralExpression(rhs))
        for (const p of rhs.properties) {
          if (ts.isShorthandPropertyAssignment(p)) exportsMap.set(p.name.text, p.name.text);
          else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer))
            exportsMap.set(p.name.getText(), p.initializer.text);
        }
    }
  }
  return { file, text, sf, defs, imports, exportsMap };
}

function isRequire(n) {
  return (
    ts.isCallExpression(n) &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === "require" &&
    n.arguments[0] &&
    ts.isStringLiteral(n.arguments[0])
  );
}
const requireSpec = (n) => n.arguments[0].text;

function resolveSpec(fromFile, spec) {
  const base = join(dirname(fromFile), spec);
  const cands = [
    base,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.mjs`,
    `${base}.ts`,
    join(base, "index.js"),
    join(base, "index.ts"),
  ];
  if (base.endsWith(".js")) cands.push(`${base.slice(0, -3)}.ts`);
  return cands;
}

/** Analyze one definition node: references, loops, effects, tokens. */
function analyze(node, sourceFile) {
  const refs = []; // { name, member? }
  const host = new Set();
  const tokens = [];
  const literals = [];
  let maxLoop = 0;
  let throws = false;
  let regex = false;
  let allocInLoop = false;
  let async = false;
  let nodes = 0;
  const visit = (n, depth) => {
    nodes++;
    let d = depth;
    if (
      ts.isForStatement(n) ||
      ts.isForOfStatement(n) ||
      ts.isForInStatement(n) ||
      ts.isWhileStatement(n) ||
      ts.isDoStatement(n)
    )
      d++;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ITERATING_METHODS.has(n.expression.name.text)
    )
      d++;
    if (d > maxLoop) maxLoop = d;
    if (ts.isThrowStatement(n)) throws = true;
    if (
      ts.isRegularExpressionLiteral(n) ||
      (ts.isNewExpression(n) && n.expression.getText(sourceFile) === "RegExp")
    )
      regex = true;
    if (
      depth > 0 &&
      (ts.isNewExpression(n) || ts.isArrayLiteralExpression(n) || ts.isObjectLiteralExpression(n))
    )
      allocInLoop = true;
    if (
      (ts.isFunctionLike(n) && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) ||
      (ts.isFunctionLike(n) && n.asteriskToken) ||
      ts.isAwaitExpression(n)
    )
      async = true;
    if (ts.isStringLiteral(n) && n.text.length >= 2 && n.text.length <= 30 && /[a-z]/i.test(n.text))
      literals.push(n.text);
    if (ts.isIdentifier(n)) {
      const name = n.text;
      tokens.push(name);
      for (const [k, re] of Object.entries(HOST)) if (re.test(name)) host.add(k);
      const parent = n.parent;
      const isDecl =
        parent &&
        (ts.isFunctionDeclaration(parent) ||
          ts.isVariableDeclaration(parent) ||
          ts.isParameter(parent) ||
          ts.isClassDeclaration(parent)) &&
        parent.name === n;
      const isMemberName = parent && ts.isPropertyAccessExpression(parent) && parent.name === n;
      if (!isDecl && !isMemberName) {
        const member =
          parent && ts.isPropertyAccessExpression(parent) && parent.expression === n
            ? parent.name.text
            : undefined;
        refs.push({ name, member });
      }
    }
    ts.forEachChild(n, (c) => visit(c, d));
  };
  visit(node, 0);
  const chars = node.getEnd() - node.getStart(sourceFile);
  return {
    refs,
    host: [...host].sort(),
    tokens,
    literals,
    maxLoop,
    throws,
    regex,
    allocInLoop,
    async,
    nodes,
    chars,
  };
}

/** Build the package-level graph and the name record of every corpus definition. */
export function buildNames(defs) {
  const files = new Map();
  const fileOf = (f) => {
    if (!files.has(f)) {
      try {
        files.set(f, parseFile(f));
      } catch {
        files.set(f, null);
      }
    }
    return files.get(f);
  };
  // Top-level graph nodes: key "file#name".
  const graph = new Map();
  const keyOf = (file, name) => `${file}#${name}`;
  const resolveExport = (file, exported, seen = 0) => {
    const pf = fileOf(file);
    if (!pf || seen > 5) return null;
    if (exported === "*" || exported === "default") {
      const local = pf.exportsMap.get("default");
      return local && pf.defs.has(local) ? keyOf(file, local) : null;
    }
    const local = pf.exportsMap.get(exported) ?? exported;
    if (pf.defs.has(local)) return keyOf(file, local);
    const imp = pf.imports.get(local);
    if (imp)
      for (const c of resolveSpec(file, imp.spec))
        if (fileOf(c))
          return resolveExport(c, imp.imported === "*" ? exported : imp.imported, seen + 1);
    return null;
  };
  const nodeInfo = (file, name) => {
    const k = keyOf(file, name);
    if (graph.has(k)) return graph.get(k);
    const pf = fileOf(file);
    const info = { key: k, file, name, callees: new Set(), a: null };
    graph.set(k, info);
    const node = pf?.defs.get(name);
    if (!node) return info;
    info.a = analyze(node, pf.sf);
    info.exported = [...pf.exportsMap.values()].includes(name);
    for (const r of info.a.refs) {
      if (r.name === name) {
        info.callees.add(k); // direct recursion
        continue;
      }
      if (pf.defs.has(r.name)) info.callees.add(keyOf(file, r.name));
      const imp = pf.imports.get(r.name);
      if (imp) {
        const target = imp.imported === "*" ? (r.member ?? "default") : imp.imported;
        for (const c of resolveSpec(file, imp.spec)) {
          if (!fileOf(c)) continue;
          const t = resolveExport(c, target);
          if (t) info.callees.add(t);
          break;
        }
      }
    }
    for (const c of info.callees) {
      const [cf, cn] = [c.slice(0, c.lastIndexOf("#")), c.slice(c.lastIndexOf("#") + 1)];
      nodeInfo(cf, cn);
    }
    return info;
  };
  // Seed the graph with every top-level definition of every file that holds a corpus definition.
  for (const d of defs) {
    const pf = fileOf(d.sourceFile);
    if (pf) for (const n of pf.defs.keys()) nodeInfo(d.sourceFile, n);
  }
  // Closures and fan-in.
  const closureOf = (k) => {
    const seen = new Set();
    const stack = [k];
    while (stack.length) {
      const x = stack.pop();
      if (seen.has(x)) continue;
      seen.add(x);
      for (const c of graph.get(x)?.callees ?? []) stack.push(c);
    }
    return seen;
  };
  const callers = new Map();
  for (const [k, info] of graph)
    for (const c of info.callees)
      if (c !== k) (callers.get(c) ?? callers.set(c, new Set()).get(c)).add(k);
  // The nearest exported caller chain (breadth-first over callers).
  const entryPath = (k) => {
    if (graph.get(k)?.exported) return [k];
    const prev = new Map([[k, null]]);
    const queue = [k];
    while (queue.length) {
      const x = queue.shift();
      for (const c of callers.get(x) ?? []) {
        if (prev.has(c)) continue;
        prev.set(c, x);
        if (graph.get(c)?.exported) {
          const path = [c];
          for (let y = x; y !== null; y = prev.get(y)) path.push(y);
          return path;
        }
        queue.push(c);
      }
    }
    return [k];
  };

  const records = {};
  for (const d of defs) {
    const id = `${d.sourceFile}#${d.name}@${d.lineStart}`;
    const pf = fileOf(d.sourceFile);
    const top = pf?.defs.has(d.name) ? graph.get(keyOf(d.sourceFile, d.name)) : null;
    // A method or nested function: analyze its own text, and resolve its references in its file.
    let a = top?.a;
    let callees = top ? [...top.callees] : [];
    if (!a) {
      const sf = ts.createSourceFile(
        "d.ts",
        d.text,
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.TS,
      );
      a = analyze(sf, sf);
      callees = pf
        ? [
            ...new Set(
              a.refs
                .filter((r) => pf.defs.has(r.name) && r.name !== d.name)
                .map((r) => keyOf(d.sourceFile, r.name)),
            ),
          ]
        : [];
    }
    const closure = new Set(top ? closureOf(top.key) : callees.flatMap((c) => [...closureOf(c)]));
    if (top) closure.delete(top.key);
    const inClosure = [...closure].map((k) => graph.get(k)).filter((x) => x?.a);
    const all = [a, ...inClosure.map((x) => x.a)];
    const tokenCounts = new Map();
    for (const x of all)
      for (const t of x.tokens)
        for (const w of words(t)) tokenCounts.set(w, (tokenCounts.get(w) ?? 0) + 1);
    const ownWords = new Set(words(d.name));
    const domain = [...tokenCounts.entries()]
      .filter(
        ([w]) =>
          !ownWords.has(w) &&
          !/^(var|let|const|this|return|function|length|index|value|result|arguments|undefined|null|true|false)$/.test(
            w,
          ),
      )
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
      .slice(0, 8)
      .map(([w]) => w);
    const recursive = top
      ? closureOf(top.key).has(top.key) &&
        [...(top.callees ?? [])].some((c) => c === top.key || closureOf(c).has(top.key))
      : false;
    const path = top ? entryPath(top.key) : [];
    const fileText = pf?.text ?? readFileSync(join(FIXTURES, d.sourceFile), "utf8");
    records[id] = {
      id,
      pkg: d.pkg,
      sourceFile: d.sourceFile,
      name: d.name,
      exported: top?.exported ?? false,
      entryPath: path.length > 1 ? path.map((k) => k.slice(k.lastIndexOf("#") + 1)) : [],
      params: paramNames(d.text),
      types: declaredTypes(d.text),
      doc: docAbove(fileText, d.lineStart),
      callees: callees
        .filter((c) => c !== top?.key)
        .map((c) => c.slice(c.lastIndexOf("#") + 1))
        .sort(),
      closureSize: closure.size,
      // The closure as "file#name" keys of top-level definitions, sorted (for module indexes).
      closureKeys: [...closure].sort(),
      closureNodes: all.reduce((n, x) => n + x.nodes, 0),
      // Source characters of the definition and its closure: what writing it would take.
      closureChars: all.reduce((n, x) => n + x.chars, 0),
      fanIn: top ? (callers.get(top.key)?.size ?? 0) : 0,
      effects: {
        host: [...new Set(all.flatMap((x) => x.host))].sort(),
        throws: all.some((x) => x.throws),
        async: a.async,
      },
      perf: {
        // Its own loop nesting (a complexity hint), and the deepest nesting anywhere in its
        // closure (not a complexity claim: callees may run outside its loops).
        loopDepth: a.maxLoop,
        closureLoopDepth: Math.max(...all.map((x) => x.maxLoop)),
        recursive,
        regex: all.some((x) => x.regex),
        allocInLoop: all.some((x) => x.allocInLoop),
      },
      domain,
      literals: [...new Set(all.flatMap((x) => x.literals))].slice(0, 6),
    };
  }
  return records;
}

/** Parameter and return types as written (TypeScript annotations), or null. */
function declaredTypes(text) {
  const sf = ts.createSourceFile("d.ts", text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let out = null;
  const visit = (n) => {
    if (out) return;
    if (ts.isFunctionLike(n) && "parameters" in n) {
      const params = n.parameters.map((p) => p.type?.getText(sf) ?? null);
      const ret = n.type?.getText(sf) ?? null;
      if (params.some(Boolean) || ret) out = { params, returns: ret };
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The fields a rendering can include; each can be left out for an ablation. */
export const FIELDS = ["identity", "signature", "doc", "composition", "effects", "perf", "domain"];

/** The one-line (or few-line) rendered name of a record. */
export function renderName(r, fields = FIELDS) {
  const on = new Set(fields);
  const parts = [];
  const sig = on.has("signature")
    ? `(${r.params.map((p, i) => (r.types?.params[i] ? `${p}: ${r.types.params[i]}` : p)).join(", ")})${r.types?.returns ? ` → ${r.types.returns}` : ""}`
    : "";
  const ident = on.has("identity")
    ? `${r.pkg.replace(/-\d[\d.]*$/, "")} › ${r.entryPath.length > 1 ? `${r.entryPath.join(" › ")}` : r.name}`
    : r.name;
  parts.push(`${ident}${sig}${on.has("identity") && r.exported ? " [entry]" : ""}`);
  if (on.has("doc") && r.doc) parts.push(r.doc);
  if (on.has("composition") && (r.closureSize > 0 || r.callees.length > 0))
    parts.push(
      `calls ${r.callees.slice(0, 8).join(", ") || "nothing"}; closure ${r.closureSize} definitions, ${r.closureNodes} nodes; used by ${r.fanIn}`,
    );
  if (on.has("effects")) {
    const e = [];
    e.push(r.effects.host.length === 0 ? "no host APIs" : `uses ${r.effects.host.join(", ")}`);
    if (r.effects.throws) e.push("throws");
    if (r.effects.async) e.push("async");
    parts.push(e.join("; "));
  }
  if (on.has("perf")) {
    const p = [
      r.perf.loopDepth === 0
        ? "no loops of its own"
        : `loops nested ${r.perf.loopDepth} deep (~O(n^${r.perf.loopDepth}) static estimate)`,
    ];
    if (r.perf.closureLoopDepth > r.perf.loopDepth)
      p.push(`callees nest up to ${r.perf.closureLoopDepth}`);
    if (r.perf.recursive) p.push("recursive");
    if (r.perf.regex) p.push("regex");
    if (r.perf.allocInLoop) p.push("allocates in loops");
    parts.push(p.join("; "));
  }
  if (on.has("domain") && r.domain.length > 0)
    parts.push(
      `about: ${r.domain.join(" ")}${r.literals.length ? `; literals ${r.literals.map((l) => JSON.stringify(l)).join(" ")}` : ""}`,
    );
  return parts.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--out");
  const out = resolve(i >= 0 ? argv[i + 1] : join(benchDir, ".cache", "names.json"));
  const t0 = Date.now();
  const records = buildNames(corpusDefinitions());
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ version: NAMES_VERSION, records }));
  const rs = Object.values(records);
  console.log(
    JSON.stringify(
      {
        definitions: rs.length,
        exported: rs.filter((r) => r.exported).length,
        withEntryPath: rs.filter((r) => r.entryPath.length > 1).length,
        withCallees: rs.filter((r) => r.callees.length > 0).length,
        closure10plus: rs.filter((r) => r.closureSize >= 10).length,
        ms: Date.now() - t0,
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${relative(benchDir, out)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
