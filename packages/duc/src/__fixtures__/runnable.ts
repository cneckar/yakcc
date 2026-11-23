// SPDX-License-Identifier: Apache-2.0
/**
 * Emitted TypeScript as a script `new Function` can run: the DUC runtime's import is replaced by its
 * definition, and `export` is dropped.
 */
const RUNTIME =
  "function __yakccTry(body, handler) { try { return body(); } catch (thrown) { return handler(thrown); } }";

export function runnable(code: string): string {
  return code
    .replace(/^import \{ __yakccTry \} from "@yakcc\/duc\/runtime";$/m, RUNTIME)
    .replace("export function f", "function f");
}
