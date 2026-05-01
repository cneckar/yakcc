// @decision DEC-ATOM-PERSIST-001
// title: specFromIntent maps IntentCard fields to SpecYak at L0
// status: decided
// rationale:
//   - Level is always "L0" per DEC-TRIPLET-L0-ONLY-019. Effect inference and
//     invariant derivation are future work items.
//   - Name is derived as a stable slug: first 30 chars of behavior (non-word
//     chars replaced with "-") + last 6 chars of canonicalAstHash. This is
//     deterministic across runs for identical inputs, which is required for
//     content-addressed provenance (the name is inside the SpecYak that is
//     canonicalized and hashed). A UUID would break content-addressing.
//   - The validator is called on the produced value to fail-fast if the mapping
//     produces an invalid spec.
//   - IntentCard.notes is not mapped to any SpecYak field (no correspondent).
//   - invariants and effects are empty arrays per the task design: atoms are
//     pure-by-default at this stage; invariant/effect inference is future work.

import { validateSpecYak } from "@yakcc/contracts";
import type { SpecYak, SpecYakParameter } from "@yakcc/contracts";
import type { IntentCard, IntentParam } from "../intent/types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map an IntentCard to a SpecYak.
 *
 * Mapping rules:
 *   - name: slug from behavior (first 30 chars, non-word → "-") + last 6 of canonicalAstHash
 *   - inputs: IntentParam[] → SpecYakParameter[] (name, type from typeHint, description)
 *   - outputs: same mapping
 *   - preconditions: from intentCard.preconditions
 *   - postconditions: from intentCard.postconditions
 *   - invariants: [] (pure-by-default at L0; future enrichment pass)
 *   - effects: [] (atoms pure-by-default; effect inference is future work)
 *   - level: "L0" (DEC-TRIPLET-L0-ONLY-019)
 *
 * Throws TypeError (from validateSpecYak) if the produced spec is invalid.
 *
 * @param intentCard      - The extracted intent card for this atom.
 * @param canonicalAstHash - The canonical AST hash of the atom source; used to
 *                          disambiguate the name slug when two behaviors share
 *                          the same first-30-char prefix.
 */
export function specFromIntent(intentCard: IntentCard, canonicalAstHash: string): SpecYak {
  const name = deriveSpecName(intentCard.behavior, canonicalAstHash);

  const inputs: SpecYakParameter[] = intentCard.inputs.map(mapParam);
  const outputs: SpecYakParameter[] = intentCard.outputs.map(mapParam);

  const spec = {
    name,
    inputs,
    outputs,
    preconditions: Array.from(intentCard.preconditions),
    postconditions: Array.from(intentCard.postconditions),
    invariants: [] as string[],
    effects: [] as string[],
    level: "L0" as const,
  };

  // Fail-fast: call the validator so callers get a typed error on schema
  // violations rather than discovering invalid specs at registry store time.
  return validateSpecYak(spec);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map an IntentParam to a SpecYakParameter.
 *
 * IntentParam.typeHint → SpecYakParameter.type (the field names differ).
 * description is forwarded verbatim.
 */
function mapParam(param: IntentParam): SpecYakParameter {
  return {
    name: param.name,
    type: param.typeHint,
    description: param.description,
  };
}

/**
 * Derive a stable, human-readable name slug for a SpecYak from a behavior
 * description and a canonical AST hash.
 *
 * Format: <slug>-<hash6>
 *   slug: first 30 characters of behavior with non-word characters replaced by
 *         "-" and leading/trailing "-" stripped.
 *   hash6: last 6 hex characters of canonicalAstHash.
 *
 * The hash suffix ensures uniqueness when two behaviors share the same first-30
 * character prefix. Because it is derived from the canonical AST hash (which is
 * itself a content address), the name is deterministic for identical inputs.
 *
 * Examples:
 *   "Parse a comma-separated list of integers" + "abc123def456..." →
 *   "parse-a-comma-separated-list-of-abc123"
 */
function deriveSpecName(behavior: string, canonicalAstHash: string): string {
  const prefix = behavior
    .slice(0, 30)
    .replace(/\W+/g, "-")
    .replace(/^-+|-+$/g, "");

  const hashSuffix = canonicalAstHash.slice(-6);

  return `${prefix}-${hashSuffix}`;
}
