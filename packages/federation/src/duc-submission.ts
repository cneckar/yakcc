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
  checkSubmission,
  emitTypeScript,
  graphIdentity,
  inferTypes,
  isWellFormed,
  nondeterministicObservations,
  parseType,
  primitiveReport,
  printLineForm,
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
  /** True when every implementation in the batch was admitted (reached at least `claimed`). */
  readonly accepted: boolean;
  readonly implementations: readonly ImplementationVerdict[];
}

export interface ReceiverOptions {
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

/** One vector's run: its value, what it threw, or the name the context could not provide. */
export interface RunResult {
  readonly value?: unknown;
  readonly threw?: string;
  readonly unrunnable?: string;
}

/** The TypeScript lowering of a graph as a script: imports and `export` dropped, types stripped. */
function scriptOf(graph: DucGraph, name: string): string {
  const code = emitTypeScript(graph, undefined, { name });
  return stripTypeScriptTypes(
    code
      .split("\n")
      .filter((line) => !/^import\s/.test(line))
      .join("\n")
      .replace(/^export\s+/m, ""),
  );
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
): (inputs: readonly unknown[]) => Promise<RunResult> {
  const context = vm.createContext({ __yakccTry, __yakccTryAsync });
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
  define(graph);
  vm.runInContext(scriptOf(graph, SUBJECT), context, { timeout: timeoutMs });
  const call = vm.runInContext(
    `(inputsJson) => ${SUBJECT}(...JSON.parse(inputsJson))`,
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
  const baseSets = options.baseSets ?? [ECMASCRIPT, NODE];
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

  // Check 5, over the batch: links close within the batch's admitted contracts and the store.
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
    if (own !== undefined && !own.closed) {
      const parts = [
        own.holes.length > 0 ? `unlinked or not on the target: ${own.holes.join(", ")}` : "",
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
    // Check 8: the submitter's evidence, run on the receiver's own lowering.
    let run: ReturnType<typeof lowerForConformance>;
    try {
      run = lowerForConformance(graph, timeoutMs, resolve);
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
  return { accepted: verdicts.every((v) => v.refused === undefined), implementations: verdicts };
}
