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
  "function* __yakccTryGen(body, handler, finalizer) {",
  "  try { try { return yield* body(); } catch (thrown) { if (handler === undefined) throw thrown; return yield* handler(thrown); } }",
  "  finally { if (finalizer !== undefined) { const done = yield* finalizer(); if (Array.isArray(done) && done[0] === 1) return done; } }",
  "}",
  "async function* __yakccTryAsyncGen(body, handler, finalizer) {",
  "  try { try { return yield* body(); } catch (thrown) { if (handler === undefined) throw thrown; return yield* handler(thrown); } }",
  "  finally { if (finalizer !== undefined) { const done = yield* finalizer(); if (Array.isArray(done) && done[0] === 1) return done; } }",
  "}",
  "function __yakccObjectRest(o, taken) {",
  "  if (o === null || o === undefined) throw new TypeError(`Cannot destructure '${o}'`);",
  "  const from = Object(o); const out = {};",
  "  for (const k of Reflect.ownKeys(from)) if (!(typeof k === 'string' && taken.includes(k)) && Object.prototype.propertyIsEnumerable.call(from, k)) out[k] = from[k];",
  "  return out;",
  "}",
  "async function __yakccTryAsync(body, handler, finalizer) {",
  "  try { try { return await body(); } catch (thrown) { if (handler === undefined) throw thrown; return await handler(thrown); } }",
  "  finally { if (finalizer !== undefined) { const done = await finalizer(); if (Array.isArray(done) && done[0] === 1) return done; } }",
  "}",
].join("\n");

export function runnable(code: string): string {
  return code
    .replace(/^import \{ [^}]* \} from "@yakcc\/duc\/runtime";$/m, RUNTIME)
    .replace(/^export (async )?function(\*?) f/m, "$1function$2 f");
}
