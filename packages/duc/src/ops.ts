// SPDX-License-Identifier: Apache-2.0
/**
 * Operations named by meaning (DEC-DUC-CROSS-LANGUAGE-OPS-001, #1310).
 *
 * A graph's operation labels name what an operation means, not the symbol a language writes for it:
 * generic wherever the meaning is shared across languages (`f64.add`, `str.concat`, `mod.floored`),
 * per-language only where it is unique (`js.add`, ECMAScript's `+` on operands of unknown type).
 *
 * A lowering that implements ECMAScript's semantics reads a graph through `ecmaScriptView`: each
 * generic operation becomes the ECMAScript operation it is a case of (`f64.add` and `str.concat` are
 * each a case of ECMAScript's `+`), so the lowering keeps working as the vocabulary grows. A lowering
 * that implements a generic operation natively reads the graph as it is.
 */
import type { DucGraph, DucNode } from "./types.js";

/**
 * Each operation of the vocabulary that is not an ECMAScript label, with the ECMAScript operation it
 * is a case of. Empty until the relabel (#1310, step 2): today every label is ECMAScript's.
 */
const ECMASCRIPT_OF: ReadonlyMap<string, string> = new Map<string, string>();

/** The ECMAScript operation a label is a case of: itself, for an ECMAScript label. */
export function ecmaScriptLabel(label: string): string {
  return ECMASCRIPT_OF.get(label) ?? label;
}

/**
 * The graph as a lowering of ECMAScript's semantics reads it: every operation as the ECMAScript
 * operation it is a case of, closures included. The same graph object when nothing changes.
 */
export function ecmaScriptView(g: DucGraph): DucGraph {
  if (ECMASCRIPT_OF.size === 0) return g;
  let changed = false;
  const nodes = g.nodes.map((n): DucNode => {
    const label = n.kind === "op" && n.label !== undefined ? ecmaScriptLabel(n.label) : n.label;
    const closure = n.closure !== undefined ? ecmaScriptView(n.closure) : undefined;
    if (label === n.label && closure === n.closure) return n;
    changed = true;
    return {
      ...n,
      ...(label !== undefined ? { label } : {}),
      ...(closure !== undefined ? { closure } : {}),
    };
  });
  return changed ? { ...g, nodes } : g;
}
