// SPDX-License-Identifier: Apache-2.0
/**
 * The solver: Z3, compiled to WebAssembly (`z3-solver`, pinned), driven by SMT-LIB2 text only.
 *
 * The query text is the whole input, so a verifier daemon can rerun it with any Z3 and compare.
 * Each query gets a fresh context, and sets every budget it uses: Z3's `:timeout` is a global
 * parameter, and a value set by one query is otherwise still in force for the next (observed with
 * z3-solver 5.4.1).
 */
import { init } from "z3-solver";

type Z3Api = Awaited<ReturnType<typeof init>>;

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
    const { Z3 } = await z3();
    const ctx = Z3.mk_context(Z3.mk_config());
    try {
      const out = (await Z3.eval_smtlib2_string(ctx, query)).trim();
      const status = out.split("\n").at(-1)?.trim();
      if (out.includes("(error")) throw new Error(`solver error: ${out}`);
      if (status === "unsat") return { status: "unsat" };
      if (status === "sat") {
        const values =
          modelOf.length === 0
            ? ""
            : await Z3.eval_smtlib2_string(ctx, `(get-value (${modelOf.join(" ")}))`);
        if (values.includes("(error")) throw new Error(`solver error: ${values}`);
        return { status: "sat", values };
      }
      if (status === "unknown") {
        const info = await Z3.eval_smtlib2_string(ctx, "(get-info :reason-unknown)");
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
