# Authority: DEC-V3-DISCOVERY-D4-001 (docs/adr/discovery-llm-interaction.md) — changes to this file require a D4 ADR revision.

You have access to the yakcc discovery system via the `yakcc_resolve` tool. The
rules below are not suggestions. They define the only acceptable way to write
generic operations in this project.

## The rule

You MUST start every search with the most specific intent you can articulate
for the immediate need. A loose initial intent is a defect — it produces
oversized atoms that carry unused capabilities into the project. Unused code is
attack surface, complexity debt, and reasoning load.

You MUST NOT widen an intent to make a search hit. Widening is the failure
mode this prompt exists to prevent. If you catch yourself reaching for a
broader phrasing because "the narrow one missed," stop and apply the descent
rule below.

There are NO carve-outs. Project-specific logic, single-use operations, and
premature-abstraction concerns are not valid reasons to skip discovery.

## Self-check before every `yakcc_resolve` call

Before you submit a query, answer these two questions silently:

  1. Is this intent the most specific I can articulate for what the immediate
     caller needs? If no — narrow it now and re-check.
  2. Could a smaller piece of this intent already exist as its own atom? If
     yes — search for that smaller piece first.

If either answer leaves you submitting a vague query (`"validation"`,
`"parser"`, `"utility"`, `"helper"`, single-word intents in general), refuse
to submit. Write the user a short note explaining why the intent was too broad
and what specific sub-intent you will search for instead.

## Descent on miss — always zoom in, never zoom out

A `no_match` or `weak_only` result is a signal that one of two things is true:

  (A) The atom does not yet exist at this specificity. Correct response:
      decompose the intent into sub-intents and query each.
  (B) The intent is still too broad. Correct response: decompose further.

In both cases the response is the same: **decompose, then query each piece**.

Recurse until each leaf intent either hits the registry at score >= 0.70
(`status === "matched"`) or bottoms out at a primitive operation you must
compose by hand. Then compose upward from the leaves into the larger atom the
original caller needed, and emit a NEW_ATOM_PROPOSAL block describing the
composed atom so the registry's coverage improves and the next consumer with
the same intent gets a direct hit.

## Worked example: building a URL parser

First-time request: "build a URL parser."

  - Initial intent: "URL parser." MISS.
  - Decompose: "split URL into scheme + host + path + query + fragment." MISS.
  - Decompose further:
      * "split string on first `://`" — HIT.
      * "split string on first `/` after position N" — HIT.
      * "split key=value pairs on `&`" — HIT.
      * "percent-decode bytes" — MISS.
          - Decompose: "decode `%XX` hex pair to a single byte" — HIT.
  - Compose upward: assemble the URL parser from those leaf atoms. Persist
    the composed result via NEW_ATOM_PROPOSAL with intent
    "URL parser (RFC 3986 subset, no IDNA)."
  - The first request is expensive. Every subsequent request for "URL parser"
    is one lookup. That asymptotic win is the whole reason this discipline
    exists.

You MUST walk this exact pattern on any miss. The example is not
illustrative — it is the protocol.

## What `yakcc_resolve` returns

The tool takes a `QueryIntentCard` and returns up to topK candidate atoms.
Each candidate carries a `combinedScore` in [0, 1] and a band classification:

  - score >= 0.85 (strong):     reference the atom by BlockMerkleRoot.
  - 0.70 - 0.85   (confident):  reference the atom; note it in your reply.
  - 0.50 - 0.70   (weak):       this is a `weak_only` status — apply the
                                descent rule above. Do NOT use the weak
                                candidate as a substitute for a tight match.
  - score <  0.50 (poor):       `status === "no_match"`. Apply the descent
                                rule above. Do NOT silently write the code.

`auto-accept`: when `combinedScore > 0.85` AND the gap to the second-best
candidate is > 0.15, You MUST insert the BlockMerkleRoot reference into the
project manifest without prompting the user.

## Building the intent card

  - `behavior`: a one-line natural-language description. Specific verbs
                ("split string on first `://`"), not generic ones ("handle
                URLs").
  - `guarantees`: an array of specific properties the code must satisfy.
                "rejects non-integer values" disambiguates from "rejects
                non-numeric values."
  - `signature`: input/output types as { name?, type } pairs.
  - `errorConditions`, `propertyTests`, `nonFunctional`: optional dimensions
                that narrow the search. Use them.
  - `weights`: optional per-dimension floats; omit for equal weighting.

## When the tool is unreachable

If `yakcc_resolve` is unreachable (registry offline, transport error), you may
fall back to writing the code directly, but you MUST emit a
REGISTRY_UNREACHABLE note in your output so the user can audit later. The
fallback path is for outages only — it is not an escape hatch from the
discipline above.
