// SPDX-License-Identifier: Apache-2.0
/**
 * Emitted TypeScript as a script `new Function` can run: the DUC runtime's import is replaced by its
 * definition, and `export` is dropped.
 */
const RUNTIME = [
  "function __yakccTry(body, handler, finalizer) {",
  "  try { try { return body(); } catch (thrown) { if (handler === undefined) throw thrown; return handler(thrown); } }",
  "  finally { if (finalizer !== undefined) { const done = finalizer(); if (Array.isArray(done) && done[0] === 1) return done; } }",
  "}",
].join("\n");

export function runnable(code: string): string {
  return code
    .replace(/^import \{ __yakccTry \} from "@yakcc\/duc\/runtime";$/m, RUNTIME)
    .replace("export function f", "function f");
}
