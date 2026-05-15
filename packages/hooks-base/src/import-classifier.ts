// SPDX-License-Identifier: MIT
// @decision DEC-WI508-INTERCEPT-CLASSIFIER-SHARED-001
// title: shared import classifier lives in @yakcc/hooks-base/src/import-classifier.ts
// status: decided (WI-508-IMPORT-INTERCEPT Slice 1)
// rationale:
//   BARE_NODE_CORE_MODULES, NODE_BUILTIN_PREFIX, WORKSPACE_PREFIX, and
//   extractBareName() were duplicated between packages/hooks-base/src/import-intercept.ts
//   and packages/compile/src/import-gate.ts. Duplication is a bug: the two consumers
//   must stay in sync or classification diverges silently. This module is the single
//   source of truth per EC §4.6.10. @yakcc/compile adds @yakcc/hooks-base as a
//   workspace dependency to import from here.

/** Prefix for Node built-in modules (e.g. "node:fs"). */
export const NODE_BUILTIN_PREFIX = "node:";

/** Prefix for workspace-internal packages. */
export const WORKSPACE_PREFIX = "@yakcc/";

/**
 * Bare Node core module names (without "node:" prefix).
 * Mirrors BARE_NODE_CORE_MODULES in packages/shave/src/universalize/slicer.ts.
 * Any divergence from slicer.ts is a bug -- tracked in DEC-WI508-INTERCEPT-001.
 */
export const BARE_NODE_CORE_MODULES = new Set([
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

/**
 * Extract the bare package name from a module specifier.
 * "@scope/pkg/subpath" => "pkg"
 * "pkg/subpath" => "pkg"
 * "pkg" => "pkg"
 */
export function extractBareName(spec: string): string {
  if (spec.startsWith("@")) {
    // Scoped package: "@scope/name" or "@scope/name/subpath"
    const parts = spec.slice(1).split("/");
    return parts[1] ?? spec;
  }
  return spec.split("/")[0] ?? spec;
}
