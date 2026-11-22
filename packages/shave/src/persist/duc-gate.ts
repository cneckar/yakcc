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
//   under a recorded ♦-support baseline; the flip's default is a follow-up DEC.
//   Mode is `YAKCC_DUC_GATE=warn|reject` (default warn), overridable per call.
//
//   Non-breaking by design: any failure to lift/analyze a fragment degrades to a
//   recorded lift error (warn) rather than throwing — the gate must never break
//   the existing shave pipeline in its default mode.
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
//   of its declaration, so a consumer can see exactly what the atom depends on. A
//   mutable module binding stays unexplained. Like composition edges, this is
//   classification only. The atom's bytes and content address are unchanged.

import { createHash } from "node:crypto";
import {
  type DiamondReason,
  type DucInfluenceAttestation,
  DucLiftError,
  influenceAttestation,
  isWellFormed,
  liftAtom,
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
  readonly declHash?: string;
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
  /** Present when the fragment could not be lifted (a syntax/analysis failure). */
  readonly liftError?: string;
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

/** Resolve the gate mode from the environment (`YAKCC_DUC_GATE`), defaulting to warn. */
export function ducGateModeFromEnv(env: NodeJS.ProcessEnv = process.env): DucGateMode {
  return env.YAKCC_DUC_GATE === "reject" ? "reject" : "warn";
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
  try {
    const graph = liftAtom(source);
    wellFormed = isWellFormed(graph).wellFormed;
    influence = influenceAttestation(graph);
    // Every ♦-source, not only those reaching an observation: an unresolved use is a
    // defect even when it does not reach the result (it can still have effects).
    const seen = new Map<string, DucUnknown>();
    for (const node of graph.nodes) {
      if (node.diamond === undefined) continue;
      const { symbol, reason, module } = node.diamond;
      if (seen.has(symbol)) continue;
      const isFree = reason === "free-identifier";
      const isComposition = isFree && internalSymbols.has(symbol);
      const binding = isFree && !isComposition ? moduleBindings.get(symbol) : undefined;
      const isCapture = binding?.binding === "pure";
      seen.set(symbol, {
        symbol,
        reason,
        ...(module !== undefined ? { module } : {}),
        ...(isComposition ? { composition: true } : {}),
        ...(isCapture ? { capture: true, declHash: binding.declHash } : {}),
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
      liftError,
    };
  }
  const isExplained = (u: DucUnknown): boolean => u.composition === true || u.capture === true;
  const unexplained = unknowns.filter((u) => u.reason === "free-identifier" && !isExplained(u));
  const composition = unknowns.filter((u) => u.composition === true);
  const captures = unknowns.filter((u) => u.capture === true);
  return { wellFormed, unknowns, unexplained, composition, captures, influence };
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
 * - `warn` (default): a problem logs a loud warning; the atom is still admitted.
 * - `reject`: a problem throws {@link DucGateRejection}, aborting the persist.
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
    ...(result.influence !== undefined
      ? { attestations: { duc_influence: result.influence } }
      : {}),
  });

  const hasProblem = result.liftError !== undefined || result.unexplained.length > 0;
  if (hasProblem) {
    const detail =
      result.liftError !== undefined
        ? `could not be lifted for analysis (${result.liftError})`
        : `has unresolved references with no declared source: ${result.unexplained.map((u) => u.symbol).join(", ")} (a structural finding, not a feasibility claim)`;
    const message = `[duc-gate] atom "${atomName}" ${detail}`;
    if (mode === "reject") {
      throw new DucGateRejection(`${message} — rejected (YAKCC_DUC_GATE=reject)`, result);
    }
    warn(`${message} — admitted (warn mode; set YAKCC_DUC_GATE=reject to enforce)`);
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
  const compositions: string[] = [];
  const unexplained: string[] = [];
  for (const u of unknowns) {
    if (u.reason === "foreign-import") {
      foreign.push({ symbol: u.symbol, ...(u.module !== undefined ? { module: u.module } : {}) });
    } else if (u.reason === "ambient-read") {
      ambient.push(u.symbol);
    } else if (u.composition === true) {
      compositions.push(u.symbol);
    } else if (u.capture === true) {
      captures.push({
        symbol: u.symbol,
        ...(u.declHash !== undefined ? { declHash: u.declHash } : {}),
      });
    } else if (u.reason === "free-identifier") {
      unexplained.push(u.symbol);
    }
  }
  return { foreign, ambient, captures, compositions, unexplained };
}
