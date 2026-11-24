// SPDX-License-Identifier: MIT
// @decision DEC-DUC-TRUST-MODEL-001 (#1284, #1287): the receiving store's checks for a shared
// submission of DUC implementations. A submission is one closed batch; each implementation in it is
// checked in the order the decision gives, cheapest first, and a check runs only when every check
// before it passed:
//   1 decode (size-capped)  2 well-formedness  3 integrity  4 no external code  5 closure
//   6 capabilities  7 types  8 conformance  9 corroboration
// Passing 1-7 admits the pair (spec, identity) as `claimed`; 8 raises it to `conforming`, 9 to
// `corroborated`. A graph that fails its own evidence (8) is refused. A disagreement with another
// stored implementation (9) is recorded against both, and the pair stays `conforming`.
//
// Capabilities (6): a primitive's capability label `c` is admitted by a contract effect that is `c`
// or starts with `c:` (case-insensitive, e.g. "network:api.example.com"). A nondeterministic result
// is admitted by the effect "nondeterministic". A pure contract (no effects) admits neither.

import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { brotliDecompressSync } from "node:zlib";
import { type SpecYak, specHash } from "@yakcc/contracts";
import {
  type BaseSet,
  type DucGraph,
  ECMASCRIPT,
  NODE,
  type StoredLink,
  WEB,
  checkSubmission,
  declaredNamesOf,
  emitTypeScript,
  graphIdentity,
  graphRoot,
  inferTypes,
  isWellFormed,
  nondeterministicObservations,
  parseType,
  platformModule,
  primitiveReport,
  printLineForm,
  requireSpecifiers,
  unpackGraph,
} from "@yakcc/duc";
import { __yakccTry, __yakccTryAsync } from "@yakcc/duc/runtime";

/** One input vector and the output the contract requires for it. Values are JSON. */
export interface ConformanceVector {
  readonly inputs: readonly unknown[];
  readonly output: unknown;
}

/** One implementation in a shared submission (DEC-DUC-TRUST-MODEL-001 §1). */
export interface SharedImplementation {
  /** The contract the implementation claims. */
  readonly spec: SpecYak;
  /** The contract's hash, as the submitter computed it. */
  readonly specHash: string;
  readonly formatVersion: number;
  /** The packed structure: brotli-compressed compact encoding. */
  readonly structure: Uint8Array;
  /** The graph identity, as the submitter computed it. */
  readonly identity: string;
  /**
   * The graph's root, as the submitter computed it (#1306): the identity, the links and the format
   * version, committed to. A block's root is computed from it, so the graph cannot be swapped.
   */
  readonly root: string;
  readonly lifterVersion?: number;
  readonly links: readonly StoredLink[];
  readonly evidence: readonly ConformanceVector[];
  /** The target base set the graph's primitives are drawn from. */
  readonly baseSet: { readonly target: string; readonly version: number };
}

/** What the receiving store already holds. */
export interface ReceiverStore {
  /** Contracts the store holds an implementation of. */
  readonly contracts: ReadonlySet<string>;
  /** The stored implementations of a contract, with their evidence. */
  implementationsOf(spec: string): readonly StoredImplementation[];
}

export interface StoredImplementation {
  readonly identity: string;
  readonly graph: DucGraph;
  readonly evidence: readonly ConformanceVector[];
}

export type CheckName =
  | "decode"
  | "well-formed"
  | "integrity"
  | "external-code"
  | "closure"
  | "capabilities"
  | "types"
  | "conformance"
  | "corroboration";

export type TrustLevel = "claimed" | "conforming" | "corroborated";

/** A stored implementation and the checked one compute different outputs for an input. */
export interface Disagreement {
  readonly with: string;
  readonly inputs: readonly unknown[];
  readonly ours: unknown;
  readonly theirs: unknown;
}

export interface ImplementationVerdict {
  readonly specHash: string;
  readonly identity: string;
  /** The trust level reached, when the implementation was not refused. */
  readonly level?: TrustLevel;
  /** The first check the implementation failed, and why. */
  readonly refused?: { readonly check: CheckName; readonly reason: string };
  /**
   * Why the evidence could not be run, when it could not: a name the receiver's context cannot
   * provide (a link to an atom that declares a value rather than computing one, or a platform
   * primitive outside the language's built-ins). The pair then stays `claimed`.
   */
  readonly unchecked?: string;
  readonly disagreements: readonly Disagreement[];
}

export interface SubmissionVerdict {
  /**
   * True when every implementation in the batch was admitted (reached at least `claimed`), and no
   * module's evidence failed.
   */
  readonly accepted: boolean;
  readonly implementations: readonly ImplementationVerdict[];
  /** One per module that has evidence of its own. */
  readonly modules: readonly ModuleVerdict[];
}

/** One statement of a module, in the module's order (#1290). */
export interface ModuleStatement {
  readonly specHash: string;
  readonly identity: string;
  /**
   * "function": a function the module defines under `declares[0]` (none when anonymous).
   * "statement": module statements whose graph observes `declares`, in the graph's order.
   */
  readonly kind: "function" | "statement";
  readonly declares: readonly string[];
}

/**
 * A module as the ordered list of its statements (#1290): outside identity, like links. A free
 * name a statement reads is the module's when a statement of the module declares it; `exports` and
 * `module` are the module's own objects; and `require` of a specifier in `requires` is the exports
 * of that module of the submission.
 */
export interface ModuleRecord {
  readonly id: string;
  readonly statements: readonly ModuleStatement[];
  /** A relative `require` specifier the statements use, to the id of the module it names. */
  readonly requires?: Readonly<Record<string, string>>;
  /**
   * Evidence for the module as a whole: each vector calls an exported member (`module.exports`
   * itself when `member` is absent) once the module's statements have run.
   */
  readonly evidence?: readonly (ConformanceVector & { readonly member?: string })[];
}

/** The verdict on a module's own evidence. */
export interface ModuleVerdict {
  readonly id: string;
  /** True when every vector of the module's evidence gives its output. */
  readonly conforming: boolean;
  /** The first vector that does not. */
  readonly reason?: string;
  /** Why the module could not run here (its evidence is then unchecked, not wrong). */
  readonly unchecked?: string;
}

export interface ReceiverOptions {
  /** The modules the batch's implementations are statements of (#1290). */
  readonly modules?: readonly ModuleRecord[];
  /** The base sets the receiver knows, by target (default: ECMAScript and Node). */
  readonly baseSets?: readonly BaseSet[];
  /** The cap on a structure's decompressed size, in bytes (default 4 MiB). */
  readonly maxStructureBytes?: number;
  /** The time a single vector may run, in milliseconds (default 1000). */
  readonly vectorTimeoutMs?: number;
}

class Refusal extends Error {
  constructor(
    readonly check: CheckName,
    reason: string,
  ) {
    super(reason);
  }
}

/** A label the lifter gives a construct it summarizes by its text: `Kind#<16 hex>`. */
const OPAQUE = /^[A-Za-z]+#[0-9a-f]{16}$/;

/** Names that run text as code, refused however they are reached (linked or not). */
const CODE_FROM_TEXT = new Set(["eval", "Function"]);

function externalCode(g: DucGraph): string[] {
  const found: string[] = [];
  for (const n of g.nodes) {
    if (n.closure !== undefined) found.push(...externalCode(n.closure));
    else if ((n.kind === "op" || n.kind === "loop") && OPAQUE.test(n.label ?? "")) {
      found.push(n.label ?? "");
    } else if (n.diamond !== undefined && CODE_FROM_TEXT.has(n.diamond.symbol)) {
      found.push(n.diamond.symbol);
    }
  }
  return found;
}

/** The linked references of a graph and its closures: symbol to the contract it is linked to. */
function linksOf(g: DucGraph, into = new Map<string, string>()): Map<string, string> {
  for (const n of g.nodes) {
    if (n.closure !== undefined) linksOf(n.closure, into);
    const d = n.diamond;
    if (d !== undefined && d.reason !== "platform-primitive" && d.spec !== undefined) {
      into.set(d.symbol, d.spec);
    }
  }
  return into;
}

/**
 * Names a module provides its statements (#1290): what its statements declare, its `exports` and
 * `module`, and `require` when every specifier the graph requires is a module of the submission or
 * one the target's platform provides.
 */
function moduleProvides(record: ModuleRecord, graph: DucGraph, base: BaseSet): Set<string> {
  const names = new Set<string>(["exports", "module"]);
  for (const st of record.statements) for (const d of st.declares) names.add(d);
  const specs = requireSpecifiers(graph);
  const resolvable = (x: string | null): boolean =>
    x !== null && (record.requires?.[x] !== undefined || platformModule(base, x) !== undefined);
  if (specs.length > 0 && specs.every(resolvable)) names.add("require");
  return names;
}

function admits(effects: readonly string[], capability: string): boolean {
  const c = capability.toLowerCase();
  return effects.some((e) => {
    const x = e.toLowerCase();
    return x === c || x.startsWith(`${c}:`);
  });
}

/** Checks 1-4 for one implementation: the decoded graph, or a refusal. */
function decodeAndInspect(impl: SharedImplementation, maxBytes: number): DucGraph {
  // 1. Decode, with the decompressed size capped before the structure is parsed.
  let graph: DucGraph;
  try {
    brotliDecompressSync(impl.structure, { maxOutputLength: maxBytes });
  } catch (e) {
    throw new Refusal(
      "decode",
      `the structure does not decompress within ${maxBytes} bytes: ${String(e)}`,
    );
  }
  try {
    graph = unpackGraph({
      formatVersion: impl.formatVersion,
      structure: impl.structure,
      links: impl.links,
    });
  } catch (e) {
    throw new Refusal("decode", `the structure does not decode: ${(e as Error).message}`);
  }
  // 2. Well-formedness: single assignment, conservation, acyclicity, and nesting the line form reads.
  const wf = isWellFormed(graph);
  if (!wf.wellFormed) {
    throw new Refusal(
      "well-formed",
      `the graph is not well-formed: ${wf.violations.map((v) => v.kind).join(", ")}`,
    );
  }
  try {
    printLineForm(graph);
  } catch (e) {
    throw new Refusal("well-formed", `the graph's regions do not nest: ${(e as Error).message}`);
  }
  // 3. Integrity: the keys are recomputed from the content.
  const identity = graphIdentity(graph);
  if (identity !== impl.identity) {
    throw new Refusal("integrity", `the graph's identity is ${identity}, not ${impl.identity}`);
  }
  // The root commits to the links and the format version too (#1306): a link swapped under the same
  // structure, or a structure claimed in another format, does not hash to the root it came with.
  const root = graphRoot(identity, impl.links, impl.formatVersion);
  if (root !== impl.root) {
    throw new Refusal("integrity", `the graph's root is ${root}, not ${impl.root}`);
  }
  const spec = specHash(impl.spec);
  if (spec !== impl.specHash) {
    throw new Refusal("integrity", `the contract's hash is ${spec}, not ${impl.specHash}`);
  }
  // 4. No external code: no construct whose meaning is its source text.
  const external = externalCode(graph);
  if (external.length > 0) {
    throw new Refusal(
      "external-code",
      `the graph holds code given as text, or constructs summarized by their text: ${external.join(", ")}`,
    );
  }
  return graph;
}

/** Checks 6 and 7 for one implementation. */
function checkCapabilitiesAndTypes(
  impl: SharedImplementation,
  graph: DucGraph,
  base: BaseSet,
): void {
  // 6. Capabilities and nondeterminism against the contract's declared effects.
  const effects = impl.spec.effects;
  for (const use of primitiveReport(graph, base).uses) {
    for (const c of use.capabilities) {
      if (!admits(effects, c)) {
        throw new Refusal(
          "capabilities",
          `${use.symbol} grants "${c}", which the contract's effects do not declare`,
        );
      }
    }
  }
  // A platform module carries its labels: what it grants, and whether it is nondeterministic.
  let moduleNondeterministic: string | undefined;
  for (const spec of requireSpecifiers(graph)) {
    const labels = spec !== null ? platformModule(base, spec) : undefined;
    if (labels === undefined) continue;
    if (labels.capability !== undefined && !admits(effects, labels.capability)) {
      throw new Refusal(
        "capabilities",
        `require("${spec}") grants "${labels.capability}", which the contract's effects do not declare`,
      );
    }
    if (labels.nondeterministic) moduleNondeterministic ??= `require("${spec}")`;
  }
  if (moduleNondeterministic !== undefined && !admits(effects, "nondeterministic")) {
    throw new Refusal(
      "capabilities",
      `${moduleNondeterministic} is nondeterministic, and the contract does not declare it`,
    );
  }
  const nondeterministic = nondeterministicObservations(graph, base);
  if (nondeterministic.length > 0 && !admits(effects, "nondeterministic")) {
    throw new Refusal(
      "capabilities",
      `the result depends on ${nondeterministic[0]?.source}, which is nondeterministic, and the contract does not declare it`,
    );
  }
  // 7. Types: inference seeded with the contract's inputs must fit its output.
  const output = impl.spec.outputs[0]?.type;
  const report = inferTypes(graph, {
    inputs: impl.spec.inputs.map((p) => parseType(p.type)),
    ...(output !== undefined ? { output: parseType(output) } : {}),
  });
  if (report.mismatches.length > 0) {
    throw new Refusal("types", report.mismatches.join("; "));
  }
}

const SUBJECT = "__yakccSubject";
let subjects = 0;

/** One vector's run: its value, what it threw, or the name the context could not provide. */
export interface RunResult {
  readonly value?: unknown;
  readonly threw?: string;
  readonly unrunnable?: string;
}

/** The TypeScript lowering of a graph as a script: imports and `export` dropped, types stripped. */
function scriptOf(graph: DucGraph, name: string): string {
  const code = emitTypeScript(graph, undefined, { name });
  const lines = code.split("\n").filter((line) => !/^import\s/.test(line));
  const outs = moduleOutputs(graph, lines);
  if (outs === undefined) return stripTypeScriptTypes(lines.join("\n").replace(/^export\s+/m, ""));
  // A module statement is a function here too: lowering it must not run it (#1292). It returns
  // its one declared value, or the list of them.
  const body = lines.filter((line) => !/^export\b/.test(line)).join("\n");
  const result = outs.length === 1 ? (outs[0] as string) : `[${outs.join(", ")}]`;
  return stripTypeScriptTypes(`function ${name}() {\n${body}\nreturn ${result};\n}`);
}

/**
 * The names a module statement's emitted module form gives its declared values, in order; undefined
 * when the graph emitted as a function (#1290, #1292).
 */
function moduleOutputs(graph: DucGraph, lines: readonly string[]): string[] | undefined {
  const names = declaredNamesOf(graph);
  if (names === undefined || lines.some((line) => /^export (async )?function\*? /.test(line)))
    return undefined;
  return names.map((n) => (n === "default" ? "__yakccExportDefault" : n));
}

/**
 * A graph as a function the receiver runs: lowered to TypeScript, types stripped, in a new context
 * that holds the language's built-ins and the DUC runtime, nothing of the host. Each linked
 * reference is defined in the same context, from the implementation `resolve` gives for its
 * contract, and so on for theirs.
 */
export function lowerForConformance(
  graph: DucGraph,
  timeoutMs = 1000,
  resolve: (spec: string) => DucGraph | undefined = () => undefined,
  moduleContext?: vm.Context,
): (inputs: readonly unknown[]) => Promise<RunResult> {
  // In a module's context, the module defines what its statements read (#1290).
  const context = moduleContext ?? vm.createContext({ __yakccTry, __yakccTryAsync });
  const defined = new Set<string>();
  const define = (g: DucGraph): void => {
    for (const [symbol, spec] of linksOf(g)) {
      if (defined.has(symbol)) continue;
      defined.add(symbol);
      const linked = resolve(spec);
      // Only a graph that computes something runs as a function; one that only declares a value
      // (a module statement) is not a definition the context can hold.
      const computes =
        linked !== undefined &&
        (linked.obs.length > 0 || linked.nodes.some((n) => n.kind === "param-source"));
      if (!computes) continue;
      vm.runInContext(scriptOf(linked, symbol), context, { timeout: timeoutMs });
      define(linked);
    }
  };
  if (moduleContext === undefined) define(graph);
  // Each lowering has its own name: a module's context holds several.
  const subject = `${SUBJECT}${subjects++}`;
  vm.runInContext(scriptOf(graph, subject), context, { timeout: timeoutMs });
  const call = vm.runInContext(
    `(inputsJson) => ${subject}(...JSON.parse(inputsJson))`,
    context,
  ) as (json: string) => unknown;
  const runner = vm.createContext({ call });
  return async (inputs) => {
    try {
      runner.x = JSON.stringify(inputs);
      let value = vm.runInContext("call(x)", runner, { timeout: timeoutMs }) as unknown;
      if (value !== null && typeof (value as { then?: unknown }).then === "function") {
        let timer: NodeJS.Timeout | undefined;
        value = await Promise.race([
          value as Promise<unknown>,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`timed out after ${timeoutMs} ms`)),
              timeoutMs,
            );
          }),
        ]).finally(() => clearTimeout(timer));
      }
      // Vectors are JSON: the value is compared as JSON (functions and undefined members drop).
      const json = value === undefined ? undefined : JSON.stringify(value);
      return { value: json === undefined ? undefined : (JSON.parse(json) as unknown) };
    } catch (e) {
      const name = (e as { name?: unknown } | null)?.name;
      const message = (e as { message?: unknown } | null)?.message;
      const text = typeof message === "string" ? message : String(e);
      if (name === "ReferenceError") return { unrunnable: text };
      return { threw: text };
    }
  };
}

/** A module statement's observed values, run in the module's context: its declared names' values. */
function runStatement(graph: DucGraph, context: vm.Context, timeoutMs: number): unknown[] {
  const name = `__yakccStatement${subjects++}`;
  vm.runInContext(scriptOf(graph, name), context, { timeout: timeoutMs });
  const value = vm.runInContext(`${name}()`, context, { timeout: timeoutMs }) as unknown;
  const names = declaredNamesOf(graph);
  if (names === undefined) return graph.obs.length === 1 ? [value] : [];
  return names.length === 1 ? [value] : (value as unknown[]);
}

type ModuleState = { context: vm.Context } | { unrunnable: string };

/**
 * A module run in its own context (#1290): its own `exports`, `module` and `require`; its functions
 * defined first (a function declaration is hoisted), then its statements in order, each statement's
 * results bound to the names it declares. A module that cannot run says why.
 */
function moduleRunner(
  records: readonly ModuleRecord[],
  graphOf: (st: ModuleStatement) => DucGraph | undefined,
  timeoutMs: number,
): (id: string) => ModuleState {
  const states = new Map<string, ModuleState>();
  const run = (id: string): ModuleState => {
    const known = states.get(id);
    if (known !== undefined) return known;
    const record = records.find((r) => r.id === id);
    if (record === undefined) return { unrunnable: `the module ${id} is not in the submission` };
    const context = vm.createContext({ __yakccTry, __yakccTryAsync });
    const moduleObject = { exports: {} as Record<string, unknown> };
    context.module = moduleObject;
    context.exports = moduleObject.exports;
    context.require = (spec: string): unknown => {
      const target = record.requires?.[spec];
      if (target === undefined)
        throw new ReferenceError(`require("${spec}") is not in the submission`);
      const state = run(target);
      if ("unrunnable" in state) throw new ReferenceError(state.unrunnable);
      return (state.context.module as { exports: unknown }).exports;
    };
    // Set before running: a cycle sees the module's exports as they are so far, as in CommonJS.
    const state: ModuleState = { context };
    states.set(id, state);
    try {
      for (const st of record.statements) {
        if (st.kind !== "function" || st.declares[0] === undefined) continue;
        const g = graphOf(st);
        if (g === undefined) throw new ReferenceError(`statement ${st.identity} is not available`);
        vm.runInContext(scriptOf(g, st.declares[0]), context, { timeout: timeoutMs });
      }
      for (const st of record.statements) {
        if (st.kind !== "statement") continue;
        const g = graphOf(st);
        if (g === undefined) throw new ReferenceError(`statement ${st.identity} is not available`);
        const values = runStatement(g, context, timeoutMs);
        st.declares.forEach((name, k) => {
          context[name] = values[k];
        });
      }
    } catch (e) {
      const message = (e as { message?: unknown } | null)?.message;
      const failed: ModuleState = {
        unrunnable: `the module ${id} does not run: ${typeof message === "string" ? message : String(e)}`,
      };
      states.set(id, failed);
      return failed;
    }
    return state;
  };
  return run;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b) && (a === undefined) === (b === undefined);
}

/**
 * The receiving store's verdict on a shared submission (DEC-DUC-TRUST-MODEL-001, #1287): for each
 * implementation, the trust level it reaches, or the first check it fails.
 */
export async function checkSharedSubmission(
  batch: readonly SharedImplementation[],
  store: ReceiverStore,
  options: ReceiverOptions = {},
): Promise<SubmissionVerdict> {
  const baseSets = options.baseSets ?? [ECMASCRIPT, NODE, WEB];
  const maxBytes = options.maxStructureBytes ?? 4 * 1024 * 1024;
  const timeoutMs = options.vectorTimeoutMs ?? 1000;
  const refused = new Map<number, { check: CheckName; reason: string }>();
  const graphs = new Map<number, DucGraph>();

  // Checks 1-4, per implementation.
  batch.forEach((impl, i) => {
    try {
      graphs.set(i, decodeAndInspect(impl, maxBytes));
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      refused.set(i, { check: e.check, reason: e.message });
    }
  });

  // Check 5, over the batch: links close within the batch's admitted contracts and the store, and
  // a module's statements read what the module provides.
  const keyOf = (x: { specHash: string; identity: string }): string =>
    `${x.specHash}|${x.identity}`;
  const moduleOf = new Map<string, ModuleRecord>();
  for (const m of options.modules ?? []) for (const st of m.statements) moduleOf.set(keyOf(st), m);
  const admitted = [...graphs.keys()];
  const baseOf = (i: number): BaseSet | undefined => {
    const want = batch[i]?.baseSet;
    return baseSets.find((b) => b.target === want?.target && b.version === want?.version);
  };
  for (const i of admitted) {
    const base = baseOf(i);
    const impl = batch[i] as SharedImplementation;
    if (base === undefined) {
      refused.set(i, {
        check: "closure",
        reason: `the base set ${impl.baseSet.target}@${impl.baseSet.version} is not one this store knows`,
      });
      continue;
    }
    const report = checkSubmission(
      admitted
        .filter((j) => !refused.has(j) || j === i)
        .map((j) => ({ spec: batch[j]?.specHash as string, graph: graphs.get(j) as DucGraph })),
      store.contracts,
      base,
    );
    const own = report.atoms.find((a) => a.identity === impl.identity && a.spec === impl.specHash);
    // A name the implementation's module provides is not a hole (#1290).
    const record = moduleOf.get(keyOf(impl));
    const provided =
      record !== undefined
        ? moduleProvides(record, graphs.get(i) as DucGraph, base)
        : new Set<string>();
    const holes = (own?.holes ?? []).filter((h) => !provided.has(h));
    if (own !== undefined && (holes.length > 0 || own.unresolved.length > 0)) {
      const parts = [
        holes.length > 0 ? `unlinked or not on the target: ${holes.join(", ")}` : "",
        own.unresolved.length > 0 ? `links to contracts absent: ${own.unresolved.join(", ")}` : "",
      ].filter((p) => p !== "");
      refused.set(i, { check: "closure", reason: `the graph is not closed (${parts.join("; ")})` });
    }
  }

  // A linked contract runs as an admitted implementation of it in the batch, or a stored one.
  const resolve = (spec: string): DucGraph | undefined => {
    for (const [j, g] of graphs) if (!refused.has(j) && batch[j]?.specHash === spec) return g;
    return store.implementationsOf(spec)[0]?.graph;
  };
  // A module statement's graph: an admitted one of the batch, or a stored one.
  const graphOf = (st: ModuleStatement): DucGraph | undefined => {
    for (const [j, g] of graphs)
      if (!refused.has(j) && keyOf(batch[j] as SharedImplementation) === keyOf(st)) return g;
    return store.implementationsOf(st.specHash).find((o) => o.identity === st.identity)?.graph;
  };
  const runModule = moduleRunner(options.modules ?? [], graphOf, timeoutMs);
  const verdicts: ImplementationVerdict[] = [];
  for (const [i, impl] of batch.entries()) {
    const graph = graphs.get(i);
    const already = refused.get(i);
    if (graph === undefined || already !== undefined) {
      verdicts.push({
        specHash: impl.specHash,
        identity: impl.identity,
        refused: already ?? { check: "decode", reason: "not decoded" },
        disagreements: [],
      });
      continue;
    }
    try {
      // Checks 6 and 7.
      checkCapabilitiesAndTypes(impl, graph, baseOf(i) as BaseSet);
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      verdicts.push({
        specHash: impl.specHash,
        identity: impl.identity,
        refused: { check: e.check, reason: e.message },
        disagreements: [],
      });
      continue;
    }
    // Check 8: the submitter's evidence, run on the receiver's own lowering. A module's statement
    // runs in its module's context.
    const record = moduleOf.get(keyOf(impl));
    const moduleState = record !== undefined ? runModule(record.id) : undefined;
    if (moduleState !== undefined && "unrunnable" in moduleState && impl.evidence.length > 0) {
      verdicts.push({
        specHash: impl.specHash,
        identity: impl.identity,
        level: "claimed",
        unchecked: moduleState.unrunnable,
        disagreements: [],
      });
      continue;
    }
    let run: ReturnType<typeof lowerForConformance>;
    try {
      run = lowerForConformance(
        graph,
        timeoutMs,
        resolve,
        moduleState !== undefined && "context" in moduleState ? moduleState.context : undefined,
      );
    } catch {
      // A graph the receiver cannot lower stays a claim: there is nothing to run its evidence on.
      verdicts.push({
        specHash: impl.specHash,
        identity: impl.identity,
        level: "claimed",
        disagreements: [],
      });
      continue;
    }
    let failure: string | undefined;
    let unchecked: string | undefined;
    for (const v of impl.evidence) {
      const got = await run(v.inputs);
      if (got.unrunnable !== undefined) {
        unchecked = got.unrunnable;
        break;
      }
      if (got.threw !== undefined || !same(got.value, v.output)) {
        failure = `for ${JSON.stringify(v.inputs)} it gives ${got.threw !== undefined ? `a throw (${got.threw})` : JSON.stringify(got.value)}, and the evidence says ${JSON.stringify(v.output)}`;
        break;
      }
    }
    if (failure !== undefined) {
      verdicts.push({
        specHash: impl.specHash,
        identity: impl.identity,
        refused: { check: "conformance", reason: failure },
        disagreements: [],
      });
      continue;
    }
    if (unchecked !== undefined) {
      verdicts.push({
        specHash: impl.specHash,
        identity: impl.identity,
        level: "claimed",
        unchecked,
        disagreements: [],
      });
      continue;
    }
    const conforming = impl.evidence.length > 0;
    // Check 9: the store's vectors for the contract, and agreement with its other implementations.
    const others = store
      .implementationsOf(impl.specHash)
      .filter((o) => o.identity !== impl.identity);
    const disagreements: Disagreement[] = [];
    let ran = 0;
    for (const other of others) {
      let theirs: ReturnType<typeof lowerForConformance> | undefined;
      try {
        theirs = lowerForConformance(other.graph, timeoutMs, resolve);
      } catch {
        theirs = undefined;
      }
      // Their evidence on this graph; this graph's evidence on theirs.
      const vectors = [...other.evidence, ...impl.evidence];
      for (const v of vectors) {
        const ours = await run(v.inputs);
        const expected: RunResult =
          theirs !== undefined ? await theirs(v.inputs) : { value: v.output };
        // A vector either side cannot run says nothing about agreement.
        if (ours.unrunnable !== undefined || expected.unrunnable !== undefined) continue;
        ran++;
        if (ours.threw !== expected.threw || !same(ours.value, expected.value)) {
          disagreements.push({
            with: other.identity,
            inputs: v.inputs,
            ours: ours.threw !== undefined ? { threw: ours.threw } : ours.value,
            theirs: expected.threw !== undefined ? { threw: expected.threw } : expected.value,
          });
        }
      }
    }
    const level: TrustLevel =
      conforming && ran > 0 && disagreements.length === 0
        ? "corroborated"
        : conforming
          ? "conforming"
          : "claimed";
    verdicts.push({ specHash: impl.specHash, identity: impl.identity, level, disagreements });
  }
  // A module's own evidence, against its exports once its statements have run (#1290).
  const moduleVerdicts: ModuleVerdict[] = [];
  for (const m of options.modules ?? []) {
    if (m.evidence === undefined || m.evidence.length === 0) continue;
    const state = runModule(m.id);
    if ("unrunnable" in state) {
      moduleVerdicts.push({ id: m.id, conforming: false, unchecked: state.unrunnable });
      continue;
    }
    let reason: string | undefined;
    for (const v of m.evidence) {
      const target = `module.exports${v.member !== undefined ? `[${JSON.stringify(v.member)}]` : ""}`;
      let got: RunResult;
      try {
        state.context.__yakccInputs = JSON.stringify(v.inputs);
        const value = vm.runInContext(`${target}(...JSON.parse(__yakccInputs))`, state.context, {
          timeout: timeoutMs,
        }) as unknown;
        const json = value === undefined ? undefined : JSON.stringify(value);
        got = { value: json === undefined ? undefined : (JSON.parse(json) as unknown) };
      } catch (e) {
        const message = (e as { message?: unknown } | null)?.message;
        got = { threw: typeof message === "string" ? message : String(e) };
      }
      if (got.threw !== undefined || !same(got.value, v.output)) {
        reason = `${target}(${JSON.stringify(v.inputs).slice(1, -1)}) gives ${got.threw !== undefined ? `a throw (${got.threw})` : JSON.stringify(got.value)}, and the evidence says ${JSON.stringify(v.output)}`;
        break;
      }
    }
    moduleVerdicts.push(
      reason === undefined
        ? { id: m.id, conforming: true }
        : { id: m.id, conforming: false, reason },
    );
  }
  return {
    accepted:
      verdicts.every((v) => v.refused === undefined) &&
      moduleVerdicts.every((m) => m.conforming || m.unchecked !== undefined),
    implementations: verdicts,
    modules: moduleVerdicts,
  };
}
