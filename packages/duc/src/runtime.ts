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

/**
 * `__yakccTry` for a try statement in a generator whose blocks yield (#1330): its closures are
 * generators, and the statement delegates to this one with `yield*`, so what the consumer sends,
 * throws or returns reaches the blocks as it would reach the statement.
 */
export function* __yakccTryGen<T>(
  body: () => Generator<unknown, T, unknown>,
  handler: ((thrown: unknown) => Generator<unknown, T, unknown>) | undefined,
  finalizer?: () => Generator<unknown, unknown, unknown>,
): Generator<unknown, T, unknown> {
  try {
    try {
      return yield* body();
    } catch (thrown) {
      if (handler === undefined) throw thrown;
      return yield* handler(thrown);
    }
  } finally {
    if (finalizer !== undefined) {
      const done = yield* finalizer();
      // biome-ignore lint/correctness/noUnsafeFinally: a return in a finally block is the result.
      if (Array.isArray(done) && done[0] === 1) return done as T;
    }
  }
}

/** `__yakccTryGen` in an async generator: its closures are async generators (#1330). */
export async function* __yakccTryAsyncGen<T>(
  body: () => AsyncGenerator<unknown, T, unknown>,
  handler: ((thrown: unknown) => AsyncGenerator<unknown, T, unknown>) | undefined,
  finalizer?: () => AsyncGenerator<unknown, unknown, unknown>,
): AsyncGenerator<unknown, T, unknown> {
  try {
    try {
      return yield* body();
    } catch (thrown) {
      if (handler === undefined) throw thrown;
      return yield* handler(thrown);
    }
  } finally {
    if (finalizer !== undefined) {
      const done = yield* finalizer();
      // biome-ignore lint/correctness/noUnsafeFinally: a return in a finally block is the result.
      if (Array.isArray(done) && done[0] === 1) return done as T;
    }
  }
}

/** `__yakccTry` for a try statement whose blocks await: its closures are async (#1276). */
export async function __yakccTryAsync<T>(
  body: () => Promise<T>,
  handler: ((thrown: unknown) => Promise<T>) | undefined,
  finalizer?: () => Promise<unknown>,
): Promise<T> {
  try {
    try {
      return await body();
    } catch (thrown) {
      if (handler === undefined) throw thrown;
      return await handler(thrown);
    }
  } finally {
    if (finalizer !== undefined) {
      const done = await finalizer();
      // biome-ignore lint/correctness/noUnsafeFinally: a return in a finally block is the result.
      if (Array.isArray(done) && done[0] === 1) return done as T;
    }
  }
}

/**
 * `const { a, b, ...rest } = o`'s rest (#1330): o's own enumerable properties, string and symbol
 * keyed, except the keys taken. The TypeScript lowering writes the `ObjectRest` operation as this
 * call, and the lifter reads the call back as the operation.
 */
export function __yakccObjectRest(
  o: unknown,
  taken: readonly string[],
): Record<PropertyKey, unknown> {
  if (o === null || o === undefined) throw new TypeError(`Cannot destructure '${o}'`);
  const from = Object(o) as Record<PropertyKey, unknown>;
  const out: Record<PropertyKey, unknown> = {};
  for (const k of Reflect.ownKeys(from))
    if (
      !(typeof k === "string" && taken.includes(k)) &&
      Object.prototype.propertyIsEnumerable.call(from, k)
    )
      out[k] = from[k];
  return out;
}
