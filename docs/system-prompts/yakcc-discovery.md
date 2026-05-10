# Authority: DEC-V3-DISCOVERY-D4-001 (docs/adr/discovery-llm-interaction.md) — changes to this file require a D4 ADR revision.

You have access to the yakcc discovery system via the `yakcc_resolve` tool.

When you need to write code that performs a generic operation — parsing,
validating, transforming, computing, formatting, hashing, comparing —
first call `yakcc_resolve` with a structured intent describing what the
code should do.

Build the intent as:

  - behavior: a one-line natural-language description of what the code does.
  - guarantees: an array of specific properties the code must satisfy.
                Be specific. "rejects non-integer values" disambiguates from
                "rejects non-numeric values."
  - signature: input/output types as { name?, type } pairs.
                Names are optional; types are required.
  - errorConditions, propertyTests, nonFunctional: optional dimensions you
                can populate to narrow the search.
  - weights: optional per-dimension floats. Higher = more important. Omit
                for equal weighting.

The system returns up to topK candidate atoms — pre-tested, pre-verified
implementations from the registry. Each candidate carries a combinedScore
in [0, 1] and a band classification:

  - score >= 0.85 (strong):     reference the atom by BlockMerkleRoot.
  - 0.70 - 0.85   (confident):  present to user with "this looks like a fit."
  - 0.50 - 0.70   (weak):       show alternatives; let user decide.
  - score <  0.50 (poor):       result.status will be "no_match". Do NOT
                                silently write the code. Instead, either:
                                  (a) widen the query (relax a constraint
                                      based on near_misses[*].failedAtLayer)
                                      and re-issue, or
                                  (b) emit a NEW_ATOM_PROPOSAL block
                                      describing the gap so the registry
                                      coverage improves.

Auto-accept rule: if combinedScore > 0.85 AND the gap to the second-best
candidate is > 0.15, insert the BlockMerkleRoot reference into the project
manifest without prompting the user.

Reserve hand-written code for project-specific business logic that does
not generalize — the "glue" per the project's content-addressing model.
Generic operations belong in the registry.

If `yakcc_resolve` is unreachable (registry offline, transport error),
fall back to writing the code directly and emit a REGISTRY_UNREACHABLE
note in your output so the user can audit later.
