# DESIGN.md — Yakcc

> A 15-minute orientation. If you are a new contributor — human or agent —
> read this end-to-end before touching a file. Then read `MASTER_PLAN.md` for
> what we're building next, and `initialize.txt` for the full vision in the
> user's own words.

---

## What Yakcc is

Yakcc is a substrate for assembling software out of minimal, behaviorally-
specified, content-addressed basic blocks drawn from a global registry. Each
block is written exactly once — by the first caller who needs it — and the
substrate improves monotonically as stricter or faster implementations are
contributed alongside the originals.

The name is a yak-shave joke that is also a thesis: this project is a massive
prerequisite undertaking whose explicit purpose is to abolish all future yak
shaves. We shave once so callers never shave again. The double-c is a nod to
GCC and the long lineage of terse compiler names.

## Why Yakcc

Two failure modes meet in the middle and Yakcc exists in the gap.

**Failure mode 1: generic libraries import attack surface their callers never
use.** A program that needs to parse a list of integers reaches for a JSON
library and inherits every CVE that library will ever have. The library author
maximized generality to maximize adoption; the caller pays the surface-area
tax forever. Multiplied across the ecosystem, this is the modern supply-chain
problem in one sentence.

**Failure mode 2: AI coding agents reflexively reimplement.** When an agent
can't find the right library quickly, it reimplements the function inline.
Generation is cheaper than retrieval-plus-comprehension, so generation wins,
and the same `parseInt` wrapper, the same `debounce`, the same React
boilerplate gets emitted ten million times across ten million projects. The
long tail of correct, audited, minimal implementations rots while the same
mediocre code is rewritten over and over.

Yakcc inverts both. A caller asking for "parse a list of ints, no other types"
gets exactly that — no JSON-the-language attack surface attached. An AI agent
asking for the same thing gets a registry hit, not a reemission. Every line
of code in a Yakcc-assembled program points to a verified, reused basic block
with a known test history and minimum necessary surface.

---

## Core concepts

### Contracts

A contract is a precise behavioral specification of what a piece of code does.

> "Parse a JSON array of integers, no other types, no escapes, fail on
> malformed input."
> "Match an opening bracket character."
> "Compute SHA-256 of a byte array, FIPS-compliant, constant-time."

Each of those is a contract. Two implementations that satisfy the same
contract are interchangeable from the caller's perspective.

### Content-addressed identity

A contract's identity is the hash of its canonicalized spec. It is not a name,
not a semver, not the hash of the implementation code. Two implementations
satisfying the same contract share an identity for that contract; the
implementations themselves are distinct entries underneath.

This is load-bearing. It is what lets the registry be version-free and
monotonic: nothing is "upgraded," because nothing has a version to upgrade
from. Newer entries simply advertise stricter contracts (a bug fix declares
correct handling of a case the prior entry mishandled) or better non-functional
properties (faster, smaller, lower-memory) and start winning selection.

### Partial ordering by strictness

Contracts form a partial order. A stricter contract refines a looser one — it
does less, but guarantees more about what it does. A bug fix is a strictly-
stricter contract. A perf improvement is a same-strictness contract with
stronger non-functional guarantees.

Inferring this ordering in general is undecidable. v0 takes the pragmatic
path: contributors declare ordering, and the substrate runs structural sanity
checks. Future work tightens this with differential execution and formal
properties.

### The embedding is just an index

Vector embeddings of contracts exist *only* to surface candidates for a
proposal. They are the search mechanism, not the contract. Selection from
candidates is governed by structured matching plus strictness, never by
cosine distance.

This is a discipline, not a default. Near-neighbors in embedding space can
have wildly different semantics — off-by-one, endianness, error handling,
thread safety. If embedding similarity ever becomes a correctness criterion,
the substrate has silently failed.

### Verification ladder

A registry of content-addressed blocks needs an orthogonal answer to "how
much do we believe this block does what it says?" Property tests
(v0's floor) catch bugs in expectation; they do not establish absence of
counterexamples. The verification ladder formalizes the next steps:

- **L0** — strict-TS subset, property tests pass. The v0 floor.
- **L1** — total functional: structural recursion or explicit fuel; the
  static totality checker rejects unbounded iteration.
- **L2** — SMT-decidable theory declared in `spec.yak`; Z3 / BMC proves
  refinement against the contract spec; bounded fallback to actor-critic
  fuzzing when the solver cannot reach.
- **L3** — paired Lean (or Coq / Agda) refinement proof, machine-checked.

Each level strictly refines the level below (a stricter contract about the
same behavior). Levels are declared per block in `spec.yak` and
mechanically enforced by the registry; a block claiming L2 that only
passes L1 is rejected, not silently downgraded. Levels are opt-in — a v0
deployment running purely on L0 blocks is first-class.

See `VERIFICATION.md` for the full design (block-as-triplet identity,
object-capability discipline, totality regime, SMT/BMC/Lean tooling, TCB
hardening, verifier-as-block).

### Composition from minimal blocks

Every component decomposes into smaller contracts that compose back into
larger ones. A list-of-ints JSON parser composes an integer-recognizer, a
bracket-matcher, and a comma-separator. A full JSON parser is built atop the
list-of-ints parser plus a string-recognizer plus an object-recognizer.

Each level inherits only the surface area it actually exercises. This is the
answer to the supply-chain problem: minimum-viable code is the *point*, not a
stretch goal.

### Monotonic, version-free registry

Old implementations are never deleted. They simply stop winning selection
because newer entries advertise stricter contracts or better non-functional
properties. There is no semver, no `latest`, no breaking-change event, no
upgrade. The substrate gets quietly better over time, and references to
content-addressed contracts remain stable forever.

Versioning is one of the largest sources of accidental complexity in modern
software. Yakcc designs it out by making contracts the identity rather than
names.

### No ownership

The registry is a public-domain commons. There is no `author_email`, no
`signature`, no reserved columns for either. The entire repo and every
registered block is dedicated to the public domain under **The Unlicense**.

The Unlicense (rather than 0BSD or MIT) is deliberate. A permissive copyright
license still presupposes an owner who is graciously waiving most of their
rights. A public-domain dedication asserts there is no owner to begin with.
That distinction matters here: the cornerstone is not "you may freely use
this code," it is "no ownership is allowed in this commons." The license is
the legal instrument that matches the cornerstone, not a pragmatic compromise
on top of it.

This is not a default we will quietly back away from when trust mechanisms
become interesting later — trust mechanisms, when they arrive, will attach
to immutable contract ids in a sidecar layer. Identity stays a hash.

### Minimum-viable code

Yakcc produces the smallest implementation whose contract is a superset of
what the caller actually needs. This is the opposite of how libraries are
written today, where authors maximize generality to maximize adoption. The
wedge for the project — especially in security-conscious contexts — is that
every line of code in a Yakcc-assembled program points to something verified
and minimal.

### Sub-function decomposition

A registry of hand-authored blocks is a demo. A registry that can absorb the
working ecosystem at the right granularity is the answer to the supply-chain
problem. v0 stands up the substrate; v0.5 lets AI synthesize blocks the
registry is missing; v0.7 ingests existing libraries by **recursive
decomposition down to atomic blocks**.

**Function-level contracts are a means; atomic blocks are the end.** This
is the load-bearing v0.7 principle. A function-level contract for
`parseIntList` says "given a string of the form `[i1,i2,...,iN]`, return
the integers." Useful, but not minimum-viable. The hand-authored
`parseIntList` in `packages/seeds/src/blocks/list-of-ints.ts` decomposes
into seven primitives — `bracket`, `digit`, `comma`, `optionalWhitespace`,
`peekChar`, `nonAsciiRejector`, `eofCheck`. Each primitive is a single
behavioral act. That is the granularity v0.7 must reach when it ingests
an equivalent function from a third-party library, or it has not done its
job. "Did not reach atoms" is a v0.7 failure, not an acceptable
approximation.

Decomposition takes a permissively-licensed third-party library's source
tree and walks it for candidate units. For each unit the engine extracts
an *intent card* (LLM-derived structured purpose, inputs, outputs, error
semantics, security posture), proposes a `ContractSpec`, and then asks:
*can this be expressed as a non-trivial composition of two or more
sub-blocks?* If yes, recurse on each sub-block. If no — at most one
control-flow boundary, no further factorable structure, no near-duplicate
of an existing registry atom — register it as an atom. The result is a
recursion tree, not a flat list, and every level of that tree gets
ingested with parent-block links recorded as provenance metadata.

When the same shape appears in multiple libraries, three rules govern
what gets registered as the canonical contract:

- **Safety = intersection.** A guarantee is registered only if every
  observed implementation provides it.
- **Behavioral = majority-vote.** Where implementations differ on
  optional behavior, the most common interpretation wins.
- **Capability = union.** The set of supported inputs is the union
  across implementations.

These rules, plus 7-dimension variance scoring (security 0.35,
behavioral 0.25, error_handling 0.20, performance 0.10, interface
0.10) and CWE-474 family mapping for the security dimension, are
**ported from librAIrian** — the Python research prototype at
`/Users/cris/src/librAIrian/` that demonstrated decomposition-by-LLM
at function-level granularity. librAIrian is a study reference for
Future Implementers, *not* a runtime dependency: yakcc is
self-contained, TS-only, and re-implements these concepts natively
inside `@yakcc/shave` against the Anthropic SDK directly. No Python
in the runtime path.

The point of this is concrete: a caller asking for `parseArgv` should
get just the tokenizer / flag-classifier / value-coercer atoms — not
the rest of `mri` (the v0.7 demo target), and certainly not the rest
of `yargs`. A caller asking for an `ascii-digit` predicate should get
back the same hand-authored `digit` atom whether they shaved it from
`mri`, from a JSON parser, or from the seed corpus — content-addressed
identity collapses the duplicates.

Each ingested block passes the same gates as a fresh block: the strict
TS subset, a property-test corpus, content-addressed identity. Only
permissive licenses are accepted at the ingestion boundary (Unlicense,
MIT, BSD-2/3, Apache-2.0, ISC, 0BSD, public-domain dedications);
copyleft and proprietary licenses are refused with a clear error.
Upstream licenses are recorded but not relicensed — the commons
absorbs without rewriting attribution. v0.7 gates absorption on
property tests plus a focused differential test against the upstream
package's published test corpus; v1 adds large-scale fuzz-driven
differential execution as the deeper check. Until v1, shaved blocks
should be treated as candidate replacements pending manual audit in
security-critical contexts, not drop-in substitutes.

---

## Orthogonal axes

Yakcc has three independent axes. A user sits at any `(v, F, L)`
coordinate; advancing on one axis does not require advancing on another.

```
                          Trust/Scale (FEDERATION.md)
                          F0 → F1 → F2 → F3 → F4
                          ──────────────────────────►

Substrate (MASTER_PLAN)   ▲
v0 → v0.5 → v0.7          │           Verification (VERIFICATION.md)
v1 → v2                   │           ▲
                          │           │
                          │           │  L0 → L1 → L2 → L3
                          │           │
                          ▼           ▼
```

- **v-axis (substrate maturity)** — what the substrate can do
  (`MASTER_PLAN.md` stages v0..v2). Local-only TS substrate → AI
  synthesis → sub-function decomposition → federation/WASM/multi-hook →
  self-hosting.
- **F-axis (trust/scale)** — how many machines participate
  (`FEDERATION.md`). F0 single-machine → F1 read-only mirror → F2
  attested mirror → F3 ZK supply-chain → F4 economic-commons participant.
- **L-axis (verification rigor)** — how confident we are
  (`VERIFICATION.md`). L0 property tests → L1 totality → L2 SMT/BMC → L3
  Lean refinement proof.

The cornerstone-preserving move: **F0 is first-class at every substrate
level**. A user running yakcc privately at `(v0.7, F0, L0)` has the full
v0.7 capability without ever touching a network. Federation features are
imported, not inherited — `@yakcc/federation` is an opt-in package, not
a default. The economic primitives at F4 live in a separate
`@yakcc/incentives` package and are isolated from everything else; a user
who wants F1/F2/F3 capability without economic exposure simply does not
install that package.

Each axis has its own document because each axis has its own design
surface and its own decision log. Substrate decisions live in
`MASTER_PLAN.md`. Verification decisions live in `VERIFICATION.md`
(DEC-VERIFY-NNN). Federation/economics decisions live in
`FEDERATION.md` (DEC-FED-NNN). The meta-commitment to the axis
decomposition itself is DEC-AXIS-017 in `MASTER_PLAN.md`.

---

## Architecture

Three package groups, organized by which axis they live on. Read the
per-package README for the full contract; this section is the map.

```
@yakcc/core                        # F0 — every yakcc deployment
├── @yakcc/contracts               # spec, canonicalization, content-address
├── @yakcc/registry                # local SQLite + sqlite-vec store
├── @yakcc/ir                      # strict-TS subset validator
├── @yakcc/compile                 # whole-program assembly
├── @yakcc/seeds                   # the ~20-block seed corpus
├── @yakcc/cli                     # `yakcc` command surface
├── @yakcc/hooks-claude-code       # facade in v0, live v0.5+
└── @yakcc/shave                   # v0.7 sub-function decomposition

@yakcc/federation                  # F1+ — opt-in (does not exist yet)
├── attestation lookup             # consult remote verifiers
├── content mirroring              # pull/push content-addressed blocks
├── attestation publishing         # F2+ — local verifier signs and propagates
└── ZK supply-chain proofs         # F3 — cryptographic artifact map

@yakcc/incentives                  # F4 — opt-in, chain-bound (does not exist yet)
├── bounty submission
├── proof-of-fuzz miner
├── stake-to-refine
└── slashing/deprecation
```

Everything currently in v0 (`contracts`, `registry`, `ir`, `compile`,
`seeds`, `cli`, `hooks-claude-code`) belongs to the `@yakcc/core` group.
The v-axis advances entirely within `@yakcc/core` — v0.7 adds
`@yakcc/shave` to the same group; v2 self-hosting is an additional build
mode in the same group. **`@yakcc/federation` and `@yakcc/incentives` do
not exist as packages yet**; they are documented here so the architecture
is coherent, and v1's federation work is what populates them. See
`FEDERATION.md` for the F-axis design.

The dependency graph is a DAG flowing `incentives → federation → core`;
nothing flows the other way. The IR validator does not know federation
exists; the registry does not know about chains. This is what makes the
F0 deployment first-class.

Substrate-internal flow within `@yakcc/core`:

```
                        +-----------------------------+
                        |    @yakcc/hooks-claude-code  |
                        |  (facade in v0, live v0.5+) |
                        +--------------+--------------+
                                       |
                                       v
                        +-----------------------------+
                        |          @yakcc/cli         |
                        |  propose | search | compile  |
                        |  registry init | block author|
                        |  shave (v0.7)                |
                        +--------------+--------------+
                                       |
   +-------------+-------------+-------+-------+-------------+
   |             |             |               |             |
   v             v             v               v             v
+--------+ +-----------+ +-----------+ +-------------+ +------+
|contracts| | registry | |  compile  | |   shave     | |  ir  |
|spec    | | SQLite + | | IR -> TS  | | (v0.7)      | |strict|
|canon.  | | sqlite-  | | whole-    | | recursive   | | TS   |
|content-| | vec      | | program   | | sub-function| |subset|
|address | | match    | | assembly  | | decomposit. | |ts-   |
|embed   | | select   | | provenance| | + atoms     | |morph |
|pipeline| |          | | manifest  | | + provenance| |      |
+---+----+ +----+-----+ +----+------+ +------+------+ +---+--+
    |           |             |              |           ^
    |           |             |              |           |
    +-----------+-------------+--------------+-----------+
                  (all blocks pass through @yakcc/ir)
```

### `@yakcc/contracts`

The shape of a contract. A `ContractSpec` declares input/output types,
behavioral guarantees, error conditions, and non-functional properties
(complexity, purity, side effects, thread safety). Canonicalization rules
make two equivalent specs hash identically. The embedding pipeline produces
a vector representation behind a provider interface — `transformers.js`
locally in v0, hosted providers swappable later.

#### Block representation: v0 transitional shape and v1+ triplet

In v0, a block is a single TypeScript file with an embedded `CONTRACT`
literal — the spec lives inside the same file as the implementation, and
`ContractId = hash(canonical-spec)`. This is the **v0 transitional
shape**. It is L0 by construction (strict-TS subset + property tests)
and was correct for v0 because the substrate did not yet need to carry
verification artifacts beyond property tests.

v1+ moves to a **cryptographic triplet** under the verification ladder:

```
Block = (spec.yak, impl.ts, proof/)
BlockMerkleRoot = MerkleRoot(spec.yak, impl.ts, proof/)
```

- **`spec.yak`** — JSON-shaped (LLM-friendly), with first-class fields
  for preconditions, postconditions, invariants, capability requirements
  (object-capability effect signature), totality witnesses, declared
  verification level, and declared SMT theory at L2.
- **`impl.ts`** — the strict-TS-subset implementation already validated
  by `@yakcc/ir`. At L1+ the totality check extends the validator; at
  L2+ the implementation must be liftable into the declared SMT theory.
- **`proof/`** — a *directory with a manifest*, not a single file. The
  manifest is a tagged-union declaration of which verification artifacts
  are present (property tests, SMT certs, Lean proofs, fuzz-bounds
  witnesses) and which checker each invokes.

Block identity becomes `BlockMerkleRoot`; the spec hash becomes an
**index** over blocks (`spec_hash → [BlockMerkleRoot, ...]`). The
selector continues to find candidate implementations by spec hash; each
candidate now carries its own verification evidence under its own
identity.

The v0 → v1+ migration is mechanical: a one-shot extraction tool walks
each seed block, parses the embedded `CONTRACT` literal via `ts-morph`,
and emits a `spec.yak` JSON file alongside the `.ts`. All ~20 v0 seeds
become L0 by construction; `proof/` is backfilled incrementally as
contributors add SMT certs or Lean proofs. **There is no parallel
authority for block identity** — once the migration completes, the v0
`ContractId = hash(spec)` model is retired, not preserved as a
transitional alias indefinitely.

See `VERIFICATION.md` for the full triplet specification, the migration
path, and DEC-VERIFY-002 / DEC-VERIFY-003 for the load-bearing
decisions.

### `@yakcc/registry`

Storage and retrieval. SQLite plus sqlite-vec in one file. Vector search
surfaces candidates for a proposal; structured matching filters those
candidates against the caller's actual needs; selection picks among matching
candidates by strictness then non-functional properties. Provenance metadata
(test history, differential execution results, runtime exposure) attaches to
contract ids; in v0 this metadata is sparsely populated, by design — the
schema has the columns, the workflows that fill them out come in v0.5+.

The registry is monotonic. `delete` is not part of its contract.

### `@yakcc/ir`

The strict TypeScript subset blocks are written in. `ts-morph` validates that
each block is free of `any`, `eval`, untyped imports, runtime reflection, and
the rest of the escape-hatch list. ESLint enforces the lighter rules. The
validator is wired into the Turbo build, so a non-conformant block fails the
pipeline rather than slipping into the registry.

Contract metadata is first-class IR syntax — error propagation, resource
ownership, and non-functional property composition are machine-readable, not
comment conventions.

### `@yakcc/compile`

Whole-program assembly. Given a top-level contract, walk sub-contracts, bind
each to a registry implementation, and emit a single TS artifact plus a
provenance manifest naming every basic block by content-address. The
compilation engine *does not generate code* — it composes pre-written blocks.
Code synthesis happens in `@yakcc/hooks-claude-code` (v0.5+), never here.

v0 ships only the TS backend. WASM landed in v1 wave-2 and wave-3.
**WASM-track update (2026-05-10):** the v1-wave-3 hand-rolled emitter
(`packages/compile/src/wasm-backend.ts` + `wasm-lowering/`) was found
to be chasing an impossible target; AssemblyScript replaced it as the
production WASM path per `DEC-AS-BACKEND-PIVOT-001` in MASTER_PLAN. The
hand-rolled emitter remains in-tree as a differential oracle pending
`WI-AS-PHASE-3` retirement (#147). LLVM/JVM are v1+. The backend
interface is real now so adding targets later is mechanical.

### `@yakcc/cli`

A thin developer surface: `propose`, `search`, `compile`, `registry init`,
`block author`. All real logic lives in the packages above; the CLI is the
adapter and the demoable artifact host. `yakcc compile examples/parse-int-list`
is the v0 acceptance check.

### `@yakcc/hooks-claude-code`

The leverage point. In v0 it shipped as a facade. In **WI-V1W2-HOOKS-01**
the package internals went live: `createHook(registry).onCodeEmissionIntent(ctx)`
queries `Registry.findCandidatesByIntent` and returns one of three typed
results — `registry-hit` (top-1 candidate beats threshold), `synthesis-required`
(no hit; emit a contract skeleton), or `passthrough` (registry-call error
only). See `DEC-HOOK-CLAUDE-CODE-PROD-001`.

**Integration-surface update (2026-05-10):** the package code is real but
the **CLI install command** (`yakcc hooks claude-code install`) is still
the v0 facade — it writes a CLAUDE.md stub instead of wiring the production
hook into Claude Code's actual integration mechanisms (slash commands,
`.claude/settings.json` hooks, MCP server). The integration-surface gap
is owned by **`WI-HOOK-LAYER` (#194)**: a Phase 0 design pass + Phase 1
telemetry-only MVP + Phase 2 smart-substitution + Phase 3 contract-surfacing
+ Phase 4 Cursor + (conditional) Phase 5 agnostic proxy. The CLI install
facade replacement is **#203**, fresh-project setup is **`yakcc init`** (#204),
and the user walkthrough is `docs/USING_YAKCC.md` (#205). v0.5's GTM thesis
("Yakcc starts paying for itself in real authoring loops") closes when
WI-HOOK-LAYER closes — see MASTER_PLAN's "Initiative: WI-HOOK-LAYER" row.

### `@yakcc/shave` (v0.7)

The sub-function decomposition engine. Input is a source tree from an
existing permissively-licensed TS/JS library; output is a *recursion
tree* of registry rows — root entries for top-level public bindings,
intermediate entries for cleanly-factorable sub-components, and leaf
atoms (single behavioral primitives) at the bottom. Every level
records provenance back to the upstream URL, commit SHA, file, line
range, original license, and parent block in the recursion tree.

The engine is AI-driven for its three model-bound steps:

1. **Intent extraction.** Two strategies. **Static (default)** — ts-morph +
   JSDoc parser; deterministic, offline, zero API cost; produces an
   `IntentCard` from explicit param/return types and JSDoc tags
   (`@requires`/`@ensures`/`@throws`). Cards are cached on disk keyed by
   source SHA so re-shaving is local and deterministic across runs.
   **LLM** (opt-in via `strategy: "llm"`) — Anthropic Haiku
   (`claude-haiku-4-5-20251001`), used when richer semantic synthesis is
   desired (e.g. property-test corpus generation under WI-016). Both
   strategies produce identical-shape `IntentCard`s and write to disjoint
   cache namespaces by construction.
2. **Decomposition proposal** (Anthropic Sonnet) — given a candidate
   block, propose whether it factors into two or more sub-blocks.
   Recursion bottoms out at atoms (the Sub-function Granularity
   Principle, see core concepts above).
3. **Property-test corpus generation.** Three extraction sources, in
   priority order: (a) upstream tests where the atom is shaved from a
   library that ships its own corpus; (b) documented usage when no
   upstream tests exist (JSDoc `@example`, README); (c) AI-derived
   against the `IntentCard` + signature as last resort (Anthropic
   Haiku/Sonnet). Each generated property test is persisted into the
   atom's `proof/manifest.json`. The manifest validator rejects atoms
   whose `property_tests` array is empty or placeholder (WI-016).

The engine is *not* a free pass past the substrate's gates. Every
shaved block passes the strict-TS IR validator. Every shaved block
has a property-test corpus that passes before ingestion. Every
shaved block gets a content-addressed identity via the same
canonicalization path as a hand-authored block. The substrate
cannot tell, at lookup time, whether a candidate came from a human,
from v0.5 synthesis, or from v0.7 shaving; only the provenance
metadata records the difference. Shaved atoms with the same
canonical contract as a hand-authored seed atom collapse to the
same content-address — the registry is a commons, not a
catalogue-of-origins.

License compatibility is enforced at the ingestion boundary.
Accepted: Unlicense, MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0,
ISC, 0BSD, explicit public-domain dedications. Refused with a
clear error: GPL/AGPL/LGPL/copyleft, proprietary, unidentifiable.
The Unlicense remains the standard for fresh contributions per the
cornerstone — shaved third-party code carries its original
license, the commons does not rewrite upstream attribution.

**`librAIrian` is a prototype reference.** The Python project at
`/Users/cris/src/librAIrian/` (Phases 0-4 + R1-R22) demonstrated
intent extraction, star-topology variance scoring, contract
design rules (safety = intersection, behavioral = majority-vote,
capability = union), permissive-license-only ingestion, and
differential testing across implementations. `@yakcc/shave` ports
those concepts in TypeScript natively. **It does not invoke
librAIrian as a subprocess, library, or service.** Future
Implementers should read librAIrian's source under `src/librairian/`
(notably `analyzer/`, `proposer/`, `validator/`, `catalog/`) as a
study reference for *how decomposition can work*, not as code to
call. yakcc is self-contained.

v0.7 gates absorption on property tests plus a focused differential
test against the upstream package's published test corpus. v1 adds
fuzz-driven differential execution at scale, surfaced as a
non-functional property on the contract id. The v0.7 demo target
is `lukeed/mri` — a permissive (MIT) ~200 LOC argv parser whose
source naturally factors into a tokenizer, flag classifier, alias
resolver, and value coercer, each of which itself decomposes into
atoms (char-class predicates, single-effect primitives) that
resemble the seed corpus. `mri` was chosen over `vercel/ms` (the
earlier candidate) precisely because `ms` is regex-monolithic and
would not exercise the recursion at all. See
DEC-DECOMPOSE-STAGE-015-CORRECTION in `MASTER_PLAN.md` for the
audit trail on this swap.

**Continuous-shave reframe.** v0.7 also widens `@yakcc/shave`'s scope
from "one-shot library ingestion" to a **universalizer pipeline that
runs at every proposal-time entry point**. The same decomposition,
canonicalization, and atom-test machinery activates inside `yakcc
compile` (every monolithic candidate is sliced before it binds) and
inside `yakcc propose` / the v0.5 hook intercept (every fresh
proposal flows through the slicer before reaching the registry).
The slicer queries `canonical_ast_hash` (the constitutional pass
owned by `@yakcc/contracts`, see "Canonicalization in core" below)
and `selectBlocks(spec_hash)` to identify existing primitives and
replaces redundant code with pointers to existing `BlockMerkleRoot`s;
only the **novel "glue"** is synthesized and stored. See
DEC-CONTINUOUS-SHAVE-022 in `MASTER_PLAN.md`.

### Canonicalization in core

A constitutional pre-ledger pass in `@yakcc/contracts` derives a
`canonical_ast_hash` from `impl.ts` (BLAKE3 over a De-Bruijn-renamed,
commutative-normalized, pure-function-flattened AST). The hash is a
sidecar to `BlockMerkleRoot`: it does not change a block's identity,
but it gates submission. A structural duplicate — same algorithm
written with different variable names, different commutative-operand
order, or different cosmetic factoring — is rejected at ingest with
the existing block's `BlockMerkleRoot` returned as the canonical
pointer. Every yakcc deployment runs this pass, F0 through F4; the
F4 economic flows (Stake-to-Refine, Bounties, batch-resolution
windows) consult it without owning it. See `VERIFICATION.md`
DEC-VERIFY-009 and `FEDERATION.md` DEC-FED-007.

### Behavioral embeddings (deferred to L1+)

At L1+ each block also carries a `behavioral_embedding` derived by
sandboxed execution of `impl.ts` against a content-addressed fuzzed
input matrix; selection-by-behavior replaces selection-by-description
for blocks that have reached L1+. L0 blocks continue to use the
textual embedding provider per DEC-EMBED-010. The behavioral
embedding closes the embedding-similarity-drift class of failures and
forecloses on the cosmetic-rewrite bounty-farming attack at search
time (DEC-VERIFY-009 closes it at submission time). Explicitly
deferred: deriving a behavioral embedding requires the expanded ocap
discipline and the L1 totality guarantee, neither of which v0.6/L0
provides. See `VERIFICATION.md` DEC-VERIFY-010.

---

## Self-hosting (v2)

A compiler is not complete until it can compile itself from scratch.
Yakcc is not complete until `yakcc shave` can be run against yakcc's
own source tree and `yakcc compile` can reassemble every package
from its content-addressed atoms. Turtles (or Yaks) all the way down.

Self-hosting is **a load-bearing future property of the build
pipeline**, not an experimental nice-to-have. It is the final test
of the cornerstone: if our own substrate cannot express its own
implementation in atomic, content-addressed terms, then the claims
this DESIGN.md makes about supply-chain minimality are claims we
exempt ourselves from. The v2 stage exists so we cannot do that.

Concretely, v2 demands:

- `yakcc shave` runs across every yakcc package
  (`@yakcc/contracts`, `@yakcc/registry`, `@yakcc/ir`,
  `@yakcc/compile`, `@yakcc/cli`, `@yakcc/hooks-claude-code`,
  `@yakcc/shave`, plus anything added between v0.7 and v2).
- The recursion bottoms out at atoms — the same atom test from
  v0.7 applies, and a v2 reviewer rejects the build if any leaf
  block fails it.
- A new "registry-assembled build" mode reassembles every package
  from registered atoms, ignoring source-tree files.
- `pnpm test` passes on both the from-source build and the
  registry-assembled build with byte-identical test output.
- The yakcc CLI binary built from registry-assembled artifacts
  behaves identically to the from-source binary on the v0
  demoable artifact and the v0.7 demoable artifact.

Things v2 explicitly does not require: federation (orthogonal —
v1's job), runtime hot-swap of registry blocks (the registry-
assembled build is a build-time property), deletion of the
from-source build (both paths remain valid), or shave-of-shave
bootstrap circularity (a research question, not a v2 exit
criterion). See DEC-SELF-HOSTING-016 in `MASTER_PLAN.md` for the
full decision rationale.

When you write code in this repo today, write it as though it will
become a registry atom tomorrow. It is going to.

---

## Why a strict subset of TypeScript is the IR

This is the load-bearing IR decision. We chose TS over Rust, over a custom
DSL, over a parser-fork-of-something-existing. The reasoning:

- **Training-data density.** Every LLM that matters has read a planet-sized
  corpus of TypeScript. The IR exists to be authored by AI and humans
  interchangeably; choosing the language LLMs already speak natively buys
  authoring quality for free.
- **Structural typing matches contract subtyping.** TypeScript's type system
  is structural, not nominal. Contract refinement is structural too. The
  match is so close that strict-TS already encodes a chunk of what we'd
  otherwise have to invent.
- **Branded types and template literal types already encode behavior.** The
  TS ecosystem has been quietly using its type system for behavioral
  contracts for years. We are not introducing a foreign concept; we are
  formalizing an existing pattern.
- **Free fallback codegen.** Strict TS transpiles to vanilla TS and runs on
  Node, Deno, and Bun today. Even before any other backend exists, every
  Yakcc-assembled program can run somewhere.
- **Toolchain leverage.** ts-morph, ESLint, the TypeScript compiler, and the
  ecosystem of editors that already understand TS all become Yakcc tooling
  for free. A custom DSL would have to ship its own LSP.

The strict subset bans `any`, `eval`, untyped imports, runtime reflection,
and the rest of the escape hatches that would defeat contract verification.
The subset is enforced by ts-morph and ESLint, not by forking the parser —
forking the parser is a v1+ conversation if it ever happens.

---

## Tradeoffs accepted for v0

| We accept | In exchange for | Revisited at |
|---|---|---|
| Local-only registry | A single-file, no-server, demoable substrate | v1 (federation) |
| TS-only backend | Single-target compile path; no native-binding ops in v0 | v1 (WASM, then native) |
| Manual block authoring | No coupling to a moving model surface; substrate trustable in isolation | v0.5 (AI synthesis), v0.7 (`yakcc shave` sub-function decomposition) |
| Facade hook | Locked install/command surface; v0.5 is behavioral not structural | v0.5 (live intercept) |
| Hand-picked seed corpus | Demoable composition story; reviewer-sized | v0.5 (corpus grows organically once hook is live) |
| Contributor-declared strictness | Tractable in v0; gameable in principle | v1 (trust layer) |
| No author identity, no signatures | Cornerstone fidelity; commons stays a commons | v1 (trust metadata as sidecar attached to immutable id) |
| Embedding latency on first run | Offline-by-default; no vendor lock-in | v0.5+ (provider swap) |
| sqlite-vec over LanceDB / pgvector | Single-file, embeddable, no-server | v1 (federation backend may differ) |

---

## Hard problems we explicitly aren't solving in v0

`MASTER_PLAN.md` carries the live deferral table.
`VERIFICATION.md` and `FEDERATION.md` now own the design surfaces that
address contract equivalence, provenance/trust, and adversarial
contributions — items that previously lived purely as deferred notes.
The summary as it applies to v0 specifically:

- **Contract equivalence is undecidable in general.** v0 relies on
  declared strictness, structural sanity checks, and shared
  property-test corpora. Near-duplicates are tolerated. The
  verification ladder in `VERIFICATION.md` (L2 SMT-decidable theories,
  L3 Lean-paired proofs) is the longer-term answer; v0 ships at L0 and
  the ladder is opt-in per block as it populates.
- **Composition is not free.** Errors, resources, and performance don't
  decompose cleanly. v0 limits seed blocks to pure, total,
  side-effect-free cases where composition is well-behaved. The
  ocap effect-signature work in `VERIFICATION.md` formalizes effect
  composition for v1+.
- **Provenance and trust.** None in v0. Public-domain commons. Trust
  mechanisms attach to immutable contract ids in a sidecar layer per
  `FEDERATION.md` (attestations from content-addressed verifiers, with
  `valid_until_revoked` semantics). v0 ships without attestations; F1+
  introduces them.
- **Adversarial contributions.** Out of scope at v0 because there is no
  shared registry to attack. `VERIFICATION.md` (verifier-as-block,
  attestation revocation, TCB hardening) and `FEDERATION.md` (Proof of
  Fuzz, deprecation-as-slashing, canonicalization engine) are the
  design surfaces that address this when a shared registry exists.
- **Seed-corpus bias.** Whatever ~20 blocks we pick will shape composition
  taste. We accept the bias and rely on v0.5's authoring loops to dilute it.
- **Sub-function granularity: when is a block atomic?** v0.7 demands
  decomposition recurse to atoms — single behavioral primitives that
  cannot be expressed as a non-trivial composition of two or more
  sub-blocks. The seed corpus pins the lower bound by example
  (`digit`, `bracket`, `comma`, `optionalWhitespace`, etc.). The
  upper bound — *when has the recursion gone too far?* — is bounded
  mechanically: at most one control-flow boundary, no further
  factorable structure, no near-duplicate of an existing registry
  atom. The hard residual problem is **near-duplicate atoms across
  decompositions of different libraries**: two libraries' `isDigit`
  predicates may differ in micro-detail (one accepts non-ASCII digit
  characters, one does not). The consolidation policy in
  `@yakcc/contracts` collapses true duplicates by content-address and
  surfaces near-duplicates as distinct contracts in the partial-
  strictness order. The gameable cases — adversarially-crafted near-
  duplicates designed to dodge the consolidation gate — are out of
  scope until v1's trust layer exists to address them.
- **LLM dependency in v0.7 (air-gap regression).** v0 is fully
  air-gappable; v0.7 introduces an Anthropic API dependency for
  intent extraction and decomposition proposals. Mitigation in the
  v0.7 plan: intent cards cached on disk by source SHA, so re-shaving
  is local. Future work: a local-LLM provider behind the same
  interface (Ollama, transformers.js text-generation) so air-gappable
  shaving becomes a supported configuration. See
  `MASTER_PLAN.md` riskiest assumption #12.

---

## How to read the rest of the repo

- `initialize.txt` — the full vision in the user's own words. Source of
  truth for *why*.
- `MASTER_PLAN.md` — staged plan, exit criteria, non-goals, live work
  items, decision log, riskiest assumptions. Source of truth for *what
  next* on the substrate (v-axis).
- `VERIFICATION.md` — the verification spine. Verification levels
  L0..L3, block-as-triplet identity, object-capability discipline,
  totality regime, SMT/BMC and Lean L3, TCB hardening, verifier-as-block.
  Source of truth for the L-axis.
- `FEDERATION.md` — the trust/scale axis. F0..F4 levels, package
  decomposition (`@yakcc/core`, `@yakcc/federation`, `@yakcc/incentives`),
  attestation protocol, F4 economic primitives (Proof of Fuzz,
  bounties, stake-to-refine), governance of the default trust list.
  Source of truth for the F-axis.
- `AGENTS.md` — orientation for AI agents who land in the repo.
- `packages/<name>/README.md` — per-package contract. The package's
  promises, its public surface, and what it does not do. (Authored
  alongside each package's first real implementation.)
- `examples/parse-int-list/` — the v0 demoable artifact. Reading it
  end-to-end is the fastest way to understand whole-program assembly.
- `tmp/` — scratch. Never `/tmp/`.

When in doubt: read the cornerstone in `MASTER_PLAN.md` and check whether
your change preserves it. If it doesn't, that is a replanning conversation,
not an implementation conversation.
