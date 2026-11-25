// SPDX-License-Identifier: Apache-2.0
/**
 * Shaving Node's library through the real pipeline (#1331): each module, as Node ships it in its
 * binary (`vendor/node-<version>/lib`), shaved by `shavePackage` and `collectForestSlicePlans`, and
 * each novel atom checked by the shave's own conservation gate (DEC-DUC-GATE-REJECT-001).
 *
 * Node's loader runs a module as the body of a function of its wrapper's parameters. Inside the
 * module they are bound names, as a CommonJS module's `require` is:
 * - `exports`, `require`, `module`: the module record's own (#1290);
 * - `process`: the process object `internal/bootstrap/node` builds;
 * - `primordials`: the object `internal/per_context/primordials` builds from the platform's
 *   built-ins (layer 1, #1332) — itself a module of this library;
 * - `internalBinding`: the bindings below the JavaScript, classified in `bindings.ts`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectForestSlicePlans,
  enclosingBindingsOf,
  forestGateContext,
  runDucConservationGate,
  shavePackage,
  slice,
} from "@yakcc/shave";

/** The Node whose library is vendored. */
export const NODE_VERSION = "v22.23.5";

const here = dirname(fileURLToPath(import.meta.url));
/** The vendored library: one file per builtin id. */
export const NODE_LIB = join(here, "..", "vendor", `node-${NODE_VERSION}`, "lib");

/**
 * The parameters of Node's module wrappers: bound names in the modules of the library. A builtin
 * module's are `exports, require, module, process, internalBinding, primordials`; the bootstrap
 * scripts' (`internal/bootstrap/realm`) add `getLinkedBinding` and `getInternalBinding`; the
 * per-context scripts' are `exports, primordials, privateSymbols, perIsolateSymbols`.
 */
export const WRAPPER_PARAMS: ReadonlySet<string> = new Set([
  "exports",
  "require",
  "module",
  "process",
  "internalBinding",
  "primordials",
  "getLinkedBinding",
  "getInternalBinding",
  "privateSymbols",
  "perIsolateSymbols",
  "__filename",
  "__dirname",
]);

/**
 * The globals of the context V8's profiling tools run in (`internal/deps/v8/tools/*`):
 * `internal/v8_prof_processor` makes a context of `arguments`, `write`, `printErr`, `console`,
 * `process` and `Buffer`, and `internal/v8_prof_polyfill` adds `os`, `print`, `read`, `quit` and
 * `readline` to it, standing in for d8's shell.
 */
export const D8_TOOL_GLOBALS: ReadonlySet<string> = new Set([
  "arguments",
  "write",
  "printErr",
  "console",
  "process",
  "Buffer",
  "os",
  "print",
  "read",
  "quit",
  "readline",
]);

/** The names a module of the library runs with bound: its wrapper's, and its context's. */
export function boundNames(id: string): ReadonlySet<string> {
  return id.startsWith("internal/deps/v8/tools/")
    ? new Set([...WRAPPER_PARAMS, ...D8_TOOL_GLOBALS])
    : WRAPPER_PARAMS;
}

/** Every builtin id of the vendored library, sorted. */
export function nodeModuleIds(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".js")) out.push(relative(NODE_LIB, p).replace(/\.js$/, ""));
    }
  };
  walk(NODE_LIB);
  return out.sort();
}

/** The source of a builtin module. */
export function nodeModuleSource(id: string): string {
  return readFileSync(join(NODE_LIB, `${id}.js`), "utf8");
}

/** What shaving one module gave, as the gate judges it. */
export interface NodeModuleReport {
  readonly id: string;
  /** Novel atoms the module was cut into. */
  readonly atoms: number;
  /** Atoms the gate passes: no unexplained name, no lift error, a faithful lift. */
  readonly clean: number;
  /** Unexplained names, with how many atoms read each. */
  readonly unexplained: Readonly<Record<string, number>>;
  /** Atoms whose lift is not faithful, as `missing|extra`. */
  readonly unfaithful: readonly string[];
  readonly liftErrors: readonly string[];
  /** The `internalBinding('x')` names the module reads. */
  readonly bindings: readonly string[];
  /** The builtin ids the module requires. */
  readonly requires: readonly string[];
}

const registry = { findByCanonicalAstHash: async () => [], getBlock: async () => undefined };

/** Shave one builtin module through the real pipeline and gate every atom. */
export async function shaveNodeModule(id: string): Promise<NodeModuleReport> {
  const file = join(NODE_LIB, `${id}.js`);
  const forest = await shavePackage(NODE_LIB, { registry, entryPath: file, maxModules: 1 });
  const plans = await collectForestSlicePlans(
    forest,
    (tree, _registry, options) => slice(tree, registry, options),
    registry,
  );
  const bound = boundNames(id);
  let atoms = 0;
  let clean = 0;
  const unexplained: Record<string, number> = Object.create(null);
  const unfaithful: string[] = [];
  const liftErrors: string[] = [];
  for (const p of plans) {
    const ctx = forestGateContext(plans, p.filePath);
    const text = readFileSync(p.filePath, "utf8");
    for (const e of p.slicePlan.entries) {
      if (e.kind !== "novel-glue" || typeof e.source !== "string") continue;
      atoms++;
      // An atom cut from inside a function reads that function's names (#1297), as the pipeline's
      // persist step passes them.
      const r = runDucConservationGate(
        e.source,
        ctx.internalSymbols,
        ctx.moduleBindings,
        new Set([...bound, ...enclosingBindingsOf(text, e.sourceRange)]),
      );
      if (r.liftError !== undefined) {
        liftErrors.push(r.liftError);
        continue;
      }
      const faithful = r.fidelity?.holds ?? true;
      if (!faithful && r.fidelity !== undefined)
        unfaithful.push(`${r.fidelity.missing.join(",")}|${r.fidelity.extra.join(",")}`);
      for (const u of r.unexplained) unexplained[u.symbol] = (unexplained[u.symbol] ?? 0) + 1;
      if (r.unexplained.length === 0 && faithful) clean++;
    }
  }
  const source = nodeModuleSource(id);
  const bindings = [
    ...new Set([...source.matchAll(/internalBinding\(\s*'([a-z_0-9]+)'\s*\)/g)].map((m) => m[1])),
  ].sort() as string[];
  const requires = [
    ...new Set([...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])),
  ].sort() as string[];
  return { id, atoms, clean, unexplained, unfaithful, liftErrors, bindings, requires };
}
