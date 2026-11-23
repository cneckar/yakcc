// SPDX-License-Identifier: Apache-2.0
/**
 * The DUC runtime (#1276): the platform primitives a lowering to TypeScript imports, because the
 * lifter writes constructs as calls of them. Each is a primitive of every base set; its meaning is
 * the construct it stands for, and every lowering gives it that meaning.
 */

/** The module the TypeScript lowering imports runtime primitives from. */
export const RUNTIME_MODULE = "@yakcc/duc/runtime";

/**
 * `try { body } catch (e) { handler }`: the body's result, or, when it throws, the handler's result
 * for what it threw. The lifter writes a try statement as this call over two closures (#1276).
 */
export function __yakccTry<T>(body: () => T, handler: (thrown: unknown) => T): T {
  try {
    return body();
  } catch (thrown) {
    return handler(thrown);
  }
}
