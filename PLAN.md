# PLAN — WI-954 LLM atom-triplet emission format + CLI parser

> Planner output for [`#954`](https://github.com/cneckar/yakcc/issues/954)
> (Sub-WI of [`#950`](https://github.com/cneckar/yakcc/issues/950) — proactive
> hook flow realignment). Workflow `wi-954-triplet-emission`, work item
> `wi-954-plan`, goal `g-954`.
> Branch `feature/954-llm-triplet` in worktree
> `/Users/cris/src/yakcc/.worktrees/feature-954-llm-triplet`.
>
> Supersedes the prior WI-933/934 plan content at this path. WI-933/934 landed
> upstream of this branch; this plan addresses the next sub-WI of #950's
> Gap C (LLM-emits-atom-triplet pattern).

---

## 0 — Headline

When the canonical MCP discovery (`yakcc_resolve`) returns no fit, the
operator's directive (#950) says the LLM must emit a **fully-formed yakcc
atom** — a triplet of `spec.yak` + `impl.{ts,py,go}` +
`proof/tests.fast-check.{ts,py}` — rather than raw code that gets post-hoc
atomized by `@yakcc/variance`'s synthetic test generator. This WI defines that
emission shape, documents it in the LLM-facing system prompt, and adds the
CLI subcommand that consumes it: parse → validate strict-subset → run
LLM-authored property tests → persist via `storeBlock` only if green.
Variance generation becomes the **fallback** for emissions that aren't
triplet-formatted; the triplet path becomes the default.

**Critical reuse observation:** the substrate already has everything the
emission path needs except the LLM-test execution step.
- `parseBlockTriplet` (`@yakcc/ir/block-parser.ts`) reads a directory triplet,
  validates `spec.yak` via `validateSpecYak`, runs the strict-subset validator
  on `impl.ts`, validates `proof/manifest.json`, and derives the
  `BlockMerkleRoot`.
- `@yakcc/seeds/seed.ts` already wires `parseBlockTriplet` →
  `registry.storeBlock` for the static-validation path (no test execution).
- `@yakcc/contracts/triplet.test.ts` provides the canonical fixture vocabulary.

What's missing is exactly one thing: **a CLI subcommand that runs the LLM's
`proof/tests.fast-check.ts` against `impl.ts` in-band, exits non-zero if the
tests fail, and calls `storeBlock` only on green.** That's the load-bearing
new code. Everything else is composition.

The variance fallback discipline is the second deliverable: callers must use
the triplet path when a `proof/tests.fast-check.*` file is present in the
emission; variance synthesis only fires for bare-code emissions.

---

## 1 — Problem decomposition

### 1.1 What problem are we actually solving?

**Surface problem:** today, when an LLM emits code that doesn't match an
atom, `@yakcc/variance` synthesizes property tests from the spec. Those
synthetic tests are heuristically derived from spec shape — they cover the
type contract but not the operational intent. Quality of commons growth is
bounded by the synthesis.

**Root problem:** the LLM has *more* context than a post-hoc synthesizer.
It knows what the code is supposed to do, what edge cases matter, what
invariants are load-bearing, because it just wrote both the spec and the
impl. If the LLM authors the property tests at emission time, the commons
grow with high-quality, behavior-driven contracts. If the LLM emits raw
code, variance is the last-resort safety net.

**Principle being made explicit:** the LLM is the highest-context proof
author for code it just wrote. Substrate-side synthesis is a fallback for
the bare-emission case, not the default. This WI codifies the format the LLM
must emit and the CLI surface that consumes it.

### 1.2 Goals (measurable)

- G1. `docs/system-prompts/yakcc-discovery.md` documents the canonical
  triplet format (filenames, file roles, language coverage matrix) with at
  least one worked example end-to-end (small atom, three files,
  CLI command, expected output).
- G2. New CLI subcommand `yakcc emit-atom <dir>` exists, registered in
  `packages/cli/src/index.ts` and shown in `printUsage`.
- G3. The subcommand reads a directory containing `spec.yak`, `impl.ts`,
  `proof/manifest.json`, and `proof/tests.fast-check.ts` (TypeScript
  triplet, MVP language), parses it via `parseBlockTriplet`, runs
  `proof/tests.fast-check.ts` against `impl.ts` in-band, and either:
  - On green: calls `registry.storeBlock` with the parsed
    `BlockTripletRow`; prints the resulting `BlockMerkleRoot` and exits 0.
  - On red (test failure): prints which property failed (counterexample
    included where available) and exits non-zero with a clear gate name.
  - On parse failure (spec invalid / strict-subset violation / manifest
    invalid): exits non-zero naming the failed gate.
- G4. The subcommand is unit-tested in `packages/cli/src/commands/emit-atom.test.ts`
  with at least these cases:
  - happy path (small atom, real `parseBlockTriplet`, real test execution,
    real `storeBlock` against an in-memory or temp-file registry)
  - missing spec.yak / missing impl.ts / missing proof/manifest.json /
    missing proof/tests.fast-check.ts → distinct error messages, non-zero
  - strict-subset violation in impl.ts → non-zero with the strict-subset
    error surfaced
  - property test failure (a deliberately wrong impl that the LLM-authored
    tests catch) → non-zero, storeBlock NOT called
  - integration end-to-end: emit-atom on a real triplet, then `yakcc
    propose` against the resulting spec to confirm round-trip persistence
    (or equivalent query roundtrip)
- G5. Variance fallback discipline: documentation in
  `yakcc-discovery.md` clearly states that variance synthesis only fires
  when an emission lacks `proof/tests.fast-check.*`. No code edit to
  `packages/variance/**` is required because variance is invoked by other
  paths (post-hoc atomize at `storeBlock` seam); this WI's CLI does not
  invoke variance at all — it operates strictly on triplet-formatted
  emissions. The fallback discipline is therefore enforced by *which CLI
  surface the caller uses*, documented for the LLM.
- G6. `pnpm --filter @yakcc/cli test`, `typecheck`, `lint` all green. No
  regressions.

### 1.3 Non-goals (explicit exclusions)

- N1. **Multi-language triplet ingestion.** The MVP triplet ingest path
  handles TypeScript (`impl.ts` + `proof/tests.fast-check.ts`) only. The
  format DOC enumerates the canonical language vocabulary
  (`impl.{ts,py,go}`, `proof/tests.fast-check.{ts,py}`) but the CLI
  initially accepts only `impl.ts`+`proof/tests.fast-check.ts`. Python and
  Go triplet ingest are deferred. Documented in DEC-WI954-001.
- N2. **Modifying `@yakcc/variance` internals.** Variance behavior is
  unchanged. The fallback discipline is enforced by the LLM's choice of
  surface (triplet path = `yakcc emit-atom`; bare-code path =
  storeBlock-time atomize). Forbidden by scope manifest in any case.
- N3. **Modifying `@yakcc/ir`, `@yakcc/contracts`, `@yakcc/registry`,
  `@yakcc/hooks-base`, `@yakcc/mcp-registry`.** All forbidden by scope
  manifest. The CLI subcommand consumes them as workspace dependencies.
- N4. **MCP description payload, `yakcc_resolve` cascade, confidence
  bands.** All belong to companion WI `#953` (Gap A: `yakcc_resolve`
  wiring). Out of scope for #954.
- N5. **Wiring the LLM to actually call `yakcc emit-atom` at emission
  time.** That wiring is the LLM's system prompt + the MCP description
  payload (#953). This WI only delivers the format definition + CLI
  consumer; the LLM-facing instructions land in `yakcc-discovery.md` but
  the runtime delivery of that prompt to the LLM is #953's job.
- N6. **Bundle/envelope alternative.** The triplet is emitted as a
  directory of three files (matching the existing `packages/seeds/<name>/`
  layout that `parseBlockTriplet` already understands). A
  Markdown/YAML/JSON envelope is **rejected** by DEC-WI954-002.
- N7. **Removing variance synthesis entirely.** Per #954 issue body and
  #950 Gap C: variance stays as the fallback for emissions that aren't
  triplet-formatted (no `proof/tests.fast-check.*` present).
- N8. **Changes to `propose`, `seed`, `compile`.** No existing CLI surface
  needs to change. `emit-atom` is a new sibling subcommand.

### 1.4 Unknowns and ambiguities (resolved here)

- U1. **Subcommand naming.** Three candidates: `yakcc emit-atom <dir>`,
  `yakcc accept-atom <dir>`, `yakcc compile --emit <dir>`. Resolved:
  `yakcc emit-atom <dir>` (DEC-WI954-003). The verb `emit` matches the
  LLM-side semantics ("the LLM emits an atom triplet, the CLI receives
  it"). Avoids overloading `compile` (which lowers a spec to source code,
  conceptually inverse). Avoids "accept" (which implies a moderation
  decision the CLI isn't making — the gate is property-test green, not a
  policy judgment).
- U2. **Test-execution mechanism.** Options:
  (a) **Spawn `node --import tsx` on the `proof/tests.fast-check.ts` file**
      and let the test file call `fc.assert(...)` directly, with the
      process exit code as the green/red signal. Tests look like the
      `packages/seeds/src/blocks/digit/proof/tests.fast-check.ts` files
      already in the corpus — no test framework runner, just plain
      `fc.assert` calls under `if (require.main === module)`.
  (b) Spawn `pnpm --filter <ephemeral package> test` for vitest-shaped
      tests. Too heavy for a single-atom emission gate.
  (c) Dynamic `import()` inside the CLI process. Risky — node ESM cycles
      with the LLM-supplied code; harder to sandbox; the failure surface
      is muddier.
  Resolved: option (a), `node --import tsx <proof/tests.fast-check.ts>`.
  Document the test-file convention in `yakcc-discovery.md`: tests must
  be runnable standalone — top-level `fc.assert(...)` calls, no test
  framework required, exit code is the gate. DEC-WI954-004.
- U3. **Registry path for `emit-atom`.** Mirror `propose`'s convention:
  `--registry <path>` flag defaulting to
  `DEFAULT_REGISTRY_PATH` (`.yakcc/registry.sqlite`). Use the existing
  `openRegistry` + `makeCommonsBinding` pattern from `propose.ts` so the
  commons-push at `storeBlock` seam fires identically (per
  DEC-COMMONS-SUBMIT-AT-STOREBLOCK-001). DEC-WI954-005.
- U4. **What does the directory look like for the LLM?** The seed corpus
  layout `<root>/{spec.yak, impl.ts, proof/{manifest.json,
  tests.fast-check.ts}}` is the canonical shape `parseBlockTriplet` already
  consumes. Document this exact layout in `yakcc-discovery.md` with a
  small worked example (a `clamp` atom: spec defines clamp(value, min,
  max), impl is a five-line TS function, tests assert idempotence,
  bounds-check, and order-invariance). DEC-WI954-006.
- U5. **`impl.ts` strict-subset coupling.** `parseBlockTriplet` already
  invokes the strict-subset validator (`validateStrictSubset` from
  `@yakcc/ir`). The CLI surfaces the result.validation.ok bit and the
  ValidationError list verbatim — no new validation logic. DEC-WI954-007.
- U6. **Where do property-test temp files live?** Spawning `node --import
  tsx` needs the LLM's emitted directory to be reachable. Resolved: spawn
  with `cwd = <emitDir>` and pass `proof/tests.fast-check.ts` as the
  positional. The test file imports `../impl.js` (TS-compiled by tsx).
  Document the relative-import convention. The CLI does NOT copy files
  into `tmp/`. DEC-WI954-008.
- U7. **What about a foreign triplet?** `@yakcc/contracts` already has
  `ForeignTripletFields` (`{kind:"foreign", pkg, export, dtsHash?}`) for
  node-builtin / npm-package shims. Foreign atoms have no `impl.ts` /
  `proof/tests.fast-check.ts` — they reference a package symbol. Out of
  scope for `emit-atom` in this WI; the subcommand only handles local
  triplets. Document this carve-out in `yakcc-discovery.md`. DEC-WI954-009.

### 1.5 Dominant constraints

- C1. **Scope manifest is law.** Allowed:
  `packages/cli/src/commands/**`, `packages/cli/src/lib/**`,
  `packages/cli/src/index.ts`, `packages/cli/src/index.test.ts`,
  `docs/system-prompts/yakcc-discovery.md`, `docs/decisions/*.md`,
  `tmp/**`, `PLAN.md`.
  Forbidden:
  `packages/shave-python/**`, `packages/compile-python/**`,
  `packages/shave/**`, `packages/compile/**`, `packages/contracts/**`,
  `packages/registry/**`, `packages/federation/**`,
  `packages/hooks-base/**`, `packages/ir/**`, `packages/variance/**`,
  `packages/mcp-registry/**`, `bootstrap/**`, `.github/**`, `.claude/**`.
- C2. **`packages/cli/package.json` is in `packages/cli/` but NOT in
  allowed_paths.** Verify before the implementer needs a new dep. If
  `tsx` and `fast-check` are not already in the CLI package's runtime
  dependencies (they ship in @yakcc/seeds and @yakcc/ir respectively),
  request a scope widening **before** the implementer starts. See §6.5
  for the scope-sync action.
- C3. **No edits to `@yakcc/variance`, `@yakcc/registry`, `@yakcc/ir`,
  `@yakcc/contracts`.** The CLI consumes them as workspace deps —
  imports only, no source modification.
- C4. **Test-execution is in-band but sandboxed enough.** Spawning
  `node --import tsx <test-file>` runs in a child process — failures
  don't crash the CLI; stderr/stdout is captured and surfaced. The CLI's
  own test suite uses real LLM-shaped triplet fixtures under `tmp/` or
  `packages/cli/src/commands/__fixtures__/` (the latter is in scope under
  `packages/cli/src/commands/**`).
- C5. **No state-authority changes.** The CLI consumes existing
  authorities (`@yakcc/contracts` for SpecYak, `@yakcc/ir` for
  block-parser/strict-subset, `@yakcc/registry` for storeBlock). No new
  state lives in this WI.

---

## 2 — Architecture design & state-authority map

### 2.1 State-authority map (where state lives)

| Operational fact | Authority | This WI touches? |
|---|---|---|
| Triplet directory shape (`{spec.yak, impl.ts, proof/{manifest.json,tests.fast-check.ts}}`) | `packages/ir/src/block-parser.ts` (`parseBlockTriplet`) | **read-only consume** via workspace dep |
| SpecYak schema + `validateSpecYak` | `packages/contracts/src/spec-yak.ts` | **read-only consume** |
| Strict-subset validation of `impl.ts` | `packages/ir/src/strict-subset.ts` (`validateStrictSubset`) | **read-only consume** (invoked transitively via `parseBlockTriplet`) |
| L0 proof manifest validation | `packages/contracts/src/proof-manifest.ts` (`validateProofManifestL0`) | **read-only consume** |
| BlockMerkleRoot derivation | `packages/contracts/src/merkle.ts` (`blockMerkleRoot`) | **read-only consume** |
| Registry persistence (`storeBlock`) | `packages/registry/src/storage.ts` (`Storage.storeBlock`) via `openRegistry` | **read-only consume** |
| Commons-push binding at storeBlock seam | `packages/cli/src/lib/commons-submit.ts` (`makeCommonsBinding`) | **read-only consume** (already in CLI scope; do not re-implement) |
| LLM-facing system prompt | `docs/system-prompts/yakcc-discovery.md` | **extend** — append "Emission shape" section |
| CLI subcommand routing | `packages/cli/src/index.ts` (`runCli`) | **extend** — new `case "emit-atom":` branch + usage text line |
| Property-test execution (NEW) | `packages/cli/src/commands/emit-atom.ts` (new) | **create** — spawn `node --import tsx <proof/tests.fast-check.ts>`, capture exit code, stdout, stderr |
| Variance fallback path | `packages/variance/src/index.ts` (invoked by storeBlock-time atomize for bare-code emissions) | **read-only acknowledge** — this WI does NOT invoke variance; documented in yakcc-discovery.md |

### 2.2 Subcommand surface

```
yakcc emit-atom <directory>
  [--registry <path>]      # default: .yakcc/registry.sqlite (DEC-WI954-005)
  [--skip-tests]           # DANGEROUS — bypasses property-test gate; for CI-only triplet seeding
  [--json]                 # machine-readable output (BlockMerkleRoot, validation errors as JSON)
```

Exit codes:
- 0 — triplet validated, tests green, stored.
- 1 — usage / IO error.
- 2 — spec.yak invalid (validateSpecYak threw).
- 3 — impl.ts strict-subset violation.
- 4 — proof/manifest.json invalid.
- 5 — proof/tests.fast-check.ts failed (property test counterexample found).
- 6 — storeBlock failed (registry write error).

Each distinct exit code corresponds to a documented gate. The implementer
encodes these as named constants (`EMIT_ATOM_EXIT_OK`,
`EMIT_ATOM_EXIT_SPEC_INVALID`, etc.) in `emit-atom.ts` and asserts on them
in tests.

### 2.3 emit-atom.ts module shape

```ts
export interface EmitAtomOptions {
  embeddings?: RegistryOptions["embeddings"];
}

/**
 * `yakcc emit-atom <dir> [--registry <p>] [--skip-tests] [--json]`
 *
 * Reads an LLM-emitted triplet directory, validates it, runs the
 * LLM-authored property tests against the impl, and persists via
 * storeBlock only if all gates are green.
 */
export async function emitAtom(
  argv: readonly string[],
  logger: Logger,
  opts?: EmitAtomOptions,
): Promise<number>;
```

Internal flow:

1. **Parse argv** via `parseArgs` (DEC-V0-CLI-004 pattern from other
   commands).
2. **Resolve dir path** and verify it exists; require `spec.yak`,
   `impl.ts`, `proof/manifest.json`, `proof/tests.fast-check.ts`. Missing
   any → exit 1 with a clear error naming the missing file.
3. **Call `parseBlockTriplet`** from `@yakcc/ir`. On throw → exit 2/3/4
   depending on which gate threw (catch + classify by error message OR by
   inspecting the validation result if `parseBlockTriplet` returns
   structured errors — the implementer reads `block-parser.ts` to decide).
4. **Run property tests** (unless `--skip-tests`):
   ```
   spawn("node", ["--import", "tsx", "proof/tests.fast-check.ts"], {
     cwd: emitDir,
     stdio: ["ignore", "pipe", "pipe"],
   })
   ```
   On non-zero exit → exit 5; print captured stderr; do NOT call
   storeBlock.
5. **Build `BlockTripletRow`** from the `BlockTripletParseResult` (same
   pattern as `packages/seeds/src/seed.ts:83-117`).
6. **Open registry** with `makeCommonsBinding` wiring; call
   `registry.storeBlock(row)`. On throw → exit 6.
7. **Print result**: human form is `stored: <BlockMerkleRoot>` plus a
   one-line summary; `--json` form is `{ "merkleRoot": "...", "specHash":
   "...", "stored": true }`.

The implementer copies the storeBlock-row construction pattern from
`packages/seeds/src/seed.ts` (which is read-only-consume — that file is
forbidden, but its 30-line pattern can be re-implemented in
`packages/cli/src/commands/emit-atom.ts` without modifying the seeds
package).

### 2.4 Property-test execution (DEC-WI954-004 detail)

The LLM-authored test file `proof/tests.fast-check.ts` must:

- Import the impl: `import { theFunction } from "../impl.js"` (tsx
  resolves `.js` → `.ts`).
- Call `fc.assert(fc.property(...))` at the top level (not wrapped in
  `describe`/`it`).
- Exit non-zero on assertion failure (fast-check throws; node propagates
  the unhandled exception to exit code 1).

Example (from the worked `clamp` example in §2.5):
```ts
import * as fc from "fast-check";
import { clamp } from "../impl.js";

fc.assert(
  fc.property(fc.integer(), fc.integer(), fc.integer(), (v, a, b) => {
    const [min, max] = a <= b ? [a, b] : [b, a];
    const r = clamp(v, min, max);
    return r >= min && r <= max;
  }),
);

console.log("clamp property tests: ok");
```

This shape mirrors what's already in
`packages/seeds/src/blocks/digit/proof/tests.fast-check.ts` — the LLM is
asked to author files matching the existing seed-corpus convention.
That's load-bearing: the corpus already trains downstream tools (shave,
compile-self) on this shape, so emission-time triplets are
indistinguishable from seed triplets once stored.

### 2.5 Worked example: `clamp` (documented in yakcc-discovery.md)

```
<temp-dir>/
├── spec.yak                       # SpecYak JSON
├── impl.ts                        # export function clamp(...)
└── proof/
    ├── manifest.json              # { "artifacts": [{ "kind": "property_tests", "path": "tests.fast-check.ts" }] }
    └── tests.fast-check.ts        # fc.assert at top level
```

`spec.yak`:
```json
{
  "name": "clamp",
  "inputs": [
    {"name": "value", "type": "number"},
    {"name": "min", "type": "number"},
    {"name": "max", "type": "number"}
  ],
  "outputs": [{"name": "result", "type": "number"}],
  "preconditions": ["min <= max"],
  "postconditions": ["min <= result <= max"],
  "invariants": [],
  "effects": [],
  "level": "L0",
  "behavior": "Clamp value to [min, max].",
  "guarantees": [
    {"id": "bounded", "description": "Result is in [min, max]."},
    {"id": "idempotent", "description": "clamp(clamp(v,a,b),a,b) === clamp(v,a,b)."}
  ],
  "errorConditions": [],
  "nonFunctional": {"purity": "pure", "threadSafety": "safe"},
  "propertyTests": [
    {"id": "bounded", "description": "Result is within bounds."},
    {"id": "idempotent", "description": "Applying clamp twice equals once."}
  ]
}
```

`impl.ts`:
```ts
export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
```

`proof/manifest.json`:
```json
{"artifacts": [{"kind": "property_tests", "path": "tests.fast-check.ts"}]}
```

`proof/tests.fast-check.ts`:
```ts
import * as fc from "fast-check";
import { clamp } from "../impl.js";

// Bounded
fc.assert(
  fc.property(fc.integer(), fc.integer(), fc.integer(), (v, a, b) => {
    const [min, max] = a <= b ? [a, b] : [b, a];
    const r = clamp(v, min, max);
    return r >= min && r <= max;
  }),
);

// Idempotent
fc.assert(
  fc.property(fc.integer(), fc.integer(), fc.integer(), (v, a, b) => {
    const [min, max] = a <= b ? [a, b] : [b, a];
    return clamp(clamp(v, min, max), min, max) === clamp(v, min, max);
  }),
);

console.log("clamp property tests: ok");
```

CLI invocation:
```bash
$ yakcc emit-atom ./clamp-emit
stored: a7f3b2c8e9d1e4f5b6c7a8f9e0d1c2b3a4f5e6d7c8b9a0f1e2d3c4b5a6f7e8d9
```

### 2.6 Variance fallback discipline (documented, not coded here)

The `yakcc-discovery.md` section will explicitly say:

> When `yakcc_resolve` returns no match:
> 1. **Preferred path:** emit a triplet directory and run `yakcc
>    emit-atom <dir>`. The CLI runs your property tests, persists if
>    green. This is the canonical path; commons growth quality depends
>    on you taking it.
> 2. **Fallback path:** if you cannot author property tests (rare; only
>    if the spec is too vague for fc.property), emit bare code. The
>    substrate's PreToolUse hook will atomize it post-hoc and
>    `@yakcc/variance` will synthesize property tests from the spec
>    shape. Quality is bounded by synthesis; prefer path 1.

No code in `packages/variance/**` changes. No code in this WI invokes
variance. The discipline is enforced by *the LLM's choice of CLI surface*,
mediated by the system prompt's preference ordering.

### 2.7 Alternatives considered & rejected

**Alt A — Single JSON envelope (`emission.json` with embedded spec, impl,
tests).** Rejected. `parseBlockTriplet` already accepts a directory; an
envelope adds a parse step and breaks symmetry with the existing seed-corpus
layout that the substrate (shave, compile-self, federation) already
understands. DEC-WI954-002.

**Alt B — `yakcc compile --emit <dir>`.** Rejected. `compile` lowers a
spec to source code (the opposite direction). Overloading it would conflate
two flows. DEC-WI954-003.

**Alt C — Spawn `pnpm test` or `vitest` to run property tests.** Rejected
in DEC-WI954-004. Too heavy (test framework startup ~3s vs ~200ms for
`node --import tsx`); requires the emit-dir to be a workspace; adds
indirect deps.

**Alt D — Dynamic `import()` inside the CLI process.** Rejected in
DEC-WI954-004. ESM cycles with LLM-supplied code are unpredictable; child
process gives a clean fail-shut boundary.

**Alt E — Re-implement `parseBlockTriplet` in CLI to avoid the
`@yakcc/ir` dep boundary.** Rejected — `@yakcc/ir` is already a CLI
dependency (it's how `shave` and `compile` work). Reuse, don't fork.

**Alt F — Persist on red, mark the atom as `provisional`.** Rejected.
Issue body says "persists via `storeBlock` only if green." Red emissions
exit non-zero; the LLM is expected to fix the impl and re-emit.

### 2.8 Research gate

The domain is well-understood: the codebase has six months of triplet
shape documentation (`@yakcc/contracts/triplet.test.ts` with 20-seed-spec
fixtures), the parser exists, the registry-write seam exists, the
commons-submit hook is documented (`DEC-COMMONS-SUBMIT-AT-STOREBLOCK-001`).
The only novel mechanism is spawning `node --import tsx` for property
tests, which is a 30-line shell-out using `child_process.spawn`. No
external research needed.

---

## 3 — Wave decomposition

One PR, one work item closed. The slices are small enough to ship together;
shipping them separately would land non-functional intermediate states
(docs without consumer, or consumer without docs).

| W-ID | Title | Weight | Gate | Deps | Issues closed | Integration |
|---|---|---|---|---|---|---|
| W-A | yakcc-discovery.md — emission section | S | none | — | #954 (partial) | `docs/system-prompts/yakcc-discovery.md` |
| W-B | emit-atom.ts subcommand scaffold + argv parsing | S | none | — | #954 (partial) | `packages/cli/src/commands/emit-atom.ts` (new), `packages/cli/src/index.ts` (extend `runCli` + `printUsage`) |
| W-C | Wire `parseBlockTriplet` → storeBlock-row construction | M | none | W-B | #954 (partial) | `emit-atom.ts` (extend) |
| W-D | Property-test execution via `node --import tsx` | M | none | W-C | #954 (partial) | `emit-atom.ts` (extend) |
| W-E | Registry open + commons-binding + storeBlock | S | none | W-D | #954 (partial) | `emit-atom.ts` (extend) |
| W-F | Test fixtures + unit tests (happy + failure paths) | M | none | W-E | #954 (partial) | `packages/cli/src/commands/emit-atom.test.ts` (new), `packages/cli/src/commands/__fixtures__/emit-atom/**` (new) |
| W-G | End-to-end integration test (real triplet → real registry → query roundtrip) | M | review | W-F | #954 (closes) | `emit-atom.test.ts` (extend) |
| W-H | Final lint/typecheck + barrel hygiene | S | none | W-G | — | `packages/cli/src/index.ts` (final touches) |

**Critical path:** W-B → W-C → W-D → W-E → W-F → W-G. W-A is doc-only and
can land first (recommend first commit so the LLM-facing principle is
visible in the PR diff before the consumer).

**Single PR:** the slices are mutually load-bearing. A PR that ships W-A
through W-D is non-functional (no registry persistence). A PR through W-H
is the minimum viable proof.

---

## 4 — Decision Log

| DEC-ID | Title | Rationale |
|---|---|---|
| **DEC-WI954-001** | MVP triplet ingest is TypeScript-only; format DOC enumerates ts/py/go vocabulary | The CLI initially accepts `impl.ts` + `proof/tests.fast-check.ts`. The discovery doc explicitly lists `impl.{ts,py,go}` and `proof/tests.fast-check.{ts,py}` as the canonical vocabulary the LLM may emit, with a note that Python and Go ingest are deferred. This keeps the LLM-facing prompt aligned with the long-term shape while bounding implementation. |
| **DEC-WI954-002** | Directory triplet, not envelope | `parseBlockTriplet` (`@yakcc/ir/block-parser.ts`) already consumes directory triplets matching the seed-corpus layout. Symmetry with seeds means a stored atom from `emit-atom` is byte-indistinguishable from a seeded atom; downstream tools (shave, compile-self, federation) work unchanged. Markdown/YAML/JSON envelope adds parse complexity for no benefit. |
| **DEC-WI954-003** | Subcommand name: `yakcc emit-atom <dir>` | "Emit" matches the LLM-side semantics ("I emit an atom triplet, the CLI receives it"). Avoids overloading `compile` (which lowers spec → source; conceptually inverse). Avoids "accept" (implies a moderation decision the CLI isn't making). |
| **DEC-WI954-004** | Property-test execution via child process: `node --import tsx <test-file>` | Fastest fail-shut boundary. ~200ms startup vs ~3s for vitest. Tests are plain top-level `fc.assert` calls — no test framework runner needed. Matches the existing seed-corpus test file convention (`packages/seeds/src/blocks/digit/proof/tests.fast-check.ts`). Stderr/stdout captured; non-zero exit → property failed. |
| **DEC-WI954-005** | Registry path + commons-binding: reuse `propose.ts` pattern | `openRegistry(registryPath, { commonsSubmit })` via `makeCommonsBinding({ registryPath, airgapped })` — identical to `propose.ts:92-104`. Default `registryPath` is `DEFAULT_REGISTRY_PATH` (`.yakcc/registry.sqlite`). Commons-push fires at storeBlock seam per `DEC-COMMONS-SUBMIT-AT-STOREBLOCK-001`. |
| **DEC-WI954-006** | Worked example in yakcc-discovery.md: `clamp(value, min, max)` | Small, complete, language-agnostic in intent, with two clear property-test cases (bounded + idempotent). The full directory listing is reproduced in the doc so the LLM sees the canonical layout. |
| **DEC-WI954-007** | Strict-subset validation is consumed via `parseBlockTriplet`, not re-implemented | `parseBlockTriplet` already invokes `validateStrictSubset` from `@yakcc/ir`. The CLI surfaces `result.validation.ok` + the `ValidationError[]` list verbatim. Exit code 3 on strict-subset failure. |
| **DEC-WI954-008** | Test-file cwd convention: spawn with `cwd = <emitDir>`, import `../impl.js` | Test file lives in `<emitDir>/proof/tests.fast-check.ts` and imports the impl as `../impl.js` (tsx resolves `.js` → `.ts`). The CLI does NOT copy files into `tmp/`. This convention matches the existing seed-corpus layout. |
| **DEC-WI954-009** | Foreign triplets out of scope for `emit-atom` MVP | `@yakcc/contracts` has `ForeignTripletFields` for npm-package / node-builtin shims. Foreign atoms have no `impl.ts` / `proof/tests.fast-check.ts` — they reference a package symbol. `emit-atom` handles local triplets only in this WI; foreign emission deferred. Documented in yakcc-discovery.md. |
| **DEC-WI954-010** | Variance fallback discipline enforced by surface choice, not by code change | This WI does NOT modify `@yakcc/variance`. The discipline is documented in `yakcc-discovery.md`: triplet emission → `yakcc emit-atom` (canonical); bare-code emission → existing PreToolUse path → storeBlock-time atomize → variance synthesis (fallback). The LLM's choice of surface enforces the ordering. |
| **DEC-WI954-011** | Distinct exit codes per gate (0..6) | 0=ok, 1=usage, 2=spec invalid, 3=strict-subset, 4=manifest invalid, 5=property test failed, 6=storeBlock failed. Encoded as named constants in `emit-atom.ts`. Asserted in tests. Lets downstream automation (LLM session telemetry, CI) distinguish "the LLM emitted a bad spec" from "the LLM's impl violates strict-subset" from "the LLM's tests caught a real bug in the LLM's impl" — these are different LLM-quality signals. |
| **DEC-WI954-012** | Fixture layout: `packages/cli/src/commands/__fixtures__/emit-atom/` | New fixtures directory under the CLI commands tree, in scope. Contains at minimum: `clamp-green/` (happy path), `clamp-strict-violation/` (impl uses banned construct), `clamp-bad-spec/` (missing required SpecYak field), `clamp-failing-tests/` (impl deliberately wrong; LLM-authored tests catch it). |
| **DEC-WI954-013** | `--skip-tests` flag for CI seeding bypass | Allows CI scripts to ingest pre-vetted triplets without re-running tests (e.g. bulk seed from a known-good registry export). Documented as DANGEROUS in usage text — for human-LLM emission this should never be used. The flag exists so the same CLI surface covers both "LLM emission gate" and "bulk admin seeding" without needing two commands. |
| **DEC-WI954-014** | Test execution timeout: 30s per file | Spawned `node --import tsx` runs property tests; reasonable upper bound. Exceeding the timeout → kill the child, exit 5 with "property tests exceeded 30s timeout". The implementer encodes this as a configurable constant `EMIT_ATOM_TEST_TIMEOUT_MS` so future tuning is one-line. |

Each row maps 1:1 to an `@decision` annotation the implementer emits at the
point of implementation.

---

## 5 — Evaluation contract (for Guardian readiness)

### 5.1 Required tests

| Test | Location | Asserts |
|---|---|---|
| Argv parsing | `emit-atom.test.ts` | Missing positional → exit 1. Unknown flag → exit 1. `--help`-like → usage. |
| Missing files in dir | `emit-atom.test.ts` | Missing `spec.yak` / `impl.ts` / `proof/manifest.json` / `proof/tests.fast-check.ts` → exit 1 with named-file error. |
| Spec invalid | `emit-atom.test.ts` | `clamp-bad-spec` fixture (missing `level` field) → exit 2; storeBlock NOT called. |
| Strict-subset violation | `emit-atom.test.ts` | `clamp-strict-violation` fixture (impl uses banned construct like dynamic import) → exit 3; storeBlock NOT called. |
| Manifest invalid | `emit-atom.test.ts` | A fixture with `proof/manifest.json` containing `kind: "smt_cert"` (L2-only) → exit 4; storeBlock NOT called. |
| Property test failure | `emit-atom.test.ts` | `clamp-failing-tests` fixture (impl returns value unclamped; LLM-authored test catches it) → exit 5; stderr surfaces the counterexample; storeBlock NOT called. |
| Happy path: storeBlock fires | `emit-atom.test.ts` | `clamp-green` fixture → exit 0; `stored: <root>` printed; `--json` form returns a valid `{merkleRoot, specHash, stored:true}` object. |
| Round-trip persistence | `emit-atom.test.ts` (integration) | After a green `emit-atom`, the stored block is queryable via `selectBlocks(specHash)` and `selectByMerkleRoot(root)` returns matching impl + manifest + artifact bytes. |
| `--skip-tests` bypasses gate | `emit-atom.test.ts` | A fixture whose property tests would fail still stores when `--skip-tests` is set (proving the flag is a real bypass; the implementer prints a warning to stderr). |
| Custom `--registry` honored | `emit-atom.test.ts` | The CLI opens the registry at the path specified by `--registry`, not the default. |
| Exit code enumeration | `emit-atom.test.ts` | All six exit codes (0..6) covered by at least one test case. |
| Subcommand registration | `packages/cli/src/index.test.ts` (extend) | `runCli(["emit-atom"])` exits 1 with usage error; `runCli(["--help"])` prints `emit-atom` in the usage text. |

Minimum coverage clears WI-954's acceptance bullets:
- "LLM session emits a triplet for a novel atom; the CLI parses it, runs
  the property tests, persists if green" — covered by happy-path +
  round-trip tests.
- "Resulting atom carries the LLM-authored property tests (verifiable via
  `yakcc get-atom <root>` showing the proof origin)" — round-trip test
  asserts artifact bytes match what was emitted.
- "`@yakcc/variance` still runs for non-triplet emissions (the fallback
  works)" — out-of-scope test (variance package is forbidden); covered by
  documentation in yakcc-discovery.md + reference to existing variance
  tests untouched.
- "New triplet format documented in `docs/system-prompts/yakcc-discovery.md`
  with at least one worked example" — covered by W-A and verified by the
  reviewer reading the doc.

### 5.2 Required evidence (paste to PR description)

- Raw output of `pnpm --filter @yakcc/cli test` (all green; emit-atom
  suite visible).
- Raw output of `pnpm --filter @yakcc/cli typecheck`.
- Raw output of `pnpm --filter @yakcc/cli lint`.
- Live invocation of `yakcc emit-atom <fixture-dir>` against the real
  `clamp-green` fixture, showing the printed `stored: <root>` and the
  round-trip query confirming persistence.
- The four-fixture test directory listing under
  `packages/cli/src/commands/__fixtures__/emit-atom/` so the reviewer can
  see what the LLM-authored shape looks like in practice.

### 5.3 Required real-path checks

- End-to-end: build a `clamp` triplet directory under `tmp/`, invoke
  `yakcc emit-atom tmp/clamp-emit --registry tmp/test-registry.sqlite`,
  observe a 64-char BlockMerkleRoot, then `yakcc propose
  tmp/clamp-emit/spec.yak --registry tmp/test-registry.sqlite` confirms
  the atom is now matchable by spec.
- Verify the LLM-authored property-test execution actually catches a
  wrong impl: edit `tmp/clamp-emit/impl.ts` to return `value` unclamped,
  re-invoke `emit-atom`, observe exit 5 with a fast-check counterexample.

### 5.4 Required authority invariants

- **No edits to forbidden packages.** Grep proof in PR description:
  ```bash
  git diff main...HEAD -- packages/ir packages/contracts packages/registry packages/variance packages/hooks-base packages/mcp-registry packages/shave packages/compile packages/shave-python packages/compile-python packages/federation bootstrap .github .claude
  ```
  Must return empty.
- **`parseBlockTriplet` is called, not re-implemented.** Grep proof:
  ```bash
  rg "parseBlockTriplet" packages/cli/src/commands/emit-atom.ts
  ```
  Must show ≥1 hit (import + call).
- **`storeBlock` is called via `openRegistry`, not via direct sqlite.**
  Grep proof:
  ```bash
  rg "better-sqlite3|new Database" packages/cli/src/commands/emit-atom.ts
  ```
  Must return empty.
- **`fast-check`/`tsx` are only invoked via child process, not imported
  in the CLI src.** Grep proof:
  ```bash
  rg "from ['\"]fast-check['\"]|from ['\"]tsx['\"]" packages/cli/src/commands/emit-atom.ts
  ```
  Must return empty (the CLI spawns tsx as a tool; it doesn't import
  fast-check in the CLI process).

### 5.5 Required integration points

- `@yakcc/ir` — `parseBlockTriplet` imported.
- `@yakcc/registry` — `openRegistry`, `BlockTripletRow` type imported.
- `@yakcc/contracts` — `canonicalize`, `validateSpecYak` types
  transitively used; no direct import needed if `parseBlockTriplet`
  already exposes everything.
- `packages/cli/src/lib/commons-submit.ts` — `makeCommonsBinding`
  imported.
- `packages/cli/src/lib/yakccrc.ts` — `readRc` for airgapped detection
  (mirror `propose.ts`).
- `packages/cli/src/commands/registry-init.ts` — `DEFAULT_REGISTRY_PATH`
  imported.
- `packages/cli/src/index.ts` — new `case "emit-atom":` branch in
  `runCli`; usage text line added to `printUsage`; `emitAtom` import.

### 5.6 Forbidden shortcuts

- **Do NOT modify `packages/variance/**`.** Variance behavior is
  unchanged by this WI. Forbidden by scope manifest.
- **Do NOT modify `packages/ir/**`, `packages/contracts/**`,
  `packages/registry/**`.** Forbidden by scope manifest.
- **Do NOT re-implement `parseBlockTriplet`.** Import and call it from
  `@yakcc/ir`.
- **Do NOT bypass property-test execution silently.** If the LLM didn't
  provide `proof/tests.fast-check.ts`, exit 1 with a clear error.
  `--skip-tests` is the only legitimate bypass and it logs a stderr
  warning.
- **Do NOT call variance synthesis as a fallback inside `emit-atom`.**
  The variance fallback fires elsewhere (PreToolUse + storeBlock-time
  atomize); `emit-atom` operates strictly on triplet-formatted
  emissions.
- **Do NOT add a new fast-check dependency to the CLI package.**
  fast-check runs in the spawned child process (which has tsx +
  fast-check available via the LLM-emitted test file's own resolution;
  in the test fixtures, the fixture-local resolution picks up the
  workspace fast-check). If a CLI-test-runtime dep is needed, request
  scope widening for `packages/cli/package.json` before starting.
- **Do NOT persist on red.** Exit codes 2..5 must skip `storeBlock`.

### 5.7 Ready-for-guardian definition

The reviewer may issue `REVIEW_VERDICT: ready_for_guardian` when:

1. All required tests (§5.1) exist and pass on current HEAD.
2. All required evidence (§5.2) is recorded in the PR description.
3. `pnpm --filter @yakcc/cli test typecheck lint` all green — raw
   output captured.
4. All four required grep invariants (§5.4) return the expected
   results.
5. The live round-trip real-path check (§5.3) is reproduced in the PR
   description (or a developer note shows the exact commands + output).
6. `docs/system-prompts/yakcc-discovery.md` contains the emission
   section with the `clamp` worked example, the canonical directory
   shape, the language matrix (ts/py/go), and the variance-fallback
   discipline statement.
7. No edits exist outside scope manifest's allowed_paths.
8. All `@decision` annotations corresponding to DEC-WI954-001..014 are
   present at their respective implementation points.
9. No regressions: existing CLI tests, `index.test.ts`, and the rest
   of `pnpm test` at workspace level still pass.

### 5.8 Rollback boundary

Single PR. If the round-trip test fails (storeBlock rejects, or the
re-queried atom doesn't match the emission bytes), the PR is held — no
partial merge. The likely cause is either a mismatch in how the CLI
constructs `BlockTripletRow` vs. how `seed.ts` does it (compare against
`packages/seeds/src/seed.ts:83-117`) or a strict-subset gap surfaced by
the LLM-shaped fixture.

If the property-test execution path is flaky in CI (timing, tsx
availability), the implementer escalates rather than masking with
retries; the fail-shut child-process boundary is load-bearing for the
gate's credibility.

---

## 6 — Scope manifest

### 6.1 Allowed paths (writes)

- `packages/cli/src/commands/emit-atom.ts` — new subcommand handler
- `packages/cli/src/commands/emit-atom.test.ts` — unit + integration tests
- `packages/cli/src/commands/__fixtures__/emit-atom/clamp-green/**` — happy-path fixture
- `packages/cli/src/commands/__fixtures__/emit-atom/clamp-strict-violation/**` — strict-subset failure fixture
- `packages/cli/src/commands/__fixtures__/emit-atom/clamp-bad-spec/**` — spec validation failure fixture
- `packages/cli/src/commands/__fixtures__/emit-atom/clamp-failing-tests/**` — property test failure fixture
- `packages/cli/src/commands/__fixtures__/emit-atom/clamp-bad-manifest/**` — manifest validation failure fixture
- `packages/cli/src/index.ts` — register subcommand in `runCli` + update `printUsage`
- `packages/cli/src/index.test.ts` — assert `emit-atom` is wired and surfaced
- `docs/system-prompts/yakcc-discovery.md` — append "Emission shape" section
- `docs/decisions/DEC-WI954-EMIT-ATOM-001.md` — optional canonical decision record (mirrors DEC-WI954-001..014 in concise form)
- `tmp/**` — working notes, ad-hoc test triplets, evidence captures
- `PLAN.md` — this file (planner-owned)

### 6.2 Required paths (must be modified)

- `docs/system-prompts/yakcc-discovery.md` — emission section is the W-A deliverable
- `packages/cli/src/commands/emit-atom.ts` — the WI doesn't exist without this file
- `packages/cli/src/index.ts` — subcommand must be wired into `runCli`

### 6.3 Forbidden paths (must not touch)

- `packages/shave-python/**`
- `packages/compile-python/**`
- `packages/shave/**`
- `packages/compile/**`
- `packages/contracts/**`
- `packages/registry/**`
- `packages/federation/**`
- `packages/hooks-base/**`
- `packages/ir/**`
- `packages/variance/**`
- `packages/mcp-registry/**`
- `bootstrap/**`
- `.github/**`
- `.claude/**`

### 6.4 Expected state authorities touched

- LLM-facing system prompt content (`docs/system-prompts/yakcc-discovery.md`) — additive extension
- CLI top-level command vocabulary (`packages/cli/src/index.ts`) — new subcommand registered
- CLI commands directory — new module + new test + new fixtures
- No data-plane authority touched. No registry schema change. No new
  state domain.

### 6.5 Scope manifest sync (orchestrator action before dispatching implementer)

The dispatched scope summary enumerates `packages/cli/src/commands/*.ts`
and `packages/cli/src/commands/**/*.ts`, which covers the new
`emit-atom.ts` and the `__fixtures__/` subtree. However, per operator
memory `feedback_scope_manifest_fnmatch_globs.md`, both `*` and `**` shapes
are required to defeat the fnmatch zero-segment quirk for top-level files.
The provided scope already lists both — good.

**Critical scope-widening checks before dispatching the implementer:**

1. **Is `packages/cli/package.json` in scope?** It is NOT enumerated in
   the dispatched scope. If the implementer needs to add `tsx` as a CLI
   `dependency` (not a devDependency — `tsx` is invoked from the CLI
   process), the scope must widen to include `packages/cli/package.json`.
   **Action:** verify whether `tsx` is already in
   `packages/cli/package.json` `dependencies` (it probably is, since
   `compile-python.ts` or similar may shell out). If yes, no widening
   needed. If no, widen scope before dispatch:
   ```bash
   cc-policy workflow scope-sync wi-954-triplet-emission \
     --work-item-id wi-954-impl \
     --scope-file tmp/wi-954-scope.json
   ```
   where `tmp/wi-954-scope.json` adds `packages/cli/package.json` to
   allowed_paths.

2. **Is `docs/decisions/*.md` reachable?** The dispatched scope lists
   `docs/decisions/*.md`. The implementer may optionally write
   `docs/decisions/DEC-WI954-EMIT-ATOM-001.md` to mirror the decision
   log in canonical form. No additional widening needed.

3. **Are `packages/cli/src/commands/__fixtures__/**` reachable?**
   The dispatched scope's `packages/cli/src/commands/**/*.ts` glob covers
   `__fixtures__/**/*.ts` (TS files inside the fixture). However the
   fixtures also contain `.json` (spec.yak, proof/manifest.json) — does
   the scope glob cover them? The dispatched scope lists
   `packages/cli/src/commands/**/*.ts` only. **Action:** widen scope to
   include `packages/cli/src/commands/**/*.json` and
   `packages/cli/src/commands/**/*.yak` (yes, `spec.yak` is the filename
   but contents are JSON — pick whichever extension is canonical;
   `parseBlockTriplet` expects `spec.yak` as the filename). Add to
   `tmp/wi-954-scope.json` before dispatch.

The orchestrator must run `scope-sync` before dispatching the implementer.
Without scope-sync, hook enforcement will deny writes to
`packages/cli/src/commands/__fixtures__/emit-atom/clamp-green/spec.yak`
when the implementer creates the fixture.

---

## 7 — Open questions for operator (none blocking)

None block the implementer. The planner-resolved open questions in §1.4
cover everything that needs an answer before the implementer starts. If
the implementer hits a real new ambiguity (e.g. `parseBlockTriplet`
exposes errors in a shape that doesn't cleanly map to the six exit
codes), they escalate via SendMessage rather than guessing.

---

## 8 — Continuation rules (post-landing)

After this WI lands (Guardian merges to main):

- **Companion WI #953 (Gap A: `yakcc_resolve` MCP wiring)** becomes the
  next planner work item. #953 delivers the LLM's discovery surface and
  the system-prompt delivery mechanism (`yakcc-discovery.md` injection
  into the MCP tool description or settings). With #953 + #954 landed,
  the operator's directive (#950) is functionally complete for
  TypeScript.
- **Python triplet ingest** is the next follow-up after #953. The
  emission DOC enumerates `impl.py` + `proof/tests.fast-check.py`; the
  CLI extension adds language detection and a Python-side property-test
  runner (likely `python -m pytest` or a fast-check-py equivalent).
- **Go triplet ingest** follows the Python pattern.
- **Foreign atom emission** (`@yakcc/contracts` `ForeignTripletFields`)
  may also surface as a separate CLI flag (`yakcc emit-atom --foreign
  <pkg> --export <symbol>`) if commons growth observation shows enough
  foreign emissions to justify a dedicated path.
- **Variance synthesis comparison telemetry:** once `emit-atom` is in
  use, compare commons quality (e.g. property-test counterexample-find
  rate via mutation testing) between LLM-authored triplets and
  variance-synthesized triplets. The hypothesis: LLM-authored tests
  catch more mutants. This is a measurement WI, not an implementation
  one.

---

## 9 — Quality gate (self-check before emitting trailer)

- All dependencies and authorities are logically mapped (§2.1)
- Every guardian-bound work item has an Evaluation Contract (§5)
- Every guardian-bound work item has a Scope Manifest (§6)
- No work item relies on narrative completion — every claim has a
  measurable check (§5.1–§5.4 are all observable)
- Alternatives gate cleared (§2.7)
- Decisions logged (§4)
- Forbidden shortcuts named (§5.6)
- Ready-for-guardian definition is executable (§5.7)
- Rollback boundary defined (§5.8)
- Scope-sync action enumerated before implementer dispatch (§6.5)

Plan is ready for the implementer.

PLAN_VERDICT: next_work_item
PLAN_SUMMARY: WI-954 plan complete — new `yakcc emit-atom <dir>` CLI subcommand consuming the existing `parseBlockTriplet` + `storeBlock` substrate, plus LLM-authored property-test execution via spawned `node --import tsx`, plus emission-format documentation in `yakcc-discovery.md`. Next: guardian:provision to verify scope-sync (need to widen for `packages/cli/package.json` if `tsx` dep is missing, and for `__fixtures__/**/*.{json,yak}`) before dispatching the implementer to the existing worktree at `.worktrees/feature-954-llm-triplet`.
