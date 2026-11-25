// SPDX-License-Identifier: Apache-2.0
/**
 * The self-rebuild acceptance's harness (#1370, interim steps 1–3): a program shaved to a record of
 * roots, its closure checked and listed, and the program built from the roots alone.
 *
 * 1. `shaveProgram`: each statement's graph packed into the store under its root (`packGraph`); the
 *    record keeps the program's shape (its modules, their statements' kinds and declared names,
 *    their requires and ECMAScript linking) and each statement's root, and has a root of its own.
 * 2. `closureListing`: every free name a graph reads resolves to a binding of its module, an import,
 *    `module`/`exports`/`require`, a leaf, or a platform global (the base set the runtime gives).
 *    Anything else is unlinked.
 *    What is hand-written is listed: the leaves and the runtime's globals the program uses, the
 *    system-call leaf, and the generated `main`.
 * 3. `programOfRoots`: the program back from the record and the store alone (each root's graph
 *    unpacked and checked against its root), for `buildRecord`.
 */
import { NATIVE_GLOBALS, NATIVE_LEAVES, type NativeModule } from "./emit-llvm-boxed.js";
import type { ProgramRecord } from "./program.js";
import { type PackedGraph, packGraph, recordRoot, unpackGraph } from "./store.js";
import type { DucGraph } from "./types.js";

/** A module of a shaved record: its shape, and each statement's graph by root. */
export interface ShavedModule {
  readonly id: string;
  readonly statements: readonly {
    readonly kind: "function" | "statement";
    readonly declares: readonly string[];
    readonly root: string;
  }[];
  readonly requires?: NativeModule["requires"];
  readonly esm?: NativeModule["esm"];
}

/** A program shaved: its entry and modules, every graph a root in the store. */
export interface ShavedRecord {
  readonly entry: string;
  readonly modules: readonly ShavedModule[];
}

export interface Shaved {
  readonly record: ShavedRecord;
  /** The record's own root: BLAKE3 of its canonical JSON. */
  readonly root: string;
  /** The graphs, by root. */
  readonly store: ReadonlyMap<string, PackedGraph>;
}

export class AcceptanceError extends Error {
  override readonly name = "AcceptanceError";
}

/** Step 1: the program's graphs into the store, the record of their roots. */
export function shaveProgram(program: ProgramRecord): Shaved {
  const store = new Map<string, PackedGraph>();
  const modules = program.modules.map(
    (m): ShavedModule => ({
      id: m.id,
      statements: m.statements.map((st) => {
        const packed = packGraph(st.graph);
        store.set(packed.root, packed);
        return { kind: st.kind, declares: st.declares, root: packed.root };
      }),
      ...(m.requires !== undefined ? { requires: m.requires } : {}),
      ...(m.esm !== undefined ? { esm: m.esm } : {}),
    }),
  );
  const record: ShavedRecord = { entry: program.entry, modules };
  return { record, root: recordRoot(JSON.stringify(record)), store };
}

/** Step 3: the program from the record and the store alone; a root missing, or not its graph's, throws. */
export function programOfRoots(
  record: ShavedRecord,
  store: ReadonlyMap<string, PackedGraph>,
): ProgramRecord {
  return {
    entry: record.entry,
    modules: record.modules.map(
      (m): NativeModule => ({
        id: m.id,
        statements: m.statements.map((st) => {
          const packed = store.get(st.root);
          if (packed === undefined) throw new AcceptanceError(`no graph for root ${st.root}`);
          const graph = unpackGraph(packed);
          if (packGraph(graph).root !== st.root)
            throw new AcceptanceError(`the graph stored under ${st.root} is not that root's`);
          return { kind: st.kind, declares: st.declares, graph };
        }),
        ...(m.requires !== undefined ? { requires: m.requires } : {}),
        ...(m.esm !== undefined ? { esm: m.esm } : {}),
      }),
    ),
  };
}

/** What a program's closure is: every free name, resolved; what is hand-written, listed. */
export interface ClosureListing {
  /** Free names no module binds, imports, or the runtime gives: holes (empty when closed). */
  readonly unlinked: readonly { readonly module: string; readonly name: string }[];
  /** Hand-written: the leaves the program calls (the runtime's, per target). */
  readonly leaves: readonly string[];
  /** Hand-written: the platform globals the program reads, which the runtime gives. */
  readonly globals: readonly string[];
  /** Hand-written: always, the system-call leaf and the generated main. */
  readonly runtime: readonly string[];
  /** How many graphs (statements and the closures in them) the program has. */
  readonly graphs: number;
}

const MODULE_NAMES = new Set(["module", "exports", "require", "this"]);

/** Step 2: the closure of a program's graphs, and what of it is hand-written. */
export function closureListing(program: ProgramRecord): ClosureListing {
  const unlinked: { module: string; name: string }[] = [];
  const leaves = new Set<string>();
  const globals = new Set<string>();
  let graphs = 0;
  for (const m of program.modules) {
    const bound = new Set([
      ...m.statements.flatMap((st) => st.declares),
      ...Object.keys(m.esm?.imports ?? {}),
      ...MODULE_NAMES,
    ]);
    const visit = (g: DucGraph): void => {
      graphs++;
      for (const n of g.nodes) {
        if (n.closure !== undefined) visit(n.closure);
        if (n.kind !== "diamond-source" || n.diamond === undefined) continue;
        const name = n.diamond.symbol;
        if (NATIVE_LEAVES.has(name)) leaves.add(name);
        else if (n.diamond.reason === "free-identifier" && bound.has(name)) continue;
        else if (
          n.diamond.reason === "platform-primitive" ||
          NATIVE_GLOBALS.has(name) ||
          name === "arguments"
        )
          globals.add(name);
        else unlinked.push({ module: m.id, name });
      }
    };
    for (const st of m.statements) visit(st.graph);
  }
  return {
    unlinked,
    leaves: [...leaves].sort(),
    globals: [...globals].sort(),
    runtime: ["the system-call leaf (runtime/yk.c, runtime/nolibc.h)", "the generated main"],
    graphs,
  };
}
