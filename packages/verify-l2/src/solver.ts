// SPDX-License-Identifier: Apache-2.0
/**
 * The solver: Z3, compiled to WebAssembly (`z3-solver`, pinned), driven by SMT-LIB2 text only.
 *
 * The query text is the whole input, so a verifier daemon can rerun it with any Z3 and compare.
 * Each query gets a fresh context, and sets every budget it uses: Z3's `:timeout` is a global
 * parameter, and a value set by one query is otherwise still in force for the next (observed with
 * z3-solver 5.4.1).
 *
 * The text is passed in memory this module allocates and frees only after Z3 answers. z3-solver's
 * own `eval_smtlib2_string` copies it onto the WebAssembly stack, which `ccall` pops as soon as it
 * returns, while the solver thread is still reading it: under load a query was seen corrupted
 * ("unknown constant impl_L0_post_i", then "unexpected character"). A corrupted query that still
 * parsed would be a different query, so this is a soundness matter, not a flake.
 */
import { init } from "z3-solver";

type Z3Api = Awaited<ReturnType<typeof init>>;

interface Emscripten {
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  async_call(fn: unknown, ...args: number[]): Promise<string>;
  _async_Z3_eval_smtlib2_string: unknown;
}

/** Evaluates SMT-LIB2 text in a context, from a heap copy that lives until the answer. */
async function evaluate(api: Z3Api, ctx: unknown, text: string): Promise<string> {
  const em = api.em as unknown as Emscripten;
  const bytes = new TextEncoder().encode(text);
  const ptr = em._malloc(bytes.length + 1);
  if (ptr === 0) throw new Error("solver: out of memory for the query");
  try {
    em.HEAPU8.set(bytes, ptr);
    em.HEAPU8[ptr + bytes.length] = 0;
    return await em.async_call(em._async_Z3_eval_smtlib2_string, ctx as number, ptr);
  } finally {
    em._free(ptr);
  }
}

let api: Promise<Z3Api> | undefined;
let queue: Promise<unknown> = Promise.resolve();

function z3(): Promise<Z3Api> {
  api ??= init();
  return api;
}

/** The solver's name and full version, for the record. */
export async function solverVersion(): Promise<string> {
  const { Z3 } = await z3();
  return `z3 ${Z3.get_full_version()}`;
}

/** What `(check-sat)` answered, with the model or the reason. */
export type SolverAnswer =
  | { readonly status: "sat"; readonly values: string }
  | { readonly status: "unsat" }
  | { readonly status: "unknown"; readonly reason: string };

/**
 * Runs a query that ends in `(check-sat)`. On `sat` it asks for the values of `modelOf`; on
 * `unknown`, for the reason. Calls are serialized: the WebAssembly build runs one at a time.
 */
export function check(query: string, modelOf: readonly string[]): Promise<SolverAnswer> {
  const run = queue.then(async (): Promise<SolverAnswer> => {
    const api = await z3();
    const { Z3 } = api;
    const ctx = Z3.mk_context(Z3.mk_config());
    try {
      const out = (await evaluate(api, ctx, query)).trim();
      const status = out.split("\n").at(-1)?.trim();
      if (out.includes("(error")) throw new Error(`solver error: ${out}`);
      if (status === "unsat") return { status: "unsat" };
      if (status === "sat") {
        const values =
          modelOf.length === 0
            ? ""
            : await evaluate(api, ctx, `(get-value (${modelOf.join(" ")}))`);
        if (values.includes("(error")) throw new Error(`solver error: ${values}`);
        return { status: "sat", values };
      }
      if (status === "unknown") {
        const info = await evaluate(api, ctx, "(get-info :reason-unknown)");
        const reason = /:reason-unknown\s+"?([^")]*)/.exec(info)?.[1] ?? info.trim();
        return { status: "unknown", reason };
      }
      throw new Error(`unexpected solver output: ${out}`);
    } finally {
      Z3.del_context(ctx);
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Stops the solver's worker threads, so the process can exit. */
export async function shutdownSolver(): Promise<void> {
  if (api === undefined) return;
  const { em } = await api;
  await queue;
  (em as unknown as { PThread: { terminateAllThreads(): void } }).PThread.terminateAllThreads();
  api = undefined;
}
