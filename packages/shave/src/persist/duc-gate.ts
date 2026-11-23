// SPDX-License-Identifier: MIT
//
// @decision DEC-DUC-CONSERVATION-GATE-001
// title: DUC conservation gate at shave persist time (warn-first, then reject)
// status: decided (wi-duc-influence-layer S2, GH #1163)
// rationale:
//   Before an atom is admitted to the registry, it is lifted to a DUC graph
//   (@yakcc/duc) and its unknown-support (usupp) is computed. The conservative
//   builder never leaves a dangling use — every unresolved reference is a
//   declared ♦-source — so the graph is well-formed by construction (DUC
//   Prop 8.1). The gate's job is therefore to (a) record usupp as first-class
//   provenance (replacing the informal "candidate pending audit" status,
//   DEC-DUC-USUPP-PROVENANCE-001), and (b) surface the *unexplained* unknowns:
//   `free-identifier` ♦-sources — names that resolve neither to an import nor to
//   a standard ambient global, i.e. the closest thing to a genuinely dangling
//   reference in an extracted fragment.
//
//   Rollout is two-phase. The gate is MANDATORY (it runs on every persist and
//   records usupp from day one) but starts in **warn** mode: an unexplained
//   unknown or a lift failure logs a loud warning and the atom is still admitted.
//   It tightens to **reject** only once the seed + shadow-npm corpora shave clean
//   under a recorded ♦-support baseline.
//
// @decision DEC-DUC-GATE-REJECT-001 (#1173)
// title: The gate rejects by default
// status: decided
// rationale:
//   The fixture corpus shaves clean: every free reference of every atom is explained
//   (composition, capture, module state, module scope, platform primitive, or a probe),
//   no atom fails to lift, and every lift is faithful (DEC-DUC-LIFT-FIDELITY-001). The
//   allowlist of unliftable constructs is empty. So the default is now **reject**: an
//   atom with an unexplained reference, a lift error or an unfaithful lift is not
//   persisted. `YAKCC_DUC_GATE=warn` remains the escape hatch; any other value rejects,
//   so a typo fails closed. Overridable per call.
//
// @decision DEC-DUC-MODULE-CAPTURE-001 (wi-duc-influence-layer #1171)
// title: A free identifier naming a pure module-scope constant is a recorded capture
// status: decided
// rationale:
//   An atom is a factored function, so it may read a binding that lives at module
//   scope in its source file (a lookup table, a constant). The atom's bytes do not
//   contain that binding, so the lifter reports it as a `free-identifier`. Its value
//   is fixed only if the binding is a `const` with a literal initializer and the
//   module never mutates it. Such a capture is explained: it is recorded with a hash
//   of its declaration, so a consumer can see exactly what the atom depends on. Like
//   composition edges, this is classification only. The atom's bytes and content
//   address are unchanged.
//
// @decision DEC-DUC-MODULE-SCOPE-001 (#1173)
// title: CommonJS module scope is the module's, recorded with the module's dependencies
// status: decided
// rationale:
//   Under D5 (#1275), `require`, `module` and `exports` are not primitives: they are the
//   module's own scope. When the gate knows the atom's module, `exports` and `module` are
//   explained by the module record (#1290), and `require` with literal specifiers is
//   explained, its specifiers recorded as the module's dependencies: a relative one is a
//   module of the package, a platform one is in the target's base set, and any other is a
//   dependency, like an ESM import (`unlinked-reference`). A `require` with a computed
//   specifier stays unexplained: what it loads is not in the graph.
//
// @decision DEC-DUC-MODULE-STATE-001 (#1266)
// title: A free identifier naming a mutable module binding is recorded module state
// status: decided
// rationale:
//   A mutable module binding (a table filled after its declaration, a counter, an alias
//   or hand-off of a shared object) is module state. The module record (#1290) holds the
//   statements that declare and change it, in the module's order, and a receiver runs
//   them before the atom: the state is part of what is checked, so it is explained. It
//   is recorded apart from pure captures (`moduleState`, with its declaration hash), so
//   the atoms that depend on module state stay visible to an audit.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type DiamondReason,
  type DucInfluenceAttestation,
  DucLiftError,
  type LiftFidelity,
  influenceAttestation,
  isWellFormed,
  liftAtom,
  liftFidelity,
  probedNames,
  requireSpecifiers,
} from "@yakcc/duc";
import {
  Node,
  Project,
  ScriptKind,
  type SourceFile,
  SyntaxKind,
  VariableDeclarationKind,
} from "ts-morph";
import { moduleBindingsOf } from "./module-bindings.js";

/** Gate enforcement mode. */
export type DucGateMode = "warn" | "reject";

/** One declared unknown (♦-source) in an atom's unknown-support. */
export interface DucUnknown {
  readonly symbol: string;
  readonly reason: DiamondReason;
  readonly module?: string;
  /**
   * True when this `free-identifier` resolves to a *sibling/child atom* defined
   * elsewhere in the same recursion forest — i.e. an internal **composition
   * edge**, not an external unknown. Set by the gate when the symbol is in the
   * forest's internal-symbol set (WI-EXPLAIN-01, DEC-DUC-COMPOSITION-EDGE-001).
   * It reclassifies the reference without touching the lifter's `reason` (which
   * stays `free-identifier` — the atom's own bytes genuinely have no local def).
   */
  readonly composition?: boolean;
  /**
   * True when this `free-identifier` names a pure module-scope constant the atom
   * captures (DEC-DUC-MODULE-CAPTURE-001). `declHash` is the hash of its declaration.
   */
  readonly capture?: boolean;
  /**
   * True when this `free-identifier` names a mutable module binding: module state
   * (DEC-DUC-MODULE-STATE-001, #1266). It is explained by the module record (#1290), which
   * holds the statements that declare and change it and runs them in order; it is recorded
   * apart from pure captures, so the atoms that read module state are visible.
   */
  readonly moduleState?: boolean;
  readonly declHash?: string;
  /**
   * True for CommonJS module scope (DEC-DUC-MODULE-SCOPE-001, #1173): `exports` and `module`
   * are the module's own objects, and `require` resolves through the module record (#1290),
   * the target's platform modules, or a dependency. Set only when the gate knows the atom's
   * module, and for `require` only when every specifier is a literal.
   */
  readonly moduleScope?: boolean;
  /** For `require`: the specifiers it is called with (the module's dependencies). */
  readonly requires?: readonly string[];
  /**
   * True for a name the atom only probes for (DEC-DUC-FEATURE-DETECTION-001, #1173): every read is
   * `typeof name`, or lies under a test that it is present, so the atom itself decides what to do
   * when the platform lacks it (a UMD wrapper's `define`).
   */
  readonly probe?: boolean;
}

import type { ModuleBindingInfo } from "./module-bindings.js";
export type { ModuleBinding, ModuleBindingInfo } from "./module-bindings.js";
export { moduleBindingsOf } from "./module-bindings.js";

/** The result of running the conservation gate over an atom's source. */
export interface DucGateResult {
  /** Whether the lifted graph is well-formed (true by construction unless lift failed). */
  readonly wellFormed: boolean;
  /** The full unknown-support, de-duplicated by symbol. */
  readonly unknowns: readonly DucUnknown[];
  /**
   * `free-identifier` unknowns that are NOT internal composition edges or captured
   * pure constants — the genuinely unexplained provenance the reject gate acts on.
   */
  readonly unexplained: readonly DucUnknown[];
  /**
   * `free-identifier` unknowns resolved to a sibling/child atom — internal
   * composition edges (recorded, never a gate problem).
   */
  readonly composition: readonly DucUnknown[];
  /** Module-scope pure constants the atom captures (recorded, never a gate problem). */
  readonly captures: readonly DucUnknown[];
  /** Mutable module bindings the atom reads: module state (recorded, never a gate problem). */
  readonly moduleState: readonly DucUnknown[];
  /** CommonJS module scope the atom uses: `exports`, `module`, `require` (recorded). */
  readonly moduleScope: readonly DucUnknown[];
  /** Present when the fragment could not be lifted (a syntax/analysis failure). */
  readonly liftError?: string;
  /**
   * Lift fidelity (DUC Norm 3, DEC-DUC-LIFT-FIDELITY-001): the graph references exactly the names
   * the source reads without declaring. A failure is a lifter defect, and a gate problem (#1173).
   */
  readonly fidelity?: LiftFidelity;
  /**
   * The `duc_influence` attestation of the lifted atom (DEC-DUC-ATTESTATION-SIDECAR-001).
   * Absent when the fragment could not be lifted.
   */
  readonly influence?: DucInfluenceAttestation;
}

/** Thrown in `reject` mode when an atom has an unexplained unknown or lift error. */
export class DucGateRejection extends Error {
  constructor(
    message: string,
    public readonly result: DucGateResult,
  ) {
    super(message);
    this.name = "DucGateRejection";
  }
}

/**
 * Resolve the gate mode from the environment (`YAKCC_DUC_GATE`): reject unless it is exactly
 * `warn` (DEC-DUC-GATE-REJECT-001).
 */
export function ducGateModeFromEnv(env: NodeJS.ProcessEnv = process.env): DucGateMode {
  return env.YAKCC_DUC_GATE === "warn" ? "warn" : "reject";
}

const NO_INTERNAL_SYMBOLS: ReadonlySet<string> = new Set();
const NO_MODULE_BINDINGS: ReadonlyMap<string, ModuleBindingInfo> = new Map();

/**
 * Lift an atom's source to a DUC graph and compute its unknown-support. Never
 * throws: a lift/analysis failure is recorded as `liftError` so the gate can
 * degrade gracefully in warn mode.
 *
 * `internalSymbols` are the names of sibling/child atoms in the same recursion
 * forest (see {@link collectInternalSymbols}). A `free-identifier` whose symbol
 * is in that set is an internal composition edge — recorded on `composition`
 * and excluded from `unexplained` — rather than a genuine external unknown.
 *
 * `moduleBindings` describes the enclosing module's top-level bindings (see
 * {@link moduleBindingsOf}). A `free-identifier` naming a `pure` binding is a
 * recorded capture (`captures`), excluded from `unexplained`. A `mutable` one stays
 * unexplained. Both mechanisms are metadata-only: the atom's bytes and content
 * address are untouched.
 */
export function runDucConservationGate(
  source: string,
  internalSymbols: ReadonlySet<string> = NO_INTERNAL_SYMBOLS,
  moduleBindings: ReadonlyMap<string, ModuleBindingInfo> = NO_MODULE_BINDINGS,
): DucGateResult {
  let unknowns: DucUnknown[];
  let wellFormed: boolean;
  let influence: DucInfluenceAttestation;
  let fidelity: LiftFidelity;
  try {
    const graph = liftAtom(source);
    wellFormed = isWellFormed(graph).wellFormed;
    fidelity = liftFidelity(source, graph);
    influence = influenceAttestation(graph);
    // Every ♦-source, not only those reaching an observation: an unresolved use is a
    // defect even when it does not reach the result (it can still have effects).
    const seen = new Map<string, DucUnknown>();
    // CommonJS module scope is the module's when the gate knows the atom's module (#1173).
    const inModule = moduleBindings !== NO_MODULE_BINDINGS;
    const specifiers = requireSpecifiers(graph);
    const probed = probedNames(source);
    for (const node of graph.nodes) {
      if (node.diamond === undefined) continue;
      const { symbol, reason, module } = node.diamond;
      if (seen.has(symbol)) continue;
      const isFree = reason === "free-identifier";
      const scope =
        isFree && inModule && !moduleBindings.has(symbol)
          ? symbol === "exports" || symbol === "module"
            ? {}
            : symbol === "require" && specifiers.every((x) => x !== null)
              ? { requires: [...new Set(specifiers as string[])] }
              : undefined
          : undefined;
      if (scope !== undefined) {
        seen.set(symbol, { symbol, reason, moduleScope: true, ...scope });
        continue;
      }
      if (isFree && probed.has(symbol)) {
        seen.set(symbol, { symbol, reason, probe: true });
        continue;
      }
      const isComposition = isFree && internalSymbols.has(symbol);
      const binding = isFree && !isComposition ? moduleBindings.get(symbol) : undefined;
      const isCapture = binding?.binding === "pure";
      const isModuleState = binding?.binding === "mutable";
      seen.set(symbol, {
        symbol,
        reason,
        ...(module !== undefined ? { module } : {}),
        ...(isComposition ? { composition: true } : {}),
        ...(isCapture ? { capture: true, declHash: binding.declHash } : {}),
        ...(isModuleState ? { moduleState: true, declHash: binding.declHash } : {}),
      });
    }
    unknowns = [...seen.values()];
  } catch (err) {
    const liftError = err instanceof DucLiftError ? err.message : String(err);
    return {
      wellFormed: false,
      unknowns: [],
      unexplained: [],
      composition: [],
      captures: [],
      moduleState: [],
      moduleScope: [],
      liftError,
    };
  }
  const isExplained = (u: DucUnknown): boolean =>
    u.composition === true ||
    u.capture === true ||
    u.moduleState === true ||
    u.moduleScope === true ||
    u.probe === true;
  const unexplained = unknowns.filter((u) => u.reason === "free-identifier" && !isExplained(u));
  const composition = unknowns.filter((u) => u.composition === true);
  const captures = unknowns.filter((u) => u.capture === true);
  const moduleState = unknowns.filter((u) => u.moduleState === true);
  const moduleScope = unknowns.filter((u) => u.moduleScope === true);
  return {
    wellFormed,
    unknowns,
    unexplained,
    composition,
    captures,
    moduleState,
    moduleScope,
    influence,
    fidelity,
  };
}

/** The outcome of enforcing the gate: what to persist plus the raw result. */
export interface EnforceDucGateResult {
  /**
   * JSON sidecar to store in `BlockTripletRow.ducUsupp`. Always present for a lifted
   * atom (it carries the `duc_influence` attestation even when closed); null only when
   * the fragment could not be lifted AND had no unknowns to record.
   */
  readonly ducUsupp: string | null;
  readonly result: DucGateResult;
}

/**
 * Run and enforce the conservation gate for one atom.
 *
 * - Always computes usupp; returns it serialized for the registry row.
 * - A *problem* is a lift failure or any unexplained (`free-identifier`) unknown.
 * - `reject` (default): a problem throws {@link DucGateRejection}, aborting the persist.
 * - `warn`: a problem logs a loud warning; the atom is still admitted.
 *
 * @throws {DucGateRejection} in `reject` mode when the atom has a problem.
 */
export function enforceDucGate(
  source: string,
  atomName: string,
  mode: DucGateMode,
  warn: (message: string) => void = (m) => console.warn(m),
  internalSymbols: ReadonlySet<string> = NO_INTERNAL_SYMBOLS,
  moduleBindings: ReadonlyMap<string, ModuleBindingInfo> = NO_MODULE_BINDINGS,
): EnforceDucGateResult {
  const result = runDucConservationGate(source, internalSymbols, moduleBindings);
  // The sidecar always records the usupp and, when the atom lifted, the
  // `duc_influence` attestation and the captured module constants with their
  // declaration hashes. It is not part of the block's content address.
  const ducUsupp = JSON.stringify({
    wellFormed: result.wellFormed,
    ...(result.liftError !== undefined ? { liftError: result.liftError } : {}),
    unknowns: result.unknowns,
    ...(result.captures.length > 0
      ? {
          captures: result.captures.map((c) => ({ symbol: c.symbol, declHash: c.declHash })),
        }
      : {}),
    ...(result.moduleState.length > 0
      ? {
          moduleState: result.moduleState.map((c) => ({ symbol: c.symbol, declHash: c.declHash })),
        }
      : {}),
    ...(result.influence !== undefined
      ? { attestations: { duc_influence: result.influence } }
      : {}),
  });

  const unfaithful = result.fidelity !== undefined && !result.fidelity.holds;
  const hasProblem = result.liftError !== undefined || result.unexplained.length > 0 || unfaithful;
  if (hasProblem) {
    const detail =
      result.liftError !== undefined
        ? `could not be lifted for analysis (${result.liftError})`
        : result.unexplained.length > 0
          ? `has unresolved references with no declared source: ${result.unexplained.map((u) => u.symbol).join(", ")} (a structural finding, not a feasibility claim)`
          : `was lifted unfaithfully: its graph ${[
              ...(result.fidelity?.missing.length
                ? [`drops ${result.fidelity.missing.join(", ")}`]
                : []),
              ...(result.fidelity?.extra.length
                ? [`reports ${result.fidelity.extra.join(", ")} as free`]
                : []),
            ].join(" and ")} (a lifter defect, DEC-DUC-LIFT-FIDELITY-001)`;
    const message = `[duc-gate] atom "${atomName}" ${detail}`;
    if (mode === "reject") {
      throw new DucGateRejection(`${message} — rejected (YAKCC_DUC_GATE=reject)`, result);
    }
    warn(`${message} — admitted (YAKCC_DUC_GATE=warn)`);
  }
  return { ducUsupp, result };
}

// ---------------------------------------------------------------------------
// Internal-symbol collection (composition-edge resolution)
// ---------------------------------------------------------------------------

// Top-level declaration names an atom fragment defines. Line-anchored so it only
// matches module-scope declarations, not nested ones — within one source module
// top-level names are unique by JS scoping, so cross-atom collisions cannot occur.
const TOP_LEVEL_DECL_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;

/**
 * The top-level binding names a single atom fragment declares (functions, consts,
 * classes). These are the identifiers a *sibling* atom would reference when it
 * calls into this one — i.e. the composition-edge targets this atom provides.
 */
export function atomDefinedNames(source: string): string[] {
  const names: string[] = [];
  for (const line of source.split("\n")) {
    const match = TOP_LEVEL_DECL_RE.exec(line);
    if (match?.[1] !== undefined) names.push(match[1]);
  }
  return names;
}

/**
 * The union of every atom-defined name across a recursion forest's atom sources —
 * the set of symbols a `free-identifier` reference may resolve to *internally*
 * (a sibling/child composition edge) rather than externally. Pass to
 * {@link runDucConservationGate} / {@link enforceDucGate}.
 */
export function collectInternalSymbols(sources: Iterable<string>): Set<string> {
  const symbols = new Set<string>();
  for (const source of sources) {
    for (const name of atomDefinedNames(source)) symbols.add(name);
  }
  return symbols;
}

// ---------------------------------------------------------------------------
// External surface (WI-EXPLAIN-03, GH #1172)
// ---------------------------------------------------------------------------

/**
 * An atom's declared external surface, derived from its `ducUsupp` sidecar without
 * re-lifting. `foreign` and `ambient` are the explained residual. `captures` are the
 * recorded module constants (with declaration hashes). `compositions` are sibling atoms.
 * `unexplained` is what the reject gate acts on.
 */
export interface ExternalSurface {
  readonly foreign: readonly { readonly symbol: string; readonly module?: string }[];
  readonly ambient: readonly string[];
  readonly captures: readonly { readonly symbol: string; readonly declHash?: string }[];
  /** Mutable module bindings read: module state, explained by the module record (#1266). */
  readonly moduleState: readonly { readonly symbol: string; readonly declHash?: string }[];
  /** CommonJS module scope used (`exports`, `module`, `require`). */
  readonly moduleScope: readonly string[];
  /** The specifiers `require` is called with: the module's dependencies. */
  readonly requires: readonly string[];
  readonly compositions: readonly string[];
  readonly unexplained: readonly string[];
}

/**
 * Parse the external surface out of a stored `ducUsupp` sidecar. Returns null when
 * there is no sidecar or it cannot be parsed. A sidecar with no unknowns yields an
 * empty surface, not null.
 */
export function externalSurfaceOf(ducUsupp: string | null | undefined): ExternalSurface | null {
  if (ducUsupp === null || ducUsupp === undefined) return null;
  let parsed: { unknowns?: DucUnknown[] };
  try {
    parsed = JSON.parse(ducUsupp) as { unknowns?: DucUnknown[] };
  } catch {
    return null;
  }
  const unknowns = Array.isArray(parsed.unknowns) ? parsed.unknowns : [];
  const foreign: { symbol: string; module?: string }[] = [];
  const ambient: string[] = [];
  const captures: { symbol: string; declHash?: string }[] = [];
  const moduleState: { symbol: string; declHash?: string }[] = [];
  const moduleScope: string[] = [];
  const requires: string[] = [];
  const compositions: string[] = [];
  const unexplained: string[] = [];
  for (const u of unknowns) {
    if (u.reason === "unlinked-reference") {
      foreign.push({ symbol: u.symbol, ...(u.module !== undefined ? { module: u.module } : {}) });
    } else if (u.reason === "platform-primitive") {
      ambient.push(u.symbol);
    } else if (u.composition === true) {
      compositions.push(u.symbol);
    } else if (u.capture === true) {
      captures.push({
        symbol: u.symbol,
        ...(u.declHash !== undefined ? { declHash: u.declHash } : {}),
      });
    } else if (u.moduleScope === true) {
      moduleScope.push(u.symbol);
      for (const r of u.requires ?? []) if (!requires.includes(r)) requires.push(r);
    } else if (u.moduleState === true) {
      moduleState.push({
        symbol: u.symbol,
        ...(u.declHash !== undefined ? { declHash: u.declHash } : {}),
      });
    } else if (u.reason === "free-identifier") {
      unexplained.push(u.symbol);
    }
  }
  return {
    foreign,
    ambient,
    captures,
    moduleState,
    moduleScope,
    requires,
    compositions,
    unexplained,
  };
}

// ---------------------------------------------------------------------------
// The gate's context for a shaved forest (#1173)
// ---------------------------------------------------------------------------

/** A forest's slice plans, as `collectForestSlicePlans` gives them. */
export interface ForestPlans {
  readonly filePath: string;
  readonly slicePlan: {
    readonly entries: readonly { readonly kind: string; readonly source?: unknown }[];
  };
}

/** What the gate is given for an atom: its forest's composition names and its module's bindings. */
export interface DucGateContext {
  readonly internalSymbols: ReadonlySet<string>;
  readonly moduleBindings: ReadonlyMap<string, ModuleBindingInfo>;
}

const forestContexts = new WeakMap<
  readonly ForestPlans[],
  { internal: Set<string>; bindings: Map<string, Map<string, ModuleBindingInfo>> }
>();

/**
 * The gate's context for the atoms of one module of a shaved forest, as `universalize` gives it to
 * a single module (DEC-DUC-GATE-REJECT-001): the names every novel-glue atom of the forest defines
 * (composition edges), and the module's own top-level bindings (captures, module state). A forest
 * persisted without it has every sibling reference unexplained, which the gate now rejects.
 */
export function forestGateContext(
  plans: readonly ForestPlans[],
  filePath: string,
  readSource: (file: string) => string = (file) => readFileSync(file, "utf8"),
): DucGateContext {
  let ctx = forestContexts.get(plans);
  if (ctx === undefined) {
    const sources = plans.flatMap(({ slicePlan }) =>
      slicePlan.entries.flatMap((e) =>
        e.kind === "novel-glue" && typeof e.source === "string" ? [e.source] : [],
      ),
    );
    ctx = { internal: collectInternalSymbols(sources), bindings: new Map() };
    forestContexts.set(plans, ctx);
  }
  let moduleBindings = ctx.bindings.get(filePath);
  if (moduleBindings === undefined) {
    moduleBindings = moduleBindingsOf(readSource(filePath));
    ctx.bindings.set(filePath, moduleBindings);
  }
  return { internalSymbols: ctx.internal, moduleBindings };
}
