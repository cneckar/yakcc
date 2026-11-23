// SPDX-License-Identifier: Apache-2.0
/**
 * The DUC runtime (#1276): the platform primitives a lowering to TypeScript imports, because the
 * lifter writes constructs as calls of them. Each is a primitive of every base set; its meaning is
 * the construct it stands for, and every lowering gives it that meaning.
 */

/** The module the TypeScript lowering imports runtime primitives from. */
export const RUNTIME_MODULE = "@yakcc/duc/runtime";

/**
 * `try { body } catch (e) { handler } finally { finalizer }`: the body's result, or, when it throws,
 * the handler's result for what it threw (with no handler, the throw goes on). The finalizer runs
 * however that ends, and a return in it, `[1, value]`, is the result instead. The lifter writes a
 * try statement as this call over its blocks' closures (#1276).
 */
export function __yakccTry<T>(
  body: () => T,
  handler: ((thrown: unknown) => T) | undefined,
  finalizer?: () => unknown,
): T {
  try {
    try {
      return body();
    } catch (thrown) {
      if (handler === undefined) throw thrown;
      return handler(thrown);
    }
  } finally {
    if (finalizer !== undefined) {
      const done = finalizer();
      // biome-ignore lint/correctness/noUnsafeFinally: a return in a finally block is the result.
      if (Array.isArray(done) && done[0] === 1) return done as T;
    }
  }
}
