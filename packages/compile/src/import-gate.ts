// SPDX-License-Identifier: MIT
// @decision DEC-WI508-IMPORT-GATE-001
// title: compile-time import gate -- UnexpandedImportError for covered foreign imports
// status: decided (WI-508-IMPORT-INTERCEPT Slice 1)
// rationale:
//   assertNoUnexpandedImports() is the compile-time enforcement layer complementing
//   the runtime import-intercept hook in @yakcc/hooks-base.
//   Classification mirrors import-intercept.ts. Any divergence is a bug.

import { Project, ScriptKind } from "ts-morph";

const NODE_BUILTIN_PREFIX = "node:";
const WORKSPACE_PREFIX = "@yakcc/";

const BARE_NODE_CORE_MODULES = new Set([
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

export const GATE_INTERCEPT_ALLOWLIST = new Set(["validator"]);

/**
 * Thrown by assertNoUnexpandedImports() when a covered foreign import is present.
 * Mirrors GlueLeafInWasmModeError from slice-plan.ts.
 * @decision DEC-WI508-IMPORT-GATE-001
 */
export class UnexpandedImportError extends Error {
  readonly moduleSpecifier: string;
  readonly namedImports: readonly string[];

  constructor(moduleSpecifier: string, namedImports: readonly string[]) {
    const namedStr =
      namedImports.length > 0
        ? ` (${namedImports.slice(0, 3).join(", ")}${namedImports.length > 3 ? ", ..." : ""})`
        : "";
    super(
      `Unexpanded covered import: "${moduleSpecifier}"${namedStr} is on the yakcc intercept allowlist but was not resolved through the registry.`,
    );
    this.name = "UnexpandedImportError";
    this.moduleSpecifier = moduleSpecifier;
    this.namedImports = namedImports;
  }
}

function extractBareName(spec: string): string {
  if (spec.startsWith("@")) {
    const parts = spec.slice(1).split("/");
    return parts[1] ?? spec;
  }
  return spec.split("/")[0] ?? spec;
}

function collectCoveredImports(
  source: string,
): Array<{ moduleSpecifier: string; namedImports: readonly string[] }> {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true },
  });

  const sourceFile = project.createSourceFile("__gate__.ts", source, {
    scriptKind: ScriptKind.TSX,
  });

  const found: Array<{ moduleSpecifier: string; namedImports: readonly string[] }> = [];

  for (const decl of sourceFile.getImportDeclarations()) {
    if (decl.isTypeOnly()) continue;
    const spec = decl.getModuleSpecifierValue();
    if (spec.startsWith(".")) continue;
    if (spec.startsWith(NODE_BUILTIN_PREFIX)) continue;
    if (spec.startsWith(WORKSPACE_PREFIX)) continue;
    const bareName = extractBareName(spec);
    if (BARE_NODE_CORE_MODULES.has(bareName)) continue;
    if (!GATE_INTERCEPT_ALLOWLIST.has(bareName)) continue;
    const namedImports = decl.getNamedImports().map((ni) => ni.getName());
    found.push({ moduleSpecifier: spec, namedImports });
  }
  return found;
}

export interface AssertNoUnexpandedImportsOptions {
  readonly disabled?: boolean;
}

/**
 * Assert that the source string contains no unexpanded covered imports.
 * Throws UnexpandedImportError on the first covered import found.
 * @throws UnexpandedImportError
 * @decision DEC-WI508-IMPORT-GATE-001
 */
export function assertNoUnexpandedImports(
  source: string,
  options?: AssertNoUnexpandedImportsOptions,
): void {
  if (options?.disabled === true) return;
  const covered = collectCoveredImports(source);
  if (covered.length === 0) return;
  const first = covered[0];
  if (first === undefined) return;
  throw new UnexpandedImportError(first.moduleSpecifier, first.namedImports);
}
