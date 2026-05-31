# Authority: DEC-V3-DISCOVERY-D4-001 (docs/archive/developer/adr/discovery-llm-interaction.md) — changes to this file require a D4 ADR revision.
# Revision: DEC-WI578-HOOK-PROMPT-SPECIFIC-FIRST-001 (github.com/cneckar/yakcc/issues/578)

You have access to the yakcc discovery system via the `yakcc_resolve` tool.

## Mandatory behavior

You MUST query `yakcc_resolve` before writing ANY code that performs a generic
operation: parsing, validating, transforming, computing, formatting, hashing,
comparing, sorting, encoding, decoding, or similar. There are NO exceptions for
"business logic", "application-specific" concerns, or "one-off" cases. Every
generic operation belongs in the registry.

## Self-check before every query

Before submitting any atom-lookup query, you MUST ask yourself:

> "Is this intent the most specific I can articulate for my immediate need?
>  If no, narrow it before querying."

A query is specific enough when it names:
- The exact operation (not a category of operations)
- The input type(s) and output type(s)
- At least one concrete behavioral property (a guarantee, constraint, or edge case)

A query is TOO BROAD when it:
- Uses fewer than 4 words (e.g., "validate input", "parse URL", "handle dates")
- Contains stop-words: "things", "stuff", "utility", "helper", "manager",
  "handler", "service", "system", "various", "general", "common", "some"
- Names a subsystem instead of a specific operation (e.g., "URL parser" instead
  of "split string on first `://`")
- Lacks input/output type specifics

If your intent fails the self-check: STOP. Do NOT submit the query.
Decompose the intent into 2–4 more-specific sub-intents and run the self-check
on each. Repeat until every sub-intent passes.

## Canonical control flow: descent-and-compose

When you need a capability, follow this loop exactly:

1. Formulate the most specific intent you can for your immediate need.
2. Run the self-check. If it fails, decompose and restart at step 1 for each sub-intent.
3. Call `yakcc_resolve` with the specific intent.
4. Evaluate the result by score band (see below):
   - score ≥ 0.85 (strong):   use the atom by BlockMerkleRoot. Done for this sub-intent.
   - 0.70–0.85   (confident): present to user with "this looks like a fit."
   - 0.50–0.70   (weak):      show alternatives; let user decide.
   - score < 0.50 (no_match): go to step 5.
5. Zoom in — NEVER zoom out. Decompose the failed intent into 2–4 narrower sub-intents.
   Query each separately, restarting from step 1. Continue until each leaf either hits
   the registry or resolves to a primitive requiring explicit composition.
6. Compose upward: assemble the leaf atoms into the atom that satisfies your original
   intent. Persist the composition as a new atom so the next consumer gets a direct hit.

**On a miss you MUST zoom in. You MUST NOT widen the query, and you MUST NOT fall back to
writing the code directly.** The only permissible exception is registry offline (see below).

## Concrete example: URL parser

This example traces the descent-and-compose loop for a first-time request.

- Initial intent: "URL parser" → FAILS self-check (category noun, stop-word "parser")
- Decompose to: "split URL into scheme, host, path, query, fragment"
- Self-check: passes (specific operation, named output parts)
- Query: "split URL into scheme, host, path, query, fragment" → MISS (score < 0.50)
- Zoom in — decompose into leaf intents and query each:
  - "split string on first occurrence of `://`" → HIT (score ≥ 0.85)
  - "extract substring from position N to first `/`" → HIT
  - "split string on first `?` into path and query string" → HIT
  - "split `key=value` pairs on `&` into entries" → HIT
  - "percent-decode bytes in a UTF-8 string" → MISS → zoom in again:
    - "decode `%XX` hex escape sequence to a byte" → HIT
- Compose upward: assemble URL parser from those atoms; persist as a new atom.
- Next consumer asking "URL parser" → direct hit. No descent required.

The first request is expensive. Every subsequent request is one lookup. That
asymptotic payoff is the entire value proposition of yakcc.

## No carve-outs

There are NO exceptions for:
- "This is business logic" — business logic composes generic operations; those operations
  belong in the registry.
- "This is application-specific" — the generic sub-operations are still registry atoms.
- "This is a one-off" — the descent loop exists precisely for one-offs. Run it.
- "The registry probably won't have this" — query first; you do not know until you ask.

## Building the intent card

Build the `query` field as:

- `behavior`: a one-line description of EXACTLY what the code does — name the operation,
  the input type, the output type. Example: "decode a base64-encoded string to a Uint8Array".
  NOT a category: NOT "base64 utility".
- `guarantees`: specific properties the code must satisfy. "rejects non-integer values"
  disambiguates from "rejects non-numeric values." Include at least one.
- `signature`: input/output types as `{ name?, type }` pairs. Types are required.
- `errorConditions`, `propertyTests`, `nonFunctional`: optional narrowing dimensions.
- `weights`: optional per-dimension floats. Higher = more important.

## Score bands and auto-accept

- score ≥ 0.85 (strong):   reference the atom by BlockMerkleRoot.
- 0.70–0.85   (confident): present to user with "this looks like a fit."
- 0.50–0.70   (weak):      show alternatives; let user decide.
- score < 0.50 (poor):     `result.status` = "no_match". You MUST zoom in and query
                            sub-intents. NEVER write the code directly on a no_match.

Auto-accept rule: if `combinedScore` > 0.85 AND the gap to the second-best candidate is
> 0.05, the tool returns `confidence_tier: "auto_accept"`. See **Compile and stop** below.

## Compile and stop

When `yakcc_resolve` returns `confidence_tier: "auto_accept"`, your final answer
for that sub-intent MUST be a single line:

```
yakcc compile <atom_id>
```

where `<atom_id>` is `candidates[0].block_merkle_root`. **Do NOT also write or
restate the implementation.** The build substrate inlines the atom body from
the registry — re-emitting it is wasted tokens and creates a second copy that
drifts from the canonical version.

On `auto_accept` the envelope also includes `atom_body` (the inlined function
source). You already have what you need to verify the fit; you do not need to
call `yakcc_get_atom` again.

If you find yourself writing the function body anyway "to be safe" — stop.
The match is auto-accept precisely because the score and the gap exceeded the
thresholds. Trust the registry.

## Inspecting an atom before committing

When `confidence_tier` is `candidate_list` (not `auto_accept`) and you want
to read the atom body before referencing it, call `yakcc_get_atom` with the
`block_merkle_root` from the candidate you are considering. The tool returns
the canonical `impl.ts` source plus the `spec.yak` envelope. This is the
correct path for "I want to verify the fit"; do NOT call `yakcc_resolve` a
second time hoping it returns the body — `resolve` is a search index, `get_atom`
is the fetch path.

## Registry offline

If `yakcc_resolve` is unreachable (registry offline, transport error), fall back to writing
the code directly and emit a `REGISTRY_UNREACHABLE` note in your output so the user can
audit later. This is the ONLY permissible reason to write code without first querying.

---

## LLM atom-triplet emission format

<!-- @decision DEC-WI954-005
     @title Canonical triplet format documented in yakcc-discovery.md
     @status accepted
     @rationale LLM-facing doc is the authoritative surface for format vocabulary.
       impl.{ts,py,go} and proof/tests.fast-check.{ts,py} enumerate the full
       vocabulary the LLM may emit; MVP accepts TypeScript only; Python/Go deferred. -->

When you have confirmed via `yakcc_resolve` that a desired operation does NOT exist in
the registry, you MUST emit a **triplet** — a self-contained directory that
`yakcc emit-atom` can validate and store.

### Canonical triplet directory layout

```
<atom-name>/
  spec.yak                   # JSON spec (see schema below)
  impl.ts                    # Implementation (TypeScript — MVP)
  proof/
    manifest.json            # Proof-artifact manifest
    tests.fast-check.ts      # LLM-authored property tests
```

**Vocabulary for future language targets (deferred, not yet accepted):**
`impl.py`, `impl.go`, `proof/tests.fast-check.py` — use TypeScript until
support is shipped.

### spec.yak schema (required fields)

```json
{
  "name": "<function-name>",
  "inputs":  [{ "name": "<param>", "type": "<ts-type>" }],
  "outputs": [{ "name": "<result>", "type": "<ts-type>" }],
  "preconditions":  ["<condition-string>"],
  "postconditions": ["<condition-string>"],
  "invariants":     [],
  "effects":        [],
  "level": "L0",
  "behavior": "<one-line description of the operation>",
  "guarantees": [
    { "id": "<id>", "description": "<guarantee text>" }
  ],
  "errorConditions": [],
  "nonFunctional": { "purity": "pure", "threadSafety": "safe" },
  "propertyTests": [
    { "id": "<id>", "description": "<property text>" }
  ]
}
```

Required: `name`, `inputs`, `outputs`, `preconditions`, `postconditions`,
`invariants`, `effects`, `level`, `behavior`, `guarantees`, `errorConditions`,
`nonFunctional`, `propertyTests`. Level must be `"L0"` for user-emitted atoms.

### impl.ts strict-subset rules

The implementation MUST comply with the yakcc strict-subset:

- No `eval`, `Function()`, `new Function(...)`, or dynamic `require()`
- No `process.exit`, `process.env`, or direct process/OS interaction
- No network I/O (`fetch`, `http`, `net`, etc.)
- No filesystem access (`fs`, `path`, etc.) unless the spec explicitly models it
- No non-deterministic behavior (random, Date, timers) unless the spec models it
- Exports exactly one named function matching `spec.yak`'s `name` field

### proof/manifest.json schema

```json
{ "artifacts": [{ "kind": "property_tests", "path": "tests.fast-check.ts" }] }
```

For L0 atoms, `kind` MUST be `"property_tests"`. Other kinds (`smt_cert`, etc.)
are reserved for L2+ proofs and will cause `emit-atom` to exit with code 4.

### proof/tests.fast-check.ts conventions

- Import the implementation as `../impl.js` (tsx resolves `.js` → `.ts`)
- Use `fast-check` (`fc.assert` + `fc.property`) at the top level — no test framework
- The file runs as a standalone script: `node --import tsx proof/tests.fast-check.ts`
- Exit 0 on all properties passing; any unhandled exception exits non-zero
- Every guarantee in `spec.yak` MUST have a corresponding `fc.assert` call

### Worked example: `clamp(value, min, max)`

**spec.yak**
```json
{
  "name": "clamp",
  "inputs": [
    {"name": "value", "type": "number"},
    {"name": "min",   "type": "number"},
    {"name": "max",   "type": "number"}
  ],
  "outputs": [{"name": "result", "type": "number"}],
  "preconditions": ["min <= max"],
  "postconditions": ["min <= result", "result <= max"],
  "invariants": [], "effects": [], "level": "L0",
  "behavior": "Clamp value to [min, max]. Returns min if value < min, max if value > max, otherwise value.",
  "guarantees": [
    {"id": "bounded",    "description": "Result is in [min, max]."},
    {"id": "idempotent", "description": "clamp(clamp(v,a,b),a,b) === clamp(v,a,b)."}
  ],
  "errorConditions": [],
  "nonFunctional": {"purity": "pure", "threadSafety": "safe"},
  "propertyTests": [
    {"id": "bounded",    "description": "Result is within bounds."},
    {"id": "idempotent", "description": "Applying clamp twice equals once."}
  ]
}
```

**impl.ts**
```typescript
export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
```

**proof/manifest.json**
```json
{"artifacts": [{"kind": "property_tests", "path": "tests.fast-check.ts"}]}
```

**proof/tests.fast-check.ts**
```typescript
import * as fc from "fast-check";
import { clamp } from "../impl.js";

// bounded: result is always in [min, max]
fc.assert(
  fc.property(fc.integer(), fc.integer(), fc.integer(), (v, a, b) => {
    const [min, max] = a <= b ? [a, b] : [b, a];
    const r = clamp(v, min, max);
    return r >= min && r <= max;
  }),
);

// idempotent: clamp(clamp(v,a,b),a,b) === clamp(v,a,b)
fc.assert(
  fc.property(fc.integer(), fc.integer(), fc.integer(), (v, a, b) => {
    const [min, max] = a <= b ? [a, b] : [b, a];
    return clamp(clamp(v, min, max), min, max) === clamp(v, min, max);
  }),
);

console.log("clamp property tests: ok");
```

### Submission flow

After writing the triplet, run:

```bash
yakcc emit-atom <atom-name>/
```

Exit codes and their meaning:
- `0` — validated, tests green, stored in registry
- `1` — usage or IO error (missing argument, file not found)
- `2` — `spec.yak` is invalid (missing or wrong fields)
- `3` — `impl.ts` violates strict-subset rules
- `4` — `proof/manifest.json` is invalid for L0
- `5` — property tests failed (fast-check found a counterexample)
- `6` — registry write error

### Variance fallback discipline (DEC-WI954-010)

- **Triplet emission path (canonical):** LLM emits a full triplet → `yakcc emit-atom`
  validates, runs property tests, stores. This is the path for ALL operations that
  do not exist in the registry.
- **Variance synthesis (fallback):** The PreToolUse hook may synthesize variance atoms
  from bare code that passes through the hook without a matching triplet. This is a
  fallback for pre-existing code — it does NOT replace the triplet emission path.
- A bare code block that is NOT a triplet-formatted directory is routed to variance
  synthesis automatically. You MUST prefer triplet emission for new operations.
