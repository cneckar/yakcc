// SPDX-License-Identifier: MIT
// @decision DEC-DUC-AUTHORED-001 (#1288): a graph a model writes, for an atom the corpus does not
// have, is a submission like any other. checkAuthoredGraph parses its line form, puts it through
// the receiver's checks (DEC-DUC-TRUST-MODEL-001, with the contract's vectors as its evidence),
// and checks the round trip (P2): its TypeScript lowering lifts back to the same identity. What
// fails comes back as findings a model can act on: the check, the reason, and the line when the
// failure is in one. composeMissing is the loop: search first, then ask the model, check its reply,
// give it the findings, and stop after a fixed number of attempts. The search and the model are
// injected; nothing here calls a model service.

import { type SpecYak, specHash } from "@yakcc/contracts";
import {
  type DucGraph,
  LineFormError,
  emitTypeScript,
  graphIdentity,
  liftAtom,
  packGraph,
  parseLineForm,
} from "@yakcc/duc";
import {
  type CheckName,
  type ConformanceVector,
  type ReceiverOptions,
  type ReceiverStore,
  type TrustLevel,
  checkSharedSubmission,
} from "./duc-submission.js";

export interface AuthoredFinding {
  /** Where it failed: parsing, one of the receiver's checks, or the round trip. */
  readonly check: "parse" | CheckName | "round-trip";
  readonly reason: string;
  /** The line of the line form, when the failure is in one. */
  readonly line?: number;
}

export interface AuthoredResult {
  /** True when nothing failed and, given vectors, the graph computes all of them. */
  readonly ok: boolean;
  readonly findings: readonly AuthoredFinding[];
  readonly identity?: string;
  readonly level?: TrustLevel;
  /** Why the vectors could not be run, when they could not. */
  readonly unchecked?: string;
}

const EMPTY_STORE: ReceiverStore = { contracts: new Set(), implementationsOf: () => [] };

/** A model-written graph checked against its contract (DEC-DUC-AUTHORED-001). */
export async function checkAuthoredGraph(
  lineForm: string,
  contract: SpecYak,
  vectors: readonly ConformanceVector[],
  store: ReceiverStore = EMPTY_STORE,
  options: ReceiverOptions & { readonly baseSet?: { target: string; version: number } } = {},
): Promise<AuthoredResult> {
  let graph: DucGraph;
  try {
    graph = parseLineForm(lineForm.endsWith("\n") ? lineForm : `${lineForm}\n`);
  } catch (e) {
    if (e instanceof LineFormError)
      return { ok: false, findings: [{ check: "parse", reason: e.message, line: e.line }] };
    return { ok: false, findings: [{ check: "parse", reason: String(e) }] };
  }
  const packed = packGraph(graph);
  const verdict = await checkSharedSubmission(
    [
      {
        spec: contract,
        specHash: specHash(contract),
        formatVersion: packed.formatVersion,
        structure: packed.structure,
        identity: packed.identity,
        links: packed.links,
        evidence: vectors,
        baseSet: options.baseSet ?? { target: "ecmascript", version: 1 },
      },
    ],
    store,
    options,
  );
  const v = verdict.implementations[0];
  const findings: AuthoredFinding[] = [];
  if (v?.refused !== undefined) findings.push({ check: v.refused.check, reason: v.refused.reason });
  // P2: the graph's TypeScript lowering lifts back to the same graph.
  if (v?.refused === undefined) {
    try {
      const back = graphIdentity(liftAtom(emitTypeScript(graph)));
      if (back !== packed.identity)
        findings.push({
          check: "round-trip",
          reason: "the TypeScript lowering lifts back to a different graph",
        });
    } catch (e) {
      findings.push({
        check: "round-trip",
        reason: `the graph has no TypeScript lowering: ${(e as Error).message}`,
      });
    }
  }
  const level = v?.level;
  const computes = vectors.length === 0 || level === "conforming" || level === "corroborated";
  return {
    ok: findings.length === 0 && computes,
    findings,
    identity: packed.identity,
    ...(level !== undefined ? { level } : {}),
    ...(v?.unchecked !== undefined ? { unchecked: v.unchecked } : {}),
  };
}

/** An atom the composition needs: its contract, and the vectors it must compute. */
export interface NeededAtom {
  readonly contract: SpecYak;
  readonly vectors: readonly ConformanceVector[];
}

/** What the model is given: the contract, and on a retry its previous reply and the findings. */
export interface AuthoringRequest {
  readonly contract: SpecYak;
  readonly previous?: string;
  readonly findings?: readonly AuthoredFinding[];
}

export interface AuthoringModel {
  /** A line-form program for the contract. */
  author(request: AuthoringRequest): Promise<string>;
}

export interface ComposeOutcome {
  readonly contract: SpecYak;
  /** "found": the search had it; "authored": the model wrote one that passed; "failed": neither. */
  readonly outcome: "found" | "authored" | "failed";
  readonly lineForm?: string;
  readonly identity?: string;
  /** The model's attempts (0 when found). */
  readonly attempts: number;
  /** The last attempt's findings, when it failed. */
  readonly findings: readonly AuthoredFinding[];
}

export interface ComposeDependencies {
  /** The corpus's graph for a contract, when it has one (#1280's search, or a registry lookup). */
  search(
    contract: SpecYak,
  ): Promise<{ readonly identity: string; readonly lineForm: string } | undefined>;
  readonly model: AuthoringModel;
  readonly store?: ReceiverStore;
}

/**
 * The composition loop (#1288): for each needed atom, the search first; for a miss, the model
 * writes a graph, which is checked, and its findings go back to it, at most `maxAttempts` times.
 */
export async function composeMissing(
  needs: readonly NeededAtom[],
  deps: ComposeDependencies,
  options: { readonly maxAttempts?: number } = {},
): Promise<ComposeOutcome[]> {
  const maxAttempts = options.maxAttempts ?? 3;
  const outcomes: ComposeOutcome[] = [];
  for (const need of needs) {
    const hit = await deps.search(need.contract);
    if (hit !== undefined) {
      outcomes.push({
        contract: need.contract,
        outcome: "found",
        lineForm: hit.lineForm,
        identity: hit.identity,
        attempts: 0,
        findings: [],
      });
      continue;
    }
    let previous: string | undefined;
    let findings: readonly AuthoredFinding[] = [];
    let done: ComposeOutcome | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const reply = await deps.model.author({
        contract: need.contract,
        ...(previous !== undefined ? { previous, findings } : {}),
      });
      const result = await checkAuthoredGraph(reply, need.contract, need.vectors, deps.store);
      if (result.ok) {
        done = {
          contract: need.contract,
          outcome: "authored",
          lineForm: reply,
          ...(result.identity !== undefined ? { identity: result.identity } : {}),
          attempts: attempt,
          findings: [],
        };
        break;
      }
      previous = reply;
      findings =
        result.findings.length > 0
          ? result.findings
          : [{ check: "conformance", reason: result.unchecked ?? "the vectors were not computed" }];
    }
    outcomes.push(
      done ?? { contract: need.contract, outcome: "failed", attempts: maxAttempts, findings },
    );
  }
  return outcomes;
}
