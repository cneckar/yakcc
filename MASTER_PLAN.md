# MASTER_PLAN.md — Yakcc

> Yakcc is the most ambitious yak shave in history: a massive prerequisite
> undertaking whose explicit purpose is to abolish all future yak shaves.
> We shave once, so callers never shave again.

This file is the living project record for Yakcc. It is read top-to-bottom by
every contributor — human or agent — entering the repo. The vision document at
`initialize.txt` is the source of truth for *why*; this file is the source of
truth for *what we are doing about it next*.

---

## Original Intent / Vision

This section preserves the user's original request as the immovable anchor for
all later planning. Edits below must extend, never overwrite, this record.

The user authored a vision document at `initialize.txt` and asked for a
scoping, planning, and initial-skeleton pass on a research project called
**Yakcc**. The user's own framing, in their own words:

> *Traditional software development assembles applications from large,
> generic, modular components ... A program that needs to parse a list of
> integers pulls in a full JSON library and inherits every CVE that library
> will ever have. AI-driven development has made this worse, not better ...
> Yakcc inverts this. Software is assembled from minimal, contract-addressed
> basic blocks drawn from a global registry. Each block is written exactly
> once — by the first caller who needs it — and improves monotonically over
> time as stricter or faster implementations are contributed.*
>
> *The project is named Yakcc because it is, self-evidently, the most
> ambitious yak shave in history: a massive prerequisite undertaking whose
> explicit purpose is to abolish all future yak shaves. We shave once, so
> callers never shave again.*

The user's stated deliverables for the scoping pass were:

1. Clarifying questions on anything genuinely ambiguous.
2. A staged implementation plan with milestones, exit criteria, and explicit
   non-goals per stage.
3. A monorepo skeleton (pnpm workspaces + Turborepo, matching cognitive-stack
   conventions) with placeholder packages for each component.
4. A `DESIGN.md` at the repo root capturing the philosophy and architecture in
   our own words, written so a new contributor could orient in 15 minutes.

The user's suggested staging — explicitly open to a better cut if justified:

- **v0**: local-only, TS-only, manual contract authoring, no AI synthesis.
- **v0.5**: Claude Code hook live, AI-driven contract proposal + synthesis.
- **v1**: federated registry, additional codegen targets (WASM first), Cursor
  + Codex hooks, signed contributions.

Decisions the user pre-locked before this planning pass and which the plan
must encode as decided rather than re-open:

- v0 is TS-only; WASM moves to v1.
- `@yakcc/hooks-claude-code` ships in v0 as a facade only (real command
  surface, stubbed proposal flow); v0.5 turns intercept logic on.
- No AI synthesis in v0. Unmatched proposal kicks the manual-authoring CLI
  flow.
- v0 ships a thin `yakcc` CLI: `propose | search | compile | registry init |
  block author`.
- Seed corpus: ~20 hand-authored contracts demonstrating composition,
  including the JSON list-of-ints walkthrough.
- Contract identity is the hash of the canonicalized contract spec.
  Verification evidence is separate, mutable metadata on the immutable id.
- Strictness ordering is contributor-declared, with structural sanity checks.
- Property tests use `fast-check`.
- Strict TS subset enforced via `ts-morph` + ESLint; no parser fork.
- Registry storage is SQLite + sqlite-vec.
- Embeddings are local via `transformers.js`, behind a provider interface so
  hosted providers can swap in later.
- v0 demoable artifact: `yakcc compile examples/parse-int-list` produces a
  runnable TS module plus a provenance manifest naming every block by
  content-address.
- **No author identity. No signatures. No reserved columns for either.** No
  `git config user.email` lookup. The user said: *"there is NO ownership
  allowed."* If trust mechanisms come later, they come at v1.
- License: **The Unlicense (public-domain dedication)** across the entire repo
  and every registered block. The user's exact phrasing was *"MIT or even more
  permissive license for all (there is NO ownership allowed)"* — the Unlicense
  is the strongest interpretation of that requirement available, because it is
  an explicit dedication of the work to the public domain rather than a
  permissive copyright license that still presupposes an owner. 0BSD and CC0
  were the alternative finalists; the user chose the Unlicense over 0BSD.

One open question the user did not resolve and which the plan must surface
rather than answer: **the cognitive-stack monorepo conventions document was
not provided.** The scaffold defaults to mainstream pnpm + Turborepo idioms
pending that document.

---

## Identity

**Name.** Yakcc — a content-addressed registry of minimal, behaviorally-specified
basic blocks, a strict-TypeScript intermediate representation, and a compilation
engine that assembles whole programs by composing those blocks. The double-c is
a nod to GCC.

**Thesis.** Software today is assembled from generic libraries that import vast
attack surface their callers never exercise, and AI coding agents make this
worse by reflexively reimplementing the same minor functions ten million times.
Yakcc inverts both failure modes: every basic block is written exactly once,
identified by its behavioral contract, registered in a monotonic version-free
commons, and reused by every future caller — human or AI — that needs that
contract or anything looser than it.

**Audience.** v0 is a substrate for ourselves and a small ring of early
contributors. We are not shipping a product yet; we are shipping the seed
crystal that future Yakcc authoring loops grow from.

---

## Cornerstone (do not violate without explicit replanning)

These are the load-bearing invariants. Drift on any of them and the project
stops being Yakcc.

1. **No versioning.** There is no semver, no `latest`, no breaking-change event.
   Implementations are identified by the canonical hash of their contract spec.
   Newer entries win selection by advertising stricter contracts or better
   non-functional properties; older entries are never deleted.
2. **No ownership.** The registry is a public-domain commons. There is no
   `author_email`, no `signature`, not even reserved columns for them. The
   entire repo and every registered block is dedicated to the public domain
   under **The Unlicense**, the strongest available expression of the user's
   "no ownership allowed" requirement. If trust mechanisms come later, they
   come with their own design pass — they do not sneak in as defaults today.
3. **Content-addressed contracts.** A contract's identity is the hash of its
   canonicalized spec. Verification evidence (tests passed, differential
   execution results, formal claims) is mutable metadata attached to the
   immutable id. Identity and trust are different things.
4. **Embedding is just an index.** Vector similarity surfaces candidates. It
   never decides correctness. Selection is governed by structured contract
   matching plus declared strictness, never by cosine distance.
5. **Composition from minimal blocks.** A list-of-ints JSON parser composes an
   integer-recognizer, a bracket-matcher, and a comma-separator. We do not
   accept blocks that pull in JSON-the-language attack surface to parse a list
   of ints. Minimum-viable code is the *point*, not a stretch goal.
6. **Monotonic registry.** Add, never delete. Strictness comparisons and
   non-functional properties decide which contract a caller binds to today.
   Yesterday's entries remain queryable forever.

When any future change asks "should we relax one of these for v0?", the answer
is no. v0 either honors them or v0 is not Yakcc.

---

## Repo Conventions

- **Monorepo.** pnpm workspaces + Turborepo. Defaults follow modern pnpm/Turbo
  idioms; see Open Questions for the cognitive-stack alignment caveat.
- **Strict TypeScript everywhere.** `strict: true`, no `any`, no implicit any,
  no untyped imports, no runtime reflection. The IR is a stricter subset still
  (see WI-004); the toolchain itself is held to `tsc --strict`.
- **Facade-first.** A package that does not yet have its full backend ships a
  real, typed interface and plausible stub responses. No `TODO`, `placeholder`,
  or "not implemented yet" strings cross a package boundary.
- **One contract README per package.** Each package documents its own contract:
  what it promises, what it does not, what its public surface is.
- **License.** **The Unlicense** (public-domain dedication) across the entire
  repo and every block registered into the commons. The Unlicense is a
  public-domain dedication rather than a permissive copyright license, which
  matches the cornerstone's "no ownership" requirement more precisely than
  0BSD or MIT — it asserts that no copyright is being retained at all, rather
  than retaining copyright and then waiving most of its consequences.
- **No `/tmp/`.** All scratch goes in `tmp/` at the repo root.
- **Main is sacred.** Source work happens on branches/worktrees and lands
  through Guardian. The orchestrator does not write source on `main`.

---

## Architecture (one paragraph; full detail in DESIGN.md)

Yakcc has three orthogonal axes: substrate maturity (this document, v0..v2), verification rigor (`VERIFICATION.md`, L0..L3), and trust/scale participation (`FEDERATION.md`, F0..F4); a user sits at any `(v, F, L)` coordinate, and the F0 single-machine deployment is first-class at every substrate level. Seven packages. `@yakcc/contracts` defines what a contract *is* and how it
canonicalizes to a content-address. `@yakcc/registry` stores contracts and
implementations in SQLite + sqlite-vec, performs vector candidate retrieval and
structured matching, and resolves selection. `@yakcc/ir` defines the strict
TypeScript subset and validates blocks against it via ts-morph + ESLint.
`@yakcc/compile` performs whole-program assembly: given a top-level contract,
walk sub-contracts, bind each to a registry implementation, and emit a single
artifact plus a provenance manifest. `@yakcc/cli` exposes the developer
surface (`propose`, `search`, `compile`, `registry init`, `block author`).
`@yakcc/hooks-claude-code` is the leverage point — in v0 it ships as a facade
(real command surface, stubbed proposal flow); in v0.5 it intercepts AI
emission and reroutes through the registry. `@yakcc/shave` (v0.7) is the
sub-function decomposition engine: input is a source tree from an existing
permissively-licensed TS/JS library; the engine recursively decomposes each
exported binding until it bottoms out at atomic blocks (single behavioral
primitives indistinguishable in shape from the hand-authored seed corpus),
then ingests every level of that recursion as registry rows with full
provenance back to the source (URL, commit SHA, file, line range, original
license). Each absorbed block passes the same gates as fresh blocks: strict
TS subset, property tests, content-addressed identity. The supply-chain
promise — "you get exactly what you asked for, with no attached attack
surface" — only becomes real when the registry can absorb the existing
ecosystem at sub-function granularity; `@yakcc/shave` is that bootstrap path.
**`librAIrian` (`/Users/cris/src/librAIrian/`) is a Python prototype of the
concepts here, not a runtime dependency**: yakcc is self-contained, TS-only,
and re-implements the relevant ideas natively (intent extraction,
star-topology variance, contract design rules) without invoking the Python
artifact at runtime. See DEC-DECOMPOSE-STAGE-015 and DEC-SELF-HOSTING-016.

---

## Stages

### v0 — Local TypeScript substrate

**Thesis.** Stand up the minimum machine that can demonstrate the cornerstone
end-to-end on one developer's laptop, with hand-authored contracts and zero AI
synthesis. Everything is local; everything is TS-only. The point of v0 is to
prove the substrate is real before anyone is asked to live inside it.

**In scope.**

- Contract schema, canonicalization, content-address derivation
  (`@yakcc/contracts`).
- SQLite + sqlite-vec registry with vector candidate retrieval, structured
  matching, strictness-aware selection, and a provenance manifest emitter
  (`@yakcc/registry`).
- Strict-TS IR validator (ts-morph + ESLint), wired into the Turbo build
  (`@yakcc/ir`).
- TS backend and whole-program assembly (`@yakcc/compile`).
- Seed corpus: ~20 hand-authored contracts demonstrating composition, including
  the full chain for `examples/parse-int-list`.
- `yakcc` CLI: `propose | search | compile | registry init | block author`.
- `@yakcc/hooks-claude-code` as a **facade only** — real slash-command surface
  and project config; proposal flow is stubbed and exits with a clear "v0.5
  feature" path. The facade ships so the v0.5 turn-on is a behavioral change,
  not an interface change.
- Local embeddings via `transformers.js`, behind a provider interface so
  hosted providers can swap in later.
- Property-test infrastructure on `fast-check`.

**Exit criteria (each is a concrete, demoable check, not a vague claim).**

1. `pnpm install && pnpm build` from a clean clone produces a green Turbo
   pipeline including IR validation across all packages.
2. `yakcc registry init` creates a fresh local SQLite registry and ingests the
   ~20-block seed corpus, emitting one row per contract with a stable
   content-address that round-trips through `yakcc search`.
3. `yakcc compile examples/parse-int-list` produces a runnable TS module that
   parses `"[1,2,3]"` to `[1,2,3]` on Node, plus a provenance manifest naming
   every basic block by content-address. Re-running the command on an
   unchanged registry produces a byte-identical artifact and manifest.
4. The compiled `parse-int-list` module imports zero runtime dependencies
   beyond what the seed blocks themselves require — no JSON library, no
   parser-combinator framework. The supply-chain claim is demonstrable, not
   rhetorical.
5. The Claude Code hook facade is installable into a Claude Code project
   (`yakcc hooks claude-code install`), exposes the documented slash command,
   and returns the stubbed-flow message without throwing.
6. The seed corpus passes its full property-test suite under `fast-check`.
7. A new contributor can run a single documented command sequence from the
   repo README and reach exit criterion 3 in under 15 minutes on a clean
   machine.

**Non-goals (explicit, with reasoning).**

- *No AI synthesis.* An unmatched proposal kicks the manual-authoring CLI flow
  (`yakcc block author`). Synthesis lives in v0.5; baking it in now would
  couple the substrate to a moving model surface before the substrate is
  trustworthy.
- *No WASM backend.* The TS backend is the fallback codegen path and is
  sufficient to prove the architecture. WASM moves to v1.
- *No federation.* The registry is single-machine. The data model must not
  preclude federation, but no networking ships in v0.
- *No author identity, no signatures, no trust metadata.* The cornerstone
  forbids it. Trust mechanisms are a v1 design pass.
- *No additional hooks (Cursor, Codex).* Claude Code is where we live. Other
  hooks ride the same proposal protocol once it's proven.
- *No generic-library temptations.* If a narrower dependency exists, we use
  the narrower one. Yakcc cannot ship its own substrate by importing the
  problem it claims to solve.

### v0.6 — Triplet substrate (block-as-cryptographic-triplet migration)

**Thesis.** v0 modeled a block as a single `.ts` file with an embedded
`CONTRACT` literal, identified by `ContractId = hash(canonical-spec)`. The
verification ladder in `VERIFICATION.md` (DEC-VERIFY-002, DEC-VERIFY-003)
demands a richer shape: every block is a directory triplet
`(spec.yak, impl.ts, proof/)` whose identity is the Merkle root of those
three artifacts, and the spec hash demotes from identity to selector index.
v0.6 is the substrate-shape bridge that makes the v0 demo conform to the
verification paradigm without yet adding L1+ checks. It is not a new
capability stage; it is a foundation upgrade that v0.5 (live AI synthesis)
and v0.7 (`yakcc shave`) both build on. Sacred Practice #12 (single source
of truth) requires the inline-`CONTRACT`-literal mechanism to be **removed**
in this stage, not preserved alongside the triplet form.

This stage is **L0-only**. L1 totality, L2 SMT, L3 Lean, and the expanded
ocap banishment list from `VERIFICATION.md` are deferred to a later
substrate stage (likely paired with v1 federation or as their own L-axis
work). v0.6 ships the triplet *shape* and the L0 verifier (existing
strict-TS subset + existing fast-check property tests, repackaged as the
`property_tests` artifact in `proof/manifest.json`).

**In scope.**

- `spec.yak` JSON schema and validator in `@yakcc/contracts`. Required fields
  per `VERIFICATION.md` §spec.yak: `name`, `inputs`, `outputs`,
  `preconditions`, `postconditions`, `invariants`, `effects`, `level`. At L0
  every seed declares `effects: []` and `level: "L0"`. Pre/post/invariants
  may be empty arrays for now (the existing `behavior` + `guarantees` +
  `errorConditions` from v0's `ContractSpec` map cleanly to these fields).
  Optional level-dependent fields (`theory`, `bounds`, `totality_witness`,
  `proof_kind`, `constant_time`) are accepted but unused at L0.
- `BlockMerkleRoot` derivation in `@yakcc/contracts`. Concrete encoding
  decided in this stage and recorded as `@decision` at the implementation
  site: at L0, `impl_hash = BLAKE3(impl.ts file bytes)` (deterministic
  ts-morph normalization is deferred to L1+ where the totality pass
  normalizes the AST anyway); `proof_root = BLAKE3(canonical(manifest.json)
  || hash(artifact_1) || ... || hash(artifact_N))` with manifest order
  authoritative; `BlockMerkleRoot = BLAKE3(spec_hash || impl_hash ||
  proof_root)`. Property-tested for determinism on every triplet across
  re-builds.
- Directory-based block authoring in `@yakcc/ir`. `parseBlockTriplet(dir)`
  replaces `parseBlock(source)`. Reads the three artifacts, runs the existing
  strict-subset validator on `impl.ts`, validates `spec.yak` against the
  schema, validates `proof/manifest.json` against the L0 manifest schema
  (must declare exactly one `property_tests` artifact). The CONTRACT-literal
  extractor (`packages/ir/src/annotations.ts`) is **removed**.
- Registry schema migration in `@yakcc/registry`. The `contracts` and
  `implementations` tables are replaced by a single `blocks` table keyed by
  `block_merkle_root` with a non-unique `spec_hash` index. Selection moves
  from `selectImplementation(contractId)` to
  `selectBlocks(specHash) → BlockMerkleRoot[]`. The migration is a clean
  schema bump (DEC-NO-PARALLEL-AUTHORITY); the seed corpus has not been
  published externally so its content-addresses re-derive cleanly.
- Compile resolver update in `@yakcc/compile`. `resolveComposition` walks
  the graph by `BlockMerkleRoot`; sub-block references in `impl.ts` resolve
  through `spec_hash → [block_merkle_root]` (at L0-only, exactly one match
  per spec_hash for the seed corpus). The provenance manifest emits
  `BlockMerkleRoot` plus `spec_hash` for each entry. Byte-identical re-emit
  on an unchanged registry is preserved.
- Seed corpus migration in `@yakcc/seeds`. Each of the 20 hand-authored
  blocks becomes a directory `packages/seeds/src/blocks/<name>/` with
  `spec.yak`, `impl.ts`, and `proof/manifest.json`. Existing fast-check
  property tests are repackaged as the `property_tests` artifact named in
  the manifest. The seed loader (`packages/seeds/src/seed.ts`) walks block
  directories and uses `parseBlockTriplet`.
- Demo migration in `examples/parse-int-list`. The existing
  `examples/parse-int-list/contract.json` becomes
  `examples/parse-int-list/spec.yak` (rename + addition of required v1
  fields). A new `examples/parse-int-list/proof/manifest.json` declares the
  existing property-test artifact. `yakcc compile examples/parse-int-list`
  produces a runnable module that parses `"[1,2,3]"` to `[1,2,3]` and a
  provenance manifest naming every block by `BlockMerkleRoot`.
- Plan re-anchoring (executed inline in this planning slice). v0.7's
  WI-010..WI-015 wording is updated to reference triplet shape, not inline
  `CONTRACT` literals. DEC-IDENTITY-005 receives an amendment cross-
  referencing DEC-VERIFY-002.

**Exit criteria (each is a concrete, demoable check, not a vague claim).**

1. `pnpm install && pnpm build` from a clean clone produces a green Turbo
   pipeline. The strict-TS subset validator runs against every seed's
   `impl.ts`, not against legacy `.ts`+`CONTRACT` files.
2. `yakcc registry init` ingests the 20-block seed corpus as triplets,
   emitting one row per block in the new `blocks` table with a stable
   `block_merkle_root` and a `spec_hash` index entry. Re-running `yakcc
   registry init` on a clean DB produces byte-identical Merkle roots
   (determinism property test).
3. `yakcc compile examples/parse-int-list` produces a runnable TS module
   that parses `"[1,2,3]"` to `[1,2,3]` on Node, plus a provenance manifest
   naming every block by `BlockMerkleRoot` with its `spec_hash` recorded
   alongside. Re-running on an unchanged registry produces a byte-identical
   artifact and manifest (the v0 byte-identical invariant is preserved).
4. The compiled `parse-int-list` module imports zero runtime dependencies
   beyond what the seed blocks themselves require. The supply-chain claim
   remains demonstrable.
5. The full pre-existing test suite survives the migration: the 28 CLI
   tests, the seed corpus property tests under `fast-check`, the `@yakcc/ir`
   strict-subset tests, the `@yakcc/contracts` canonicalization tests, the
   `@yakcc/registry` storage and selection tests, and the `@yakcc/compile`
   resolve / assemble tests must all pass green at every work-item boundary.
   New tests are added for `spec.yak` schema validation, `proof/manifest.json`
   schema validation, MerkleRoot determinism, and `parseBlockTriplet`
   directory parsing.
6. The inline-`CONTRACT`-literal reading code (`packages/ir/src/annotations.ts`,
   the `BLOCK_FILES` flat list in `packages/seeds/src/seed.ts`, the
   `parseBlock(source)` signature in `packages/ir/src/block-parser.ts`, and
   any `extractContractFromAst` callers) is **removed** in this stage. There
   is no reading of `export const CONTRACT` literals after WI-T05 lands. A
   grep over `packages/` for `extractContractFromAst` and `export const
   CONTRACT` returns empty.
7. The 7 v0 stage exit criteria are re-validated under the triplet shape and
   recorded as still passing in WI-T06's acceptance evidence.

**Non-goals (explicit, with reasoning).**

- *No L1 totality check.* The `level: "L0"` declaration is the floor. L1
  requires structural-recursion analysis or fuel parameters; the seed corpus
  is naturally L1-shaped but the syntactic checker is its own work. Defer to
  a later L-axis stage.
- *No L2 SMT or L3 Lean.* Same reason — out of v0.6 scope. `spec.yak` accepts
  the optional `theory`, `proof_kind`, `bounds` fields without enforcing
  them; an L0 block that declares them is silently L0 (no upgrade path until
  the higher-level checkers ship).
- *No expanded ocap banishment list.* `VERIFICATION.md` §"Static banishment
  list" extends the v0 banlist (no `Math.random`, no `Date.now`, no module-
  level mutable bindings, etc.). The current `@yakcc/ir` validator already
  bans `any`, `eval`, untyped imports, runtime reflection, dynamic property
  access on caps. Keeping the existing banlist for v0.6; the expansion is
  paid-for at the L1+ ocap-discipline stage.
- *No `proof/` artifact kinds beyond `property_tests`.* `smt_cert`, `lean_proof`,
  `coq_proof`, etc. are valid schema entries but rejected by the L0 manifest
  validator. They become accepted at L2/L3 stages.
- *No federation or attestation surface.* Attestations live in F2+
  (`FEDERATION.md`); this stage produces blocks ready to be attested but
  ships no attestation table.
- *No verifier-as-block.* The verifier is internal to `@yakcc/ir` and
  `@yakcc/contracts` for v0.6; making it content-addressed is a v1+ work
  item.
- *No proof-checker plumbing.* L0 has only property tests; the existing
  fast-check runner is the checker.

**Demoable artifact.**

```
yakcc registry init                                  # ingests 20 triplet blocks
yakcc compile examples/parse-int-list                # emits dist/module.ts + provenance
node examples/parse-int-list/src/main.js             # → [1, 2, 3]
cat examples/parse-int-list/dist/manifest.json       # every entry is a BlockMerkleRoot
```

The provenance manifest and the byte-identical re-emit invariant are the
two things that change visibly: every entry now carries `block_merkle_root`
plus `spec_hash`, and the `block_merkle_root` is reproducible from the
on-disk triplet bytes.

### v0.5 — Hooks live, AI synthesis on

**Thesis.** Turn the Claude Code hook from facade into live interceptor and
introduce AI-driven contract synthesis for unmatched proposals. v0.5 is when
Yakcc starts paying for itself in real authoring loops.

**In scope.**

- Live proposal interception in `@yakcc/hooks-claude-code`: agent's "I need to
  write code that does X" moment is rerouted into the registry.
- AI synthesis path for unmatched proposals (model-backed, contract-conditioned
  emission into the strict-TS IR, validated before registration).
- Differential execution tooling so newly-synthesized blocks can be compared
  against existing candidates.
- Telemetry on hit/miss/synthesize ratios so we can see whether the substrate
  is actually displacing inline emission.

**Exit criteria.**

1. With the hook active in a real Claude Code session, asking for a function
   whose contract is in the registry produces a registry-bound reference, not
   inline code.
2. Asking for an unmatched function produces a synthesized block that passes
   IR validation and the auto-generated property-test scaffold, and is
   ingested into the local registry on acceptance.
3. Hit/miss/synthesize counts are queryable via `yakcc telemetry`.

**Non-goals.** Federation. Cursor/Codex hooks. Trust metadata. Sub-function
decomposition / `yakcc shave` (v0.7). Large-scale differential execution
against original libraries (v1). Self-hosting (v2).

### v0.7 — Sub-Function Decomposition (`yakcc shave`)

**Thesis.** Yakcc absorbs existing libraries by recursive sub-function
decomposition until each emitted block is atomic — a single behavioral
primitive indistinguishable in shape from the hand-authored seed corpus
(`bracket`, `digit`, `comma`, `optionalWhitespace`, etc.). v0 proved the
substrate; v0.5 proved AI synthesis into it; v0.7 proves the substrate can
ingest the working ecosystem at the granularity the cornerstone demands.
This is the stage where the supply-chain thesis stops being theoretical:
ask for `parseArgv`, get just the tokenizer / flag-classifier /
value-coerce atoms — not the rest of the parser, and certainly not the
rest of the package.

**`librAIrian` is a prototype reference, not a runtime dependency.** The
Python project at `/Users/cris/src/librAIrian/` (Phases 0-4 + R1-R22) is
a working prototype of intent extraction, star-topology variance, and
contract design rules. v0.7 *ports the concepts in TypeScript inside
`@yakcc/shave`* against the Anthropic SDK directly. No Python in the
runtime path. Future Implementers should study the librAIrian source
tree as a reference for *how to think about decomposition*, not as code
to invoke.

**Sub-function Granularity Principle (load-bearing).** librAIrian's
contracts are function-shaped — they describe what a function does. Yakcc
goes deeper. Decomposition recurses on every emitted contract. A candidate
block stops decomposing only when it cannot be expressed as a non-trivial
composition of two or more sub-blocks. The fixed point of the recursion is
**atomic blocks**: a single behavioral primitive, a single bounded effect,
no nested control-flow boundaries that themselves factor cleanly. Examples
from the seed corpus that define "atomic": `digit` (one char-class
predicate), `bracket` (one char equality + position advance), `comma`
(same shape as bracket, different literal). Examples that are **not**
atomic and must recurse further: anything resembling `parseIntList`,
which decomposes into the seven primitives the human author used.

A v0.7 reviewer must reject `shave` output where `parseArgv` ingests as a
single block. "Did not reach atoms" is a v0.7 failure mode, not "good
enough." The atom test is mechanical (see WI-012):
1. AST analysis identifies control-flow boundaries (loops, conditionals,
   try/catch, early returns).
2. A block is a candidate atom if it has at most one such boundary and
   that boundary's body does not itself contain a non-trivial sub-block
   already in the registry.
3. Pure-data tables, single-predicate char classes, and single-effect
   primitives (one read, one write, one throw) are atoms by construction.
4. When the LLM proposes a decomposition that would create cycles or
   atom-near-duplicates already in the registry, the consolidation policy
   in `@yakcc/contracts` collapses the duplicate to the existing
   content-address before ingestion.

**In scope.**

- `@yakcc/shave` package (`packages/shave/`). Public API:
  `shave(sourcePath, registry, options): Promise<ShaveResult>`. The result
  is a tree, not a flat list — the recursion structure is preserved so
  callers can see "this `parseArgv` block decomposed into these 6 atoms."
- **Intent extraction (ported from librAIrian).** For each candidate unit,
  the engine calls Anthropic Haiku (`claude-haiku-4-5-20251001`) with the
  unit source and surrounding context, receives a structured intent card
  (purpose, inputs, outputs, error semantics, side effects, security
  posture). Intent cards are cached on disk keyed by source SHA so
  re-shaving is local and deterministic across runs (mitigates the
  air-gap regression — see Riskiest Assumptions).
- **Star-topology variance scoring (ported from librAIrian).** When two
  or more candidate units across different libraries appear contract-
  shaped-similar (embedding-clustered), the engine compares each against
  a chosen canonical with the 7-dimension weighting from librAIrian:
  security 0.35, behavioral 0.25, error_handling 0.20, performance 0.10,
  interface 0.10. CWE-474 family mapping informs the security dimension.
  These weights are inherited verbatim from librAIrian's R-series; see
  DEC-DECOMPOSE-STAGE-015 correction.
- **Contract design rules (ported from librAIrian).** When multiple
  candidates satisfy the same shape: safety = intersection,
  behavioral = majority-vote, capability = union. These rules govern
  how `shave` proposes the *registered* contract from the cluster of
  observed implementations.
- **Recursive decomposition.** After contract proposal, the engine asks
  the LLM (Sonnet) "can this block be expressed as a composition of two
  or more sub-blocks?" If yes, recurse. The recursion bottoms out per
  the Sub-function Granularity Principle above.
- **Property-test corpus per level.** Every block at every level of the
  recursion arrives with a property-test corpus that passes before
  ingestion. Extracted from upstream tests where adaptable; synthesized
  from documented usage where tests are absent; AI-derived against the
  proposed contract as last resort.
- **Provenance per level.** Each ingested block records source URL,
  commit SHA, file path, line range, original license, and parent block
  in the recursion tree. Atoms decomposed from `parseArgv` cite the same
  source line span as their parent, plus the AST-node sub-range they
  represent.
- **License compatibility (permissive only).** Accept only Unlicense,
  MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, ISC, 0BSD, public-domain
  dedications. Refuse GPL/AGPL/LGPL/copyleft, proprietary, and
  unidentifiable licenses with a clear error citing the detected
  license string. Fresh contributions remain Unlicense per
  DEC-LICENSE-012; absorbed code retains its original license as
  metadata, no relicensing.
- **Differential testing across implementations.** When the registry
  already holds a block satisfying the same contract from a different
  source, `shave` runs a differential test (same property-test corpus
  exercised against both) before ingesting the new candidate, surfacing
  divergences as a non-functional property on the new entry.
- **CLI surface.** `yakcc shave <path-or-url> [--registry <p>]` runs the
  recursion and ingests results. `yakcc search "argv tokenizer"` returns
  shaved-from-mri atoms alongside hand-authored ones. `yakcc compile
  <id>` works identically against atoms regardless of origin.
- **Selection-signal augmentation.** When the registry holds a hand-
  authored atom AND a shaved atom satisfying the same contract, default
  tie-break is stricter-contract-wins, then declared non-functional
  properties; users may force a preference via flag (`--prefer
  hand-authored`, `--prefer shaved`).

**Demo target — `mri`** (lukeed/mri, MIT, ~200 LOC, TS-friendly minimal
argv parser). Chosen over `vercel/ms` (the previous pick) because `ms` is
monolithic-regex-shaped and would not exercise the Sub-function
Granularity Principle — it ingests as one block and never recurses. `mri`
naturally factors into a tokenizer, flag-shape classifier, alias
resolver, value-coercer, and a result-shape assembler — each of which
itself decomposes into atoms (char-class predicates, single-effect
primitives) that resemble the seed corpus. @decision: see Riskiest
Assumptions for why this target swap is the most load-bearing v0.7
choice.

**Exit criteria.**

1. `yakcc shave ./vendor/mri` (a local clone of lukeed/mri at a pinned
   commit) ingests `mri`'s public surface into a fresh registry as a
   recursion tree, not a flat list.
2. The recursion bottoms out at atoms. A reviewer can pick any leaf
   block in the result tree and verify it satisfies the atom test
   (single behavioral primitive, no further non-trivial decomposition
   available).
3. Every block at every level passes its property-test corpus.
4. `yakcc compile <mri-parse-id>` produces a runnable module that
   matches `mri`'s actual behavior on the published test corpus (the
   existing `mri` test file, run against the assembled artifact and
   the upstream package, with identical output on every case).
5. The provenance manifest names `lukeed/mri@<commit-sha>`, the file,
   the line range, **and the parent block** for every non-root block.
6. Atoms emitted by `shave` are queryable indistinguishably from
   hand-authored atoms: `yakcc search "ascii digit predicate"` returns
   both the hand-authored `digit` and any shaved equivalent, ranked by
   the existing selection logic.
7. License gate refuses a deliberately-prepared GPL-licensed input
   with a clear error message naming the detected license.
8. Intent-card cache hit on a repeated `yakcc shave ./vendor/mri` run
   completes without any Anthropic API calls (verified by network
   sandboxing during the test).

**Demoable artifact.**

```
yakcc shave ./vendor/mri --registry ./.yakcc/registry.sqlite \
  && yakcc compile <mri-parse-id> \
  && node ./yakcc-out/module.js --foo bar -x 1
# => { _: [], foo: 'bar', x: 1 }
# manifest credits lukeed/mri@<commit> for the root and every atom,
# with parent-block links forming the recursion tree.
```

**Non-goals (explicit, with reasoning).**

- *No differential execution against the original library at scale.*
  v0.7 runs a focused differential test on the existing `mri` test
  corpus. Large-scale fuzz-driven differential execution is a v1
  hardening pass alongside federation's trust mechanisms.
- *No native-code library decomposition.* C, Rust, Go libraries are
  out of scope. The IR is strict TS; the input must be expressible
  in it.
- *No dynamic-language library decomposition.* Python, Ruby, et al.
  are out of scope. TS/JS-only input.
- *No federation of shaved corpora.* Federation is v1. v0.7 is
  local-only, same as v0.
- *No re-licensing.* Upstream license is recorded; the commons does
  not rewrite attribution.
- *No round-trip shave-then-reassemble-byte-equal-upstream guarantee.*
  Impossible in general (whitespace, identifier choice, transitive
  inlining all change byte output); explicitly not a goal.
- *No automatic absorption of every resolvable package.* `yakcc shave`
  runs only on explicit invocation against an explicit source target.
- *No copyleft ingestion, even partial, even with a flag.* The
  permissive-only gate is structural.

### v1 — Federation, additional targets, additional hooks, faithful absorption

**Thesis.** Make the commons real: a federated registry, additional codegen
targets starting with WASM, hooks beyond Claude Code, the first concrete
trust mechanisms, and large-scale differential-execution validation of
v0.7's shaved blocks against upstream sources.

**In scope.**

- Federated registry protocol with content-address-based replication and
  conflict-free monotonic merging.
- WASM backend in `@yakcc/compile`.
- `@yakcc/hooks-cursor` and `@yakcc/hooks-codex`.
- A trust-metadata layer that stays compatible with the cornerstone (the layer
  attaches to the immutable contract id; identity is still hash, not signer).
- Large-scale differential-execution validation of v0.7-shaved blocks
  against their upstream library sources (fuzz-driven, beyond the focused
  per-target test corpus run during v0.7), surfaced as a non-functional
  property on the contract id. This is what lets a caller distinguish
  "shaved and locally property-tested" from "shaved and behaviorally
  indistinguishable from upstream on a large corpus."

**Exit criteria.** TBD at end of v0.5; the v1 design pass is itself the next
planning artifact, not a v0 deliverable.

**Non-goals.** Native (LLVM/JVM) backends — those are v1+ at the earliest.
Self-hosting (yakcc shaving itself) — that is v2.

### v2 — Self-Hosting (Turtles all the way down)

**Thesis.** A compiler is not complete until it can compile itself from
scratch. Yakcc is not complete until `yakcc shave` can be run against
yakcc's own source tree and `yakcc compile` can reassemble every package
from its content-addressed atoms. The code emitted by today's
implementers becomes, at v2, just basic blocks in the registry. Turtles
(or Yaks) all the way down.

This stage is the final test of the cornerstone: if our own substrate
cannot be expressed in our own substrate, we have not built what we
claim. Self-hosting is a property of the build pipeline, nothing more
and nothing less. It is not an experimental nice-to-have — it is the
proof point that the substrate is real.

**In scope.**

- `yakcc shave packages/contracts/src/canonicalize.ts` (and every other
  yakcc source file) produces atomic blocks for the primitives that
  compose those modules — sortKeys, JSON canonicalization helpers,
  hash derivation, ts-morph traversal predicates, SQLite row mappers,
  etc. The atom test from v0.7 (single behavioral primitive, no further
  non-trivial decomposition) gates each emitted block.
- The same recursion is applied to every package in the repo:
  `@yakcc/contracts`, `@yakcc/registry`, `@yakcc/ir`, `@yakcc/compile`,
  `@yakcc/cli`, `@yakcc/hooks-claude-code`, `@yakcc/shave`, plus any
  packages added between v0.7 and v2.
- `yakcc compile @yakcc/<pkg>` reassembles each package from its
  registered atoms, producing a single TS artifact per package, plus a
  whole-repo provenance manifest.
- A new build mode — call it the "registry-assembled build" — that
  ignores the source-tree files and assembles every package purely
  from registry rows.

**Why this is the strongest demo.**

Self-hosting exercises every subsystem simultaneously: IR conformance (every
yakcc atom passes the hard-ban rules), atom decomposition (the shave recursion
correctly bottoms out), slicer correctness (DFG slice covers the real call
graph), canonicalizer determinism (same source → same hash across runs and
machines), compile assembly (the whole-program assembler produces a runnable
artifact), property-test coverage (every atom carries a non-placeholder test),
and foreign-block boundary (all external deps are correctly typed as opaque
leaves). If yakcc shaves itself byte-identically across two passes, anything
users shave is at least as trustworthy — the demo is both a completion criterion
and an ongoing regression gate.

**Current readiness baseline (per IR conformance audit 2026-05-01).**

75 yakcc source files were audited for IR conformance (excluding `*.test.ts`,
`*.d.ts`, `node_modules`, `dist`, `__fixtures__`, `__snapshots__`). Results:

- **Hard rules (no-any, no-eval, no-runtime-reflection, no-with,
  no-throw-non-Error): 0 violations** across all 75 files. Yakcc's source is
  already clean on every binary-pass/fail IR property.
- **Real soft violations: 4 total** (2 mutable-global singletons in
  `packages/contracts/src/embeddings.ts` lines 49 and 113; 2 top-level-side-
  effects in `packages/ir/src/strict-subset-cli.ts` line 111 and
  `packages/cli/src/bin.ts` line 7). All four are pinpoint fixes.
- **False positives: 233 `no-untyped-imports`** reported — artifact of running
  the validator in isolated-file mode (no `tsconfig.json` paths, no
  `node_modules`, no workspace-alias resolution). These are "I cannot see the
  dependency type" errors, not genuine untyped code. A whole-project validator
  mode (WI-V2-01) is required before the real count can be determined.
- **Revised timeline: 3-6 months past v1 wave-2 close** (was 6-12 months).
  Yakcc's source is more disciplined than earlier estimates assumed.

Full audit findings: `~/.claude/plans/v2-ir-conformance-audit.md`.

**Exit criteria (v2 acceptance).**

1. **Two-pass bootstrap equivalence.** Compiled yakcc shaves the original yakcc
   source; resulting `BlockMerkleRoot`s are byte-identical to first-pass blocks.
   Fixed-point self-hosting surfaces every non-determinism in the canonicalizer
   or hashing path — this is the most valuable regression test the project has.
2. **Recomposed yakcc passes the original yakcc test suite.** `yakcc compile
   <yakcc-entry>` produces a TS module that, when run, behaves equivalently to
   the original yakcc on every test in the suite.
3. **Foreign-block boundary holds.** Every yakcc dependency on `node:*`,
   `ts-morph`, `sqlite-vec`, `@noble/hashes`, `@anthropic-ai/sdk`, `fast-check`,
   etc. is recorded as a foreign-block triplet; provenance manifest records the
   foreign-dep tree per non-foreign block.
4. **Property-test coverage on every yakcc atom.** Every atom carries a
   non-placeholder `property_tests` artifact (per WI-016 contracts).
5. **Hard rules pass 100%** across all yakcc source: no `any`, no `eval`, no
   runtime reflection, no `with`, no throw-non-Error. (Already true per
   2026-05-01 audit.)
6. **CI runs two-pass equivalence on every commit.** Regression-detection is
   automated; a self-hosting bug never lands silently.
7. **Documentation: `docs/V2_SELF_HOSTING_DEMO.md`** describes the bootstrap
   procedure step-by-step, suitable for an external person to follow.

**Non-goals.**

- *No federation prerequisite.* Self-hosting must work on a single-machine
  registry. Federation (v1) is orthogonal.
- *No runtime hot-swap of registry blocks.* The registry-assembled
  build is a build-time property, not a runtime one. There is no
  swap-an-atom-while-the-CLI-is-running mode.
- *No requirement that the source-tree build disappears.* From-source
  remains a valid path through v2 and beyond — the proof point is that
  both builds produce identical observable behavior, not that the
  source-tree build is deleted.
- *No proof-by-typescript-bootstrap of the shave recursion.* We do not
  need to demonstrate that `@yakcc/shave` can be shaved by a
  prior-version `@yakcc/shave` — bootstrap circularity at the shave
  layer is a v2+ research question, not a v2 exit criterion.

---

## Trust/Scale Axis

The substrate ladder above (v0..v2) describes *what yakcc can do*. It is
orthogonal to the trust/scale axis (F0..F4) described in `FEDERATION.md`,
which describes *how many machines participate and what economic primitives
are available*, and to the verification ladder (L0..L3) described in
`VERIFICATION.md`, which describes *how confident we are in each block*. A
user sits at any `(v, F, L)` coordinate; the cornerstone-preserving move is
that the F0 single-machine deployment is first-class at every substrate
level. Federation features are imported, not inherited.

Brief index — see `FEDERATION.md` for the full design:

- **F0** — single-machine. `@yakcc/core` only. No network. Full substrate
  capability up to and including v2 self-hosting.
- **F1** — federated read-only mirror. `@yakcc/core` + `@yakcc/federation`.
  Pull attestations and content from a public registry; execute locally.
- **F2** — attested mirror. Add a local verifier identity; sign and
  publish attestations as a verifier-citizen.
- **F3** — ZK supply-chain. Cryptographic proof that the local
  executable's bytes hash to on-chain attestations.
- **F4** — economic-commons participant. `@yakcc/core` +
  `@yakcc/federation` + `@yakcc/incentives`. Bounty submissions,
  Proof of Fuzz, stake-to-refine, deprecation-as-slashing.

Tokens at F4 reward **compute and verification labor**, not block
authorship — the cornerstone (no ownership) is preserved because a block,
once registered, belongs to the public domain under The Unlicense.
Slashing is *deprecation* of the failing block at the registry level, not
seizure of any submitter's stake (there is no submitter identity to attach
a stake to).

The F-axis is the answer to "how does yakcc scale to a public commons
without violating the cornerstone?" Substrate work (v-axis) and
verification work (L-axis) are independent of it; advancing the substrate
does not advance the F-axis, and a private deployment can sit at
`(v0.7, F0, L0)` indefinitely.

Concrete F1+ work items will be enumerated as a separate initiative once
the v0/v0.7 work items in "Active Initiatives" land. v1's "Federation,
additional targets, additional hooks, faithful absorption" stage above
remains the substrate-side gate that unlocks F1+ in practice; this section
is the index pointing to the F-axis design, not a re-statement of v1.

---

## Hard problems we are deferring

These are *known* unsolved problems. v0 is engineered to be compatible with
better answers later, not to pretend they don't exist.

Items previously listed here that **the verification ladder
(`VERIFICATION.md`) and trust/scale axis (`FEDERATION.md`) now address** —
*Contract equivalence is undecidable in general*, *Provenance and trust*,
*Adversarial contributions* — have been retired from this table. The
addressing is not "solved"; it is "moved to documents that own the design
surface for the solution." The DEC-V-* and DEC-F-* logs in those documents
carry the load-bearing decisions.

The residual hard problems v0 still defers:

| Problem | v0 stance | Future work |
|---|---|---|
| Composition is not free (errors, resources, perf don't decompose cleanly) | IR makes composition explicit; v0 limits itself to pure, total, side-effect-free seed blocks where composition is well-behaved. | First-class effect/resource/perf composition rules in the IR (v0.5+); ocap effect signatures formalized in `VERIFICATION.md` extend this. |
| Embedding-similarity drift (semantically distinct contracts close in vector space) | Embedding only surfaces candidates; structural matching is the gate. Selection never reads cosine distance. | Better encoders, contract-aware embedding training (v0.5+). |
| Seed-corpus bias | We pick the ~20 seeds. Whatever we pick, future composition shape inherits our taste. | Once the hook is live (v0.5), real authoring loops add corpus mass we didn't bias. |
| Verifier governance (default trust list authority) | F0/F1/F2 deployments configure their own trust lists; the question of who maintains the *shipped default* trust list is unresolved. | F3/F4 deployment forces a governance choice (multi-sig, on-chain vote, federation-of-attesters). Surfaced in `FEDERATION.md` as a user-decision boundary, not a v0/v1 deliverable. |
| Microarchitectural covert channels (timing, cache, speculation) | The static `constant_time` analysis catches data-dependent branching/indexing in source. It does not catch Spectre-class side-channels. | Open research. Caller responsibility for crypto-sensitive code; the substrate has no story below the source-language level. See `VERIFICATION.md` "Hard problems". |
| L3 economic premium tuning | The ~10x L2/L3 reward asymmetry is illustrative, not derived. | F4 deployment empirically tunes the multiplier against observed cost ratios; the principle is the asymmetry, not the constant. See `FEDERATION.md`. |
| BMC's confidence-not-certainty ceiling for crypto-sensitive blocks | L2/BMC attestations are bounded ("no counterexample at depth ≤ N"). For cryptographic primitives, depth-N is meaningless without depth-∞. | Crypto blocks need L3 (proof) or a parallel argument (deployment history, paper-level analysis). The substrate cannot mechanically promote a BMC attestation to crypto-worthy. See `VERIFICATION.md`. |
| Retroactive unsoundness response time | The attestation ledger supports revocation; recovery from a major verifier unsoundness still takes hours-to-days. | Disclosure-and-rotation discipline is human-loop work; auditable revocation events make post-hoc detection of impacted builds tractable. |

---

## Active Initiatives

### Initiative: v0 substrate

Status: **closed.** All rows landed on `main` (WI-009 superseded by WI-T06 per DEC-WI009-SUBSUMED-021). v1 wave-1 is also complete on `origin/main` as of `e972b9c` (closed via WI-021 at `d9cb449` plus the wave-1 cleanup WI-029/030/031 and follow-ups WI-032/033/034). v2 wave-1 in progress: WI-V2-01 landed at `e972b9c`; WI-V2-02 sister-session in flight.

| ID | Title | Description | Deps | Gate | State |
|---|---|---|---|---|---|
| WI-001 | Repo skeleton + facades | pnpm + Turbo monorepo, six package skeletons with real typed interfaces and plausible stub responses, strict-TS toolchain config, ESLint + ts-morph wiring, license + AGENTS.md + DESIGN.md placement. | — | review | [x] done — landed at ef13b32 |
| WI-002 | Contract schema + canonicalization | Lock the `ContractSpec` shape, canonicalization rules, content-address derivation, and the embedding-pipeline provider interface (with `transformers.js` as the local default). Property tests for canonicalization stability. | WI-001 | review | [x] done — landed at 3ba68a9 |
| WI-003 | Registry storage | SQLite + sqlite-vec schema. Implement `store / search / match / select / provenance`. Strictness-aware selection. Provenance manifest emitter. | WI-002 | review | [x] done — landed at d0e136b |
| WI-004 | Strict TS subset + IR | ts-morph validator banning `any`, `eval`, untyped imports, runtime reflection, and the rest of the escape-hatch list. ESLint rules. Wire into Turbo so non-IR-conformant code fails the build. | WI-001 | review | [x] done — landed at 96fc092 |
| WI-005 | TS backend + whole-program assembly | `@yakcc/compile` TS backend. Walk sub-contracts, bind via registry, emit single artifact + provenance manifest. Byte-identical re-emit on unchanged registry. | WI-003, WI-004 | review | [x] done — landed at da8250a |
| WI-006 | Seed corpus | ~20 hand-authored, IR-conformant contracts demonstrating composition. Includes full chain for `examples/parse-int-list`. fast-check property tests for each. | WI-002, WI-004 | review | [x] done — landed at 3b54421 |
| WI-007 | CLI | `yakcc propose | search | compile | registry init | block author`. Thin; defers all real logic to packages. | WI-003, WI-005 | review | [x] done |
| WI-008 | Claude Code hook facade | Real slash-command surface, project config, install command. Proposal flow stubbed with a clear "v0.5" message. No interception logic yet. | WI-007 | review | [x] done |
| WI-009 | Demo + acceptance | `examples/parse-int-list` end-to-end. Verifies all v0 exit criteria. Documents the 15-minute new-contributor path. **Subsumed by WI-T06** (v0.6 triplet-form demo + acceptance) per DEC-WI009-SUBSUMED-021 — the 7 v0 exit criteria are preserved as a strict subset of WI-T06's acceptance gate so the demo is not run twice with two different block shapes. | WI-005, WI-006, WI-007, WI-008 | approve | superseded by WI-T06 |

Dependency waves: `{WI-001} → {WI-002, WI-004} → {WI-003, WI-006} → {WI-005, WI-007} → {WI-008} → {WI-009}`. Critical path runs through WI-001 → WI-002 → WI-003 → WI-005 → WI-009. WI-009 is now subsumed by WI-T06 in the v0.6 triplet initiative below.

### Initiative: v0.6 triplet substrate migration

Status: **closed**. v0/v0.6 substrate shipped at `7825a39` on `main`. This
initiative was the substrate-shape bridge from v0 (inline-`CONTRACT`-literal
blocks) to v1 (verification-ready triplet blocks); it blocked v0.5 and v0.7
because both stages produce blocks and must produce them in the triplet
shape, not in the deprecated v0 shape. See DEC-TRIPLET-MIGRATION-018,
DEC-TRIPLET-L0-ONLY-019, DEC-TRIPLET-IDENTITY-020, DEC-WI009-SUBSUMED-021.
Source-of-truth design: `VERIFICATION.md` §"Block as cryptographic triplet"
(DEC-VERIFY-002, DEC-VERIFY-003). Plan-history milestone recorded under
"Plan history milestones" below.

| ID | Title | Description | Deps | Gate | State |
|---|---|---|---|---|---|
| WI-T01 | `spec.yak` schema, `proof/manifest.json` schema, MerkleRoot derivation in `@yakcc/contracts` | Add `SpecYak` type + JSON schema (required: `name`, `inputs`, `outputs`, `preconditions`, `postconditions`, `invariants`, `effects`, `level`; optional: `theory`, `bounds`, `totality_witness`, `proof_kind`, `constant_time`). Add `ProofManifest` type + L0 schema (must declare exactly one `property_tests` artifact at L0; other artifact kinds are schema-valid but L0-rejected). Add `BlockMerkleRoot` branded type. Implement `blockMerkleRoot(triplet) → BlockMerkleRoot` with the encoding decided in this stage (`impl_hash = BLAKE3(impl.ts file bytes)` at L0; `proof_root = BLAKE3(canonical(manifest.json) \|\| concat(BLAKE3(artifact_bytes_in_manifest_order)))`; `block_merkle_root = BLAKE3(spec_hash \|\| impl_hash \|\| proof_root)`) and record the encoding as a `@decision` annotation. Property tests for determinism (re-derive on the same triplet returns the same root) and for sensitivity (any byte change in any artifact changes the root). `ContractId` (the spec hash) is retained as `SpecHash` and continues to derive from `canonicalize(spec.yak)`. | — | review | [x] done — landed at 9137bef |
| WI-T02 | Directory-based block authoring in `@yakcc/ir` | Add `parseBlockTriplet(directoryPath, registry?) → BlockTripletParseResult`. Reads `spec.yak`, `impl.ts`, `proof/manifest.json` from the directory; runs the existing strict-subset validator on `impl.ts` (no banlist expansion); validates `spec.yak` against the WI-T01 schema; validates `proof/manifest.json` against the L0 manifest schema; resolves sub-block references in `impl.ts` (existing import-detection logic) into `SpecHash` references that the registry uses for the `spec_hash → BlockMerkleRoot` lookup. **Remove** `packages/ir/src/annotations.ts` (CONTRACT-literal extractor) and the `parseBlock(source)` signature from `block-parser.ts` — the inline-CONTRACT mechanism is the deprecated path and must not coexist with the triplet path (Sacred Practice #12). Update or remove tests under `packages/ir/src/__fixtures__` that exercised the CONTRACT-literal shape. | WI-T01 | review | [x] done — landed at c957ce9 |
| WI-T03 | Registry schema migration in `@yakcc/registry` | Replace `contracts` and `implementations` tables with a single `blocks` table: `blocks(block_merkle_root TEXT PRIMARY KEY, spec_hash TEXT NOT NULL, spec_canonical_bytes BLOB NOT NULL, impl_source TEXT NOT NULL, proof_manifest_json TEXT NOT NULL, level TEXT NOT NULL CHECK(level IN ('L0','L1','L2','L3')), created_at INTEGER NOT NULL)` plus index `idx_blocks_spec_hash ON blocks(spec_hash)`. Update `contract_embeddings` virtual table to key on `spec_hash` (since two blocks sharing a spec share an embedding). Replace `selectImplementation(contractId)` with `selectBlocks(specHash) → BlockMerkleRoot[]` and add `getBlock(merkleRoot) → BlockTripletRow`. Increment `SCHEMA_VERSION` to 2 and write the migration as a clean re-create (no v0/v1 tables coexist). Update `test_history`, `runtime_exposure`, `strictness_edges` to reference `block_merkle_root` instead of `contract_id` where applicable. The seed corpus has not been published externally so re-derived addresses are acceptable (DEC-TRIPLET-IDENTITY-020). | WI-T01 | review | [x] done — landed at 89823f6 |
| WI-T04 | Compile resolver and provenance manifest update in `@yakcc/compile` | `resolveComposition` walks the graph by `BlockMerkleRoot`. Sub-block imports detected by `parseBlockTriplet` resolve through `selectBlocks(spec_hash)` (at L0-only with the seed corpus, exactly one match per spec_hash). Provenance manifest (`buildManifest`) emits one `ProvenanceEntry` per block with both `block_merkle_root` and `spec_hash` recorded; `verificationStatus` continues to derive from `test_history`. The byte-identical re-emit invariant is preserved (the order of entries follows topological order of the resolution result, same as v0). All `resolve.test.ts`, `assemble.test.ts`, `manifest.test.ts`, and `ts-backend.test.ts` survive the migration; new tests cover MerkleRoot-driven traversal. | WI-T02, WI-T03 | review | [x] done — landed at 4e0e5a1 |
| WI-T05 | Seed corpus migration in `@yakcc/seeds` | Convert each of the 20 hand-authored blocks under `packages/seeds/src/blocks/` from a single `.ts` file into a directory `<name>/` containing `spec.yak`, `impl.ts`, and `proof/manifest.json`. Lift each existing `export const CONTRACT` literal into `spec.yak` (preserving `behavior`, `guarantees`, `errorConditions`, `nonFunctional`, `propertyTests`; adding `name`, `level: "L0"`, `effects: []`, and empty `preconditions`/`postconditions`/`invariants` arrays at minimum — derive richer pre/post from existing guarantees where the existing language permits a clean lift). Move the implementation function into `impl.ts` (byte-identical to the current function body). Move the existing fast-check tests into the location named by `proof/manifest.json` (`tests.fast-check.ts` per the VERIFICATION.md example, or another path the manifest declares). Update `packages/seeds/src/seed.ts` to enumerate block directories (replacing the hand-maintained `BLOCK_FILES` list) and to use `parseBlockTriplet` instead of `parseBlock`. Update `packages/seeds/src/seed.test.ts` to assert against the new triplet shape (157 existing property tests must continue to pass). | WI-T02, WI-T04 | approve | [x] done — landed at ced7d8e |
| WI-T06 | Demo migration + v0/v0.6 acceptance gate (`examples/parse-int-list`) | Rename `examples/parse-int-list/contract.json` → `examples/parse-int-list/spec.yak` and add the v1-required fields (`name`, `level: "L0"`, `effects: []`, plus empty pre/post/invariants arrays — pre/post can grow as a follow-up). Add `examples/parse-int-list/proof/manifest.json` declaring the existing property-test artifact. Verify `yakcc compile examples/parse-int-list` resolves the listOfInts triplet through the new `spec_hash → block_merkle_root` index, walks the composition graph through the seed-corpus triplets, emits `dist/module.ts` plus `dist/manifest.json` (provenance manifest now keyed by `BlockMerkleRoot`), and the runnable module parses `"[1,2,3]"` to `[1,2,3]` on Node. Re-validate all 7 v0 stage exit criteria under the triplet shape (per DEC-WI009-SUBSUMED-021). | WI-T03, WI-T04, WI-T05 | approve | [x] done — landed at 7825a39 |

v0.6 dependency waves: `{WI-T01} → {WI-T02, WI-T03} → {WI-T04} → {WI-T05} → {WI-T06}`. Critical path runs WI-T01 → WI-T02 → WI-T04 → WI-T05 → WI-T06. WI-T03 (registry schema) and WI-T02 (parser) are independent given WI-T01's schema, but WI-T04 depends on both. Max wave width: 2 (WI-T02 and WI-T03 in parallel).

#### v0.6 Evaluation Contracts and Scope Manifests

Each work item below is guardian-bound. The Evaluation Contract names the
acceptance target the implementer is building toward and the reviewer is
verifying against; the Scope Manifest names the file boundaries hooks
enforce. These are the slice-level invariants — Sacred Practice #12 (no
parallel mechanisms) is load-bearing across every WI-T0*.

**WI-T01 — `spec.yak` schema, `proof/manifest.json` schema, MerkleRoot derivation**

- *Evaluation Contract — required tests:* (a) `spec.yak` schema validator round-trips every legal v0 ContractSpec lifted into the v1-required-fields shape (positive cases include all 20 seed specs); (b) schema validator rejects each missing required field with a typed error naming the field; (c) `blockMerkleRoot(triplet)` is deterministic across re-runs on the same triplet (property test, ≥1000 cases); (d) `blockMerkleRoot` is sensitive — a single byte change in `spec.yak`, `impl.ts`, or any artifact named in `proof/manifest.json` produces a different root (property test); (e) `SpecHash = blake3(canonicalize(spec.yak))` agrees with the existing `contractId(ContractSpec)` derivation when applied to a spec that omits the v1-only required fields (so the migration path can re-index without recomputing `SpecHash` from scratch — call this the "spec-hash continuity" check).
- *Evaluation Contract — required real-path checks:* `pnpm --filter @yakcc/contracts test` is green; `pnpm --filter @yakcc/contracts build` produces a clean strict-TS build; `pnpm build` at the workspace root remains green (no downstream package is broken yet because WI-T01 is additive — it adds new types and functions, removes nothing).
- *Evaluation Contract — required authority invariants:* `@yakcc/contracts` remains the single canonical authority for content-addressing (DEC-IDENTITY-005, DEC-CANON-001, DEC-HASH-WI002). The MerkleRoot encoding is recorded as a `@decision` annotation in the implementation file so it is auditable and superseding it requires an explicit DEC entry.
- *Evaluation Contract — required integration points:* No downstream callers in this WI; WI-T02 / WI-T03 / WI-T04 will consume these types in subsequent work items.
- *Evaluation Contract — forbidden shortcuts:* No coexistence of v0 and v1 schema validators (do not ship `validateContractSpecV0` and `validateSpecYakV1` side-by-side — the v0 ContractSpec interface stays in `index.ts` only as a structural ancestor of `SpecYak` if needed, but no parallel "validate the deprecated shape" entry point ships); no use of `JSON.stringify` in the canonicalization path (DEC-CANON-001); no use of a non-BLAKE3 hash anywhere in identity derivation (DEC-HASH-WI002).
- *Evaluation Contract — ready-for-guardian:* all required tests pass; the new types and functions are exported from `@yakcc/contracts/src/index.ts`; the MerkleRoot encoding `@decision` annotation is present in the implementation file.
- *Scope Manifest — allowed:* `packages/contracts/src/**`, `packages/contracts/package.json`, `packages/contracts/tsconfig.json`.
- *Scope Manifest — required:* `packages/contracts/src/index.ts` (re-exports), at least one new module under `packages/contracts/src/` for the schema and Merkle derivation (implementer's choice of name, e.g. `spec-yak.ts`, `merkle.ts`).
- *Scope Manifest — forbidden:* `packages/ir/**`, `packages/registry/**`, `packages/compile/**`, `packages/seeds/**`, `packages/cli/**`, `packages/hooks-claude-code/**`, `examples/**`, every other top-level path enumerated in the workflow contract's `forbidden_paths`.
- *Scope Manifest — state authorities touched:* contract-canonicalization authority (`@yakcc/contracts`); content-addressing authority (`@yakcc/contracts`).
- *Rollback boundary:* WI-T01 is additive. If reviewer rejects, revert is a single-package rollback; no downstream consumers depend on the new types yet.

**WI-T02 — Directory-based block authoring in `@yakcc/ir`**

- *Evaluation Contract — required tests:* (a) `parseBlockTriplet(dir)` returns a typed result for each of the 20 seed-block triplet fixtures (set up under `packages/ir/src/__fixtures__/triplets/`) with strict-subset validation passing; (b) malformed `spec.yak` (missing required field) produces a typed validation error; (c) malformed `proof/manifest.json` (no `property_tests` artifact at L0) produces a typed validation error; (d) `impl.ts` containing `any` / `eval` / banned imports still fails the strict-subset validator with the v0 banlist exactly (no banlist regression, no banlist expansion); (e) sub-block import detection still resolves seed-pattern imports to `SpecHash` references; (f) the `parseBlock(source)` symbol is **not exported** from `@yakcc/ir`'s public surface (grep test).
- *Evaluation Contract — required real-path checks:* `pnpm --filter @yakcc/ir test` is green; `pnpm --filter @yakcc/ir build` succeeds; the strict-subset CLI (`packages/ir/src/strict-subset-cli.ts`) is updated to operate on triplet directories and a smoke-test invocation against one seed triplet succeeds.
- *Evaluation Contract — required authority invariants:* `@yakcc/ir` remains the single canonical authority for the strict-TS subset (DEC-IR-008). The CONTRACT-literal extraction code in `packages/ir/src/annotations.ts` is **deleted**, not commented out, not flagged behind a feature flag (Sacred Practice #12).
- *Evaluation Contract — required integration points:* downstream consumers of `parseBlock` (`@yakcc/seeds/src/seed.ts`, `@yakcc/compile/src/resolve.ts`) will be updated in WI-T05 / WI-T04 respectively; WI-T02 ships the new API alongside a deprecation barrier — the old `parseBlock(source)` symbol is removed in this WI, so any unmigrated consumer fails to compile until its consuming WI is run. This is intentional: it forces every consumer through the new API before T02 lands.
- *Evaluation Contract — forbidden shortcuts:* no parallel `parseBlock(source)` and `parseBlockTriplet(dir)` exports — the inline-CONTRACT path is removed in this WI; no shadow function that "wraps" an inline-CONTRACT block as a synthetic triplet on the fly (Sacred Practice #12); no expansion of the banlist (defer that to a later L-axis WI).
- *Evaluation Contract — ready-for-guardian:* all required tests pass; `parseBlockTriplet` is exported from `@yakcc/ir/src/index.ts`; `packages/ir/src/annotations.ts` and any references to it are deleted; `parseBlock(source)` is removed.
- *Scope Manifest — allowed:* `packages/ir/src/**`, `packages/ir/package.json`, `packages/ir/tsconfig.json`.
- *Scope Manifest — required:* `packages/ir/src/block-parser.ts` (rewritten for triplets), `packages/ir/src/index.ts` (exports updated), `packages/ir/src/__fixtures__/**` (triplet fixtures added; legacy fixtures removed); `packages/ir/src/annotations.ts` (file deleted).
- *Scope Manifest — forbidden:* `packages/contracts/**` (depend on, do not modify), `packages/registry/**`, `packages/compile/**`, `packages/seeds/**`, `packages/cli/**`, `packages/hooks-claude-code/**`, `examples/**`.
- *Scope Manifest — state authorities touched:* strict-TS-subset authority (`@yakcc/ir`).
- *Rollback boundary:* WI-T02 deletes the inline-CONTRACT mechanism. Rollback restores it from git history; downstream consumers (T04, T05) are not yet migrated, so a T02 rollback before T04/T05 is clean. After T05 lands, T02 can no longer be rolled back without also rolling back T05.

**WI-T03 — Registry schema migration in `@yakcc/registry`**

- *Evaluation Contract — required tests:* (a) fresh-DB migration to `SCHEMA_VERSION = 2` creates the new `blocks` table with the documented column shape and the `idx_blocks_spec_hash` index; (b) `selectBlocks(specHash)` returns the expected `BlockMerkleRoot[]` for the seed corpus once T05 ingests it (T03 itself does not ingest; T03 ships the API + schema + storage primitives and is tested with synthetic triplet rows); (c) `getBlock(merkleRoot)` returns the stored triplet row; (d) the existing `test_history`, `runtime_exposure`, `strictness_edges` tests continue to pass with `block_merkle_root` references; (e) the storage benchmark suite (`storage.benchmark.test.ts`) survives the migration (no perf regression > 2x on insert/select).
- *Evaluation Contract — required real-path checks:* `pnpm --filter @yakcc/registry test` is green; `pnpm --filter @yakcc/registry build` succeeds; the `vec0` virtual table is re-keyed on `spec_hash` and an embedding round-trip test passes.
- *Evaluation Contract — required authority invariants:* `@yakcc/registry` remains the single canonical authority for block storage (DEC-STORAGE-009). No `author`, `author_email`, `signature`, or any ownership-shaped column appears in the new schema (DEC-NO-OWNERSHIP-011 — invariant test must continue to pass).
- *Evaluation Contract — required integration points:* the migration is a clean `SCHEMA_VERSION` bump from 1 to 2 with the v0 tables dropped; no v0/v1 dual-table coexistence (Sacred Practice #12). WI-T05 will populate the new table; WI-T04 will read from it.
- *Evaluation Contract — forbidden shortcuts:* no `contracts` and `implementations` tables alongside the new `blocks` table (clean re-create only); no read-only alias view that mimics the v0 schema for "transition support"; no fallback path that re-derives `block_merkle_root` from `spec_hash + impl_source` at read time (the column must be stored).
- *Evaluation Contract — ready-for-guardian:* all required tests pass; `SCHEMA_VERSION` is 2; the migration applies cleanly on a fresh DB and on a v0-shaped DB (the v0 DB is wiped per DEC-TRIPLET-IDENTITY-020 since the seed corpus is not externally published); `selectBlocks` and `getBlock` are exported from `@yakcc/registry/src/index.ts`.
- *Scope Manifest — allowed:* `packages/registry/src/**`, `packages/registry/package.json`, `packages/registry/tsconfig.json`.
- *Scope Manifest — required:* `packages/registry/src/schema.ts` (new migration), `packages/registry/src/storage.ts`, `packages/registry/src/select.ts`, `packages/registry/src/search.ts`, `packages/registry/src/index.ts` (exports updated).
- *Scope Manifest — forbidden:* `packages/contracts/**`, `packages/ir/**`, `packages/compile/**`, `packages/seeds/**`, `packages/cli/**`, `packages/hooks-claude-code/**`, `examples/**`.
- *Scope Manifest — state authorities touched:* registry-schema authority (`@yakcc/registry`); block-storage authority (`@yakcc/registry`); selection authority (`@yakcc/registry`).
- *Rollback boundary:* a fresh-DB migration is destructive of any existing v0 registry contents on the developer's machine. The seed corpus has not been published externally so this is acceptable (DEC-TRIPLET-IDENTITY-020). Rollback restores the v0 schema from git history and requires re-running `yakcc registry init` against the unmigrated seed corpus (which will not yet exist after T05 lands).

**WI-T04 — Compile resolver and provenance manifest update in `@yakcc/compile`**

- *Evaluation Contract — required tests:* (a) `resolveComposition` walks the seed-corpus composition graph by `BlockMerkleRoot` from a synthetic triplet-populated registry (T04's fixtures pre-populate the `blocks` table since T05 has not yet run); (b) topological order is preserved (existing `resolve.test.ts` invariants); (c) cycle detection still fires on cyclic synthetic graphs; (d) `buildManifest` emits `BlockMerkleRoot` plus `spec_hash` per entry; (e) byte-identical re-emit invariant: running `assemble` twice on an unchanged registry produces byte-identical artifact and manifest.
- *Evaluation Contract — required real-path checks:* `pnpm --filter @yakcc/compile test` is green; `pnpm --filter @yakcc/compile build` succeeds.
- *Evaluation Contract — required authority invariants:* `@yakcc/compile` remains the single canonical authority for whole-program assembly. The byte-identical re-emit invariant (a v0 cornerstone exit criterion) is preserved.
- *Evaluation Contract — required integration points:* depends on `@yakcc/registry`'s `selectBlocks` / `getBlock` (T03) and `@yakcc/ir`'s `parseBlockTriplet` (T02). Does not yet depend on T05's seed corpus — T04's tests use synthetic triplet fixtures.
- *Evaluation Contract — forbidden shortcuts:* no resolver that resolves through `ContractId` and "looks up by spec hash as a fallback" — the resolver walks `BlockMerkleRoot` exclusively after sub-block imports are resolved through `selectBlocks(spec_hash)`; no manifest entry that omits `block_merkle_root`.
- *Evaluation Contract — ready-for-guardian:* all required tests pass; `resolveComposition` and `buildManifest` use the new types; the byte-identical re-emit test passes against a synthetic triplet registry.
- *Scope Manifest — allowed:* `packages/compile/src/**`, `packages/compile/package.json`, `packages/compile/tsconfig.json`.
- *Scope Manifest — required:* `packages/compile/src/resolve.ts`, `packages/compile/src/manifest.ts`, `packages/compile/src/assemble.ts`, `packages/compile/src/ts-backend.ts`, `packages/compile/src/index.ts`.
- *Scope Manifest — forbidden:* `packages/contracts/**`, `packages/ir/**`, `packages/registry/**`, `packages/seeds/**`, `packages/cli/**`, `packages/hooks-claude-code/**`, `examples/**`.
- *Scope Manifest — state authorities touched:* compile/assembly authority (`@yakcc/compile`); provenance-manifest authority (`@yakcc/compile`).
- *Rollback boundary:* T04 is the first WI where the byte-identical re-emit invariant is at risk. Rollback restores v0 resolver/manifest behavior; T05 / T06 cannot proceed without T04.

**WI-T05 — Seed corpus migration in `@yakcc/seeds`**

- *Evaluation Contract — required tests:* (a) every block under `packages/seeds/src/blocks/<name>/` parses successfully via `parseBlockTriplet`; (b) the existing fast-check property test corpus (currently distributed across the seed `.ts` files; total 157 tests per dispatch context) continues to pass against the migrated impls — same input/output behavior, byte-identical function bodies; (c) `seedRegistry()` populates the `blocks` table with 20 rows, one per directory; (d) re-running `seedRegistry()` on a clean DB produces byte-identical `block_merkle_root` for every block (determinism); (e) the `seed.test.ts` end-to-end seed-then-resolve check passes.
- *Evaluation Contract — required real-path checks:* `pnpm --filter @yakcc/seeds test` is green; `pnpm --filter @yakcc/seeds build` succeeds; `pnpm test` at the workspace root is green (every package's tests pass against the migrated seed corpus).
- *Evaluation Contract — required authority invariants:* the seed corpus is the canonical L0 reference set; every triplet declares `level: "L0"` and `effects: []`. The `BLOCK_FILES` flat list in `packages/seeds/src/seed.ts` is replaced by directory enumeration — no hand-maintained list of block names.
- *Evaluation Contract — required integration points:* depends on T01 (schema), T02 (parser), T03 (registry), T04 (resolver). Downstream consumer is T06 (the demo).
- *Evaluation Contract — forbidden shortcuts:* no preserved `.ts` files alongside the migrated triplet directories (Sacred Practice #12); no parallel `BLOCK_FILES` constant after directory enumeration is in place; no synthesized `proof/manifest.json` that points at a property-test artifact that doesn't exist on disk; no L0 manifest with a non-`property_tests` artifact (deferred to L1+).
- *Evaluation Contract — ready-for-guardian:* every block is a triplet directory; the 157 fast-check property tests pass; `seedRegistry()` re-runs deterministically; the workspace-root `pnpm test` is fully green.
- *Scope Manifest — allowed:* `packages/seeds/src/**`, `packages/seeds/package.json`, `packages/seeds/tsconfig.json`.
- *Scope Manifest — required:* `packages/seeds/src/blocks/<name>/spec.yak`, `packages/seeds/src/blocks/<name>/impl.ts`, `packages/seeds/src/blocks/<name>/proof/manifest.json` for each of the 20 blocks; `packages/seeds/src/seed.ts` (loader rewritten); `packages/seeds/src/seed.test.ts` (assertions updated). Existing `packages/seeds/src/blocks/<name>.ts` files are deleted.
- *Scope Manifest — forbidden:* `packages/contracts/**`, `packages/ir/**`, `packages/registry/**`, `packages/compile/**`, `packages/cli/**`, `packages/hooks-claude-code/**`, `examples/**`.
- *Scope Manifest — state authorities touched:* seed-corpus authority (`@yakcc/seeds`); seed-loader authority (`@yakcc/seeds`).
- *Rollback boundary:* T05 is destructive of the inline-CONTRACT seed files (they are deleted, not preserved alongside). Rollback restores them from git history. After T06 lands, the migrated triplet seeds are the registry's only source of truth for the seed corpus.

**WI-T06 — Demo migration + v0/v0.6 acceptance gate**

- *Evaluation Contract — required tests:* (a) `yakcc compile examples/parse-int-list` succeeds and emits `dist/module.ts` plus `dist/manifest.json`; (b) running the emitted module on Node parses `"[1,2,3]"` to `[1,2,3]` (existing v0 demo invariant); (c) the manifest names every block by `BlockMerkleRoot` plus `spec_hash`; (d) re-running `yakcc compile examples/parse-int-list` produces byte-identical `module.ts` and `manifest.json` (byte-identical re-emit invariant); (e) the compiled module imports zero runtime dependencies beyond what the seed blocks themselves require (existing v0 supply-chain invariant); (f) all 7 v0 stage exit criteria are re-validated and recorded as passing under the triplet shape (DEC-WI009-SUBSUMED-021).
- *Evaluation Contract — required real-path checks:* full `pnpm install && pnpm build && pnpm test` from a clean clone is green; the 28-test CLI suite passes; the seed-corpus 157 property tests pass; `yakcc registry init` ingests the 20-block seed corpus as triplets and `yakcc search` round-trips every block's `BlockMerkleRoot`.
- *Evaluation Contract — required authority invariants:* the cornerstone invariants (`MASTER_PLAN.md` §Cornerstone) are preserved; the verification-axis identity invariant (DEC-VERIFY-002, DEC-TRIPLET-IDENTITY-020) is enforced — every block in the registry is identified by `BlockMerkleRoot`, every selection goes through `spec_hash`.
- *Evaluation Contract — required integration points:* depends on every prior v0.6 WI (T01..T05); is the v0/v0.6 closer.
- *Evaluation Contract — forbidden shortcuts:* no demo-side patch that bypasses the new resolver to make the test pass; no manifest entry with a placeholder `block_merkle_root` value; no skipped exit criterion from the v0 stage list.
- *Evaluation Contract — ready-for-guardian:* every required test passes; the demoable artifact runs end-to-end; the byte-identical re-emit invariant holds; the 7 v0 exit criteria are recorded as passing under the triplet shape; the README's documented new-contributor command sequence reproduces the demo on a clean machine.
- *Scope Manifest — allowed:* `examples/parse-int-list/**`. (Note: the workflow contract scope says `forbidden: examples/**, packages/**`. WI-T06 is the work item where that scope must be widened by the implementer dispatch — planner flags this here so the dispatch context is explicit. The same is true for WI-T01..WI-T05 with respect to their `packages/<name>/**` paths. The `forbidden_paths` list in the slice's overall workflow contract is the *planner's* default scope while writing the plan; each implementer dispatch sets the per-WI scope manifest as its allowed paths.)
- *Scope Manifest — required:* `examples/parse-int-list/spec.yak` (renamed from `contract.json`), `examples/parse-int-list/proof/manifest.json` (new), `examples/parse-int-list/src/main.ts` (updated if the manifest path changes).
- *Scope Manifest — forbidden:* `packages/**` (the package-level migrations are complete by T05; T06 only touches the demo and verifies end-to-end), `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.claude/**`, `.gitignore`, `AGENTS.md`, `initialize.txt`, `README.md`, `FEDERATION.md`, `tmp/**`.
- *Scope Manifest — state authorities touched:* demo-acceptance authority (`examples/parse-int-list`); v0-stage exit-criteria authority (`MASTER_PLAN.md` v0 stage; verified, not modified, by T06).
- *Rollback boundary:* T06 is the v0/v0.6 closer. Rollback restores the demo's `contract.json` and removes `proof/manifest.json` from git history; T05's seed-corpus migration remains in place but the demo no longer has a triplet shape, which is an inconsistent half-migrated state — a T06 rollback after T05 lands implies a T05 rollback as well to return to a coherent substrate.

### Initiative: v0.7 sub-function decomposition + universalizer pipeline (`@yakcc/shave`)

Status: planned, **unblocked** — v0.6 triplet substrate closed at `7825a39`
(WI-T06 done; v0 demo is acceptance-subsumed under WI-T06 per
DEC-WI009-SUBSUMED-021). All v0.7 work items below assume blocks are
triplets and that shaved blocks are emitted into the registry as triplets,
identified by `BlockMerkleRoot` with `spec_hash` as the selector index.

**Continuous-shave reframe (DEC-CONTINUOUS-SHAVE-022).** v0.7 expands the
`@yakcc/shave` package's scope from "one-shot ingestion of an existing
permissively-licensed library" to a **universalizer pipeline that runs on
every proposal**. The same decomposition / canonicalization / atom-test
machinery activates at three entry points:

1. **`yakcc shave <path-or-url>`** — the original ingestion-time invocation
   (one-shot library absorption, e.g. `lukeed/mri`). Still the v0.7 demo
   anchor.
2. **`yakcc compile <target>`** — at compile time, when the resolver
   encounters a block proposal that is monolithic (an LLM-emitted block
   from `@yakcc/hooks-claude-code`, or a freshly-authored block from
   `yakcc block author`) the universalizer slices it before the resolver
   binds it. Redundant sub-graphs collapse against existing seed-corpus
   atoms or registry blocks via `canonical_ast_hash` (`VERIFICATION.md`
   DEC-VERIFY-009); only the novel "glue" enters the registry.
3. **`yakcc propose <contract>`** — when a fresh proposal is submitted
   either by a human (`yakcc block author`) or by an AI-synthesis path
   (v0.5 hook), the same pipeline runs. Cosmetic-rewrite duplicates are
   rejected at submission per DEC-VERIFY-009; algorithmically novel
   proposals proceed through L0..L3 verification.

This reframe sharpens the original v0.7 from "absorb one library at a
time" into "every proposal at every entry point is universalized." It
composes cleanly with `VERIFICATION.md` DEC-VERIFY-009 (the constitutional
canonicalizer in `@yakcc/contracts` is the structural-equivalence
substrate; `@yakcc/shave` is the slicer that decides where to draw atom
boundaries inside a monolithic candidate). Source: `suggestions.txt` ask
#2, sharpened against the existing `@yakcc/shave` framing.

| ID | Title | Description | Deps | Gate | State |
|---|---|---|---|---|---|
| WI-010 | `@yakcc/shave` package skeleton + intent extraction + universalizer entry points | Stand up `packages/shave/` as a real typed-interface facade exposing the universalizer pipeline at three entry points: one-shot `shave(sourcePath, registry, options): Promise<ShaveResult>` (existing); a `universalize(candidateBlock, registry): Promise<UniversalizeResult>` API that the compile resolver and proposal flow call into; and a hookable extension surface for `@yakcc/hooks-claude-code` to invoke at intercept time once v0.5 is live. Live capability in this WI: intent extraction. Public API returns a stubbed decomposition tree; private `extractIntent(unitSource, context)` calls Anthropic Haiku (`claude-haiku-4-5-20251001`) directly via the SDK and returns a structured intent card. The intent card is the upstream input to `spec.yak` generation in WI-012. On-disk cache keyed by source SHA so re-runs are local and deterministic. No decomposition recursion yet. | WI-T06 | review | **landed** (`e1376d7`, `c36eef1`, `ea47fe8`) |
| WI-011 | Variance scoring + contract design rules | Port librAIrian's star-topology variance comparison and contract-design rules (safety = intersection, behavioral = majority-vote, capability = union) into TS. 7-dimension weights inherited verbatim: security 0.35, behavioral 0.25, error_handling 0.20, performance 0.10, interface 0.10. CWE-474 family mapping for the security dimension. Pure-function module with property tests; no LLM calls in this work item. Used by both the one-shot `shave` path and the continuous `universalize` path when comparing candidate-cluster variance against canonical contracts. | WI-010 | review | **landed** (`92f905a`) |
| WI-012 | Atomic decomposition recursion + data-flow-graph slicing (load-bearing) | The Sub-function Granularity Principle made executable, **and the data-flow-graph slicer that suggestions.txt ask #2 specifies**. Two coupled sub-engines: (a) **Decomposition recursion.** Decomposes each candidate block until it bottoms out at atoms. AST-based atom test: at most one control-flow boundary, no further non-trivial sub-block in the registry. Each emitted atom is a triplet (generated `spec.yak` derived from the intent card and inferred input/output types, an `impl.ts` extracted from the source AST sub-range, a `proof/manifest.json` declaring the synthesized property-test artifact from WI-013). (b) **Data-flow-graph slicer.** When the recursion encounters a non-trivial sub-graph, it queries `selectBlocks(spec_hash)` and `findByCanonicalAstHash(canonical_ast_hash)` against the registry; matching primitives are replaced with pointers to their existing `BlockMerkleRoot`s. The network synthesizes only the **novel "glue."** This is the suggestions.txt ask #2 mechanism made concrete: every monolithic proposal is sliced into a graph of pointers + glue, never re-ingested as a new monolithic block. LLM-proposed decompositions that would create cycles or near-duplicate atoms are collapsed by the canonicalizer (DEC-VERIFY-009) returning the existing `BlockMerkleRoot` rather than ingesting a duplicate. **Reviewer must gate on the atom test for every leaf in the recursion tree and on the slicer's "novel glue" output.** "Did not reach atoms" is a hard failure. "Re-synthesized an existing primitive" is a hard failure. | WI-010, WI-011 | approve | **landed** — sub-slices: WI-012-01 `3c63539`, WI-012-02 `1fe62f4`, WI-012-03 `47410d2`, WI-012-04 `1d7a312`, WI-012-05 DFG slicer `af15563` (with governance backfill of 13 DECs), WI-012-06 universalize wiring `ee2d815` |
| WI-013 | Property-test corpus per recursion level + license gate | Property-test corpus extraction (upstream tests where adaptable, documented usage where absent, AI-derived as last resort). License detector that accepts only Unlicense / MIT / BSD-2 / BSD-3 / Apache-2.0 / ISC / 0BSD / public-domain dedications and refuses everything else with a clear error citing the detected license string. Differential test runner across implementations satisfying the same contract. Activates for both the one-shot `shave` path (license gate gates the entire library ingest) and the continuous `universalize` path (license gate gates third-party-source candidate blocks; fresh AI-synthesized proposals from v0.5 are Unlicense by construction). | WI-012 | review | **in progress** — sub-slices: WI-013-01 license detector+gate `4b8bda2`, WI-013-02 license gate wired into universalize `5f41943`; WI-013-03 property-test corpus extraction deferred (see sub-slice ledger below) |
| WI-014 | Shave CLI surface + universalize wiring + provenance manifest | `yakcc shave <path-or-url>` wired into `@yakcc/cli` (the one-shot ingestion command, still valuable for absorbing existing libraries). **Plus** wire the `universalize(candidateBlock, registry)` entry point into `@yakcc/compile`'s resolver path so every block proposal that hits compile-time (whether from a hand-authored example, an AI-synthesized hook intercept, or a `yakcc propose` invocation) flows through the universalizer pipeline before binding. Provenance manifest entries are keyed by `BlockMerkleRoot` (per WI-T04) and extended with parent-block links forming the recursion tree (each non-root entry names its parent's `BlockMerkleRoot`); for blocks that survived `universalize` because they were the "novel glue" of a sliced proposal, the manifest also records the `BlockMerkleRoot`s of every primitive the glue references. `yakcc search` returns shaved atoms indistinguishable in interface from hand-authored ones — both are triplets in the `blocks` table; selection-signal augmentation per stage spec. | WI-012, WI-013 | review | **in progress** — sub-slices: WI-014-01 `shave()` file ingestion `1a9fcf7`, WI-014-02 `yakcc shave` CLI subcommand `3bfa7ed`; remaining WI-014-03 atom-to-triplet persistence, WI-014-04 provenance manifest parent-block extension, WI-014-05 universalize-into-compile-resolver wiring (see sub-slice ledger below) |
| WI-015 | v0.7 demo + acceptance against `mri` + continuous-shave acceptance | Vendor `lukeed/mri` at a pinned commit under `vendor/mri/`. Run `yakcc shave` end-to-end (one-shot ingestion). Each ingested atom is a triplet under `packages/seeds/src/blocks/<shaved-name>/` (or wherever the shaved-corpus root is configured) with `spec.yak`, `impl.ts`, `proof/manifest.json`. **Plus** an additional acceptance check: a synthetic monolithic block proposal that re-implements `digit + bracket + comma + listOfInts` as a single 200-line function is fed through `yakcc compile` (or `yakcc propose`); the universalizer pipeline must slice it, identify the four existing seed atoms by `canonical_ast_hash` (DEC-VERIFY-009) plus structural matching, and reduce the registry impact to whatever non-trivial "glue" the proposal genuinely added (in the synthetic case: nothing, so the proposal is rejected as fully-redundant per DEC-VERIFY-009; in a near-duplicate case: only the genuinely-novel sub-graph is registered). Verify all v0.7 exit criteria, including (a) atom test on every leaf, (b) `yakcc compile` output matches `mri`'s published test corpus byte-identically, (c) intent-card cache hit on a repeated run requires zero Anthropic API calls (network-sandboxed), (d) GPL-prepared input refused with a clear error, (e) the provenance manifest names every atom by `BlockMerkleRoot` with parent-block links, (f) the synthetic-monolithic-proposal acceptance check above passes. | WI-010, WI-011, WI-012, WI-013, WI-014 | approve | not started |

v0.7 dependency waves: `{WI-010} → {WI-011} → {WI-012} → {WI-013} → {WI-014} → {WI-015}` with WI-011 and WI-013 each running independent of the wave above them once their inputs are ready. Critical path runs WI-T06 → WI-010 → WI-012 → WI-015 (the atom-test gate plus the data-flow-graph slicer at WI-012 is the load-bearing review). v0.7 is unblocked: WI-T06 closed the v0.6 triplet substrate at `7825a39`, every block `shave` and `universalize` ingest will be a triplet from day zero, and the canonicalizer scaffolding (DEC-VERIFY-009) provides the structural-equivalence index the slicer queries.

#### v0.7 remaining-work sub-slice ledger

The end-to-end pipeline `license gate → intent extraction → decompose → slice`
is live and callable from `yakcc shave` (CLI subcommand landed at `3bfa7ed`).
The remaining v0.7 closure work is decomposed into the following bounded
sub-slices. Each is its own implementer dispatch with its own Evaluation
Contract; they land sequentially because WI-014-04 depends on WI-014-03's
persisted `BlockMerkleRoot`s and WI-014-05 depends on WI-014-03's persistence
path. WI-013-03 (property-test corpus) is deferred — bootstrap empty manifests
are acceptable for v0.7 demo provided the atom-test gate (WI-012) and the
property-test scaffolding contract from WI-T01 hold.

| Sub-WI | Title | Scope | Deps | Gate | State |
|---|---|---|---|---|---|
| WI-014-03 | Atom-to-triplet persistence path | When `shave()` produces `NovelGlueEntry` atoms (truly novel code), persist them in the registry as triplets `(spec.yak, impl.ts, proof/manifest.json)` keyed by `BlockMerkleRoot`. Today the shave package emits `ShavedAtomStub` (placeholderId + sourceRange) but does not persist. Concretely: (a) `spec.yak` generated from the IntentCard via an intent → `SpecYak` schema mapping (name from intent verb, inputs/outputs from the inferred type signature, level `L0`, effects `[]`, empty pre/post/invariants stubs that future L1+ work fills); (b) `impl.ts` extracted byte-exact from `entry.source` (the AtomLeaf source text spliced out of the parent file by `sourceRange`); (c) `proof/manifest.json` bootstrapped with an empty `property_tests` artifact array (WI-013-03 fills it later — the manifest schema must allow an empty array at L0 for the bootstrap path, or WI-014-03 declares a single placeholder property-test artifact whose body is a tautology that future corpus work replaces; the implementer chooses, but the choice goes in a DEC); (d) `shave()` returns a `ShaveResult` extended with a `persistedAtoms: Array<{ placeholderId: string; merkleRoot: BlockMerkleRoot }>` field so callers can resolve placeholder → MerkleRoot. Lives in `@yakcc/shave` plus calls into `@yakcc/registry`'s existing `storeBlock` storage primitive. | WI-014-02 | approve | not started — next dispatch |
| WI-014-04 | Provenance manifest parent-block extension | Extend `ProvenanceEntry` in `@yakcc/compile/src/manifest.ts` with optional `recursionParent?: BlockMerkleRoot` (the block this atom was decomposed FROM) and optional `referencedPrimitives?: BlockMerkleRoot[]` (the primitives a "novel glue" entry's pointer entries refer to, per DEC-SLICER-NOVEL-GLUE-004). Registry persistence: add a single optional column `parent_block_root TEXT` on the `blocks` table (schema_version 3 → 4) keyed by `parent_block_root` rather than a sidecar table — the simpler path. `referencedPrimitives` does not need a registry column because it is recoverable from the slice plan recorded against each block; the manifest emitter reads it from the slice plan side-state at compile time. When `compile` builds a manifest for an assembly that includes shaved atoms, the recursion lineage is recorded on every non-root entry. Crosses `@yakcc/registry` (schema migration v3→v4) plus `@yakcc/compile` (manifest emission). | WI-014-03 | review | not started |
| WI-014-05 | Universalize() into compile resolver | When `compile <entry>` resolves a contract that hits a candidate block proposal (rather than a registered triplet) — e.g. a hand-authored example with an inline impl, a freshly-authored block from `yakcc block author`, or in v0.5 an AI-synthesized hook intercept — run `universalize(candidate, registry)` on the candidate first. Behavior: if the resulting slice is fully-redundant (only `PointerEntry` entries, no `NovelGlueEntry`), the resolver uses the existing primitives directly per DEC-VERIFY-009 (no new ingestion); if the slice produces `NovelGlueEntry` atoms, call WI-014-03's persistence path to ingest them, then use the resulting `BlockMerkleRoot`s. Lives in `@yakcc/compile/src/resolve.ts` plus minimal CLI wiring updates so `yakcc compile` exposes the same path. The reviewer atom-test gate plus the slicer's "novel glue ≪ original" gate from DEC-SLICER-NOVEL-GLUE-004 apply at this seam. | WI-014-03, WI-014-04 | approve | not started |
| WI-013-03 | Property-test corpus extraction (deferred) | Generate property tests per atom: extract from upstream tests where adaptable, derive from documented usage where absent, AI-synthesize against the proposed contract as last resort. Lives in `@yakcc/shave` with a new `corpus/` module. Currently deferred — bootstrap empty (or single-tautology) manifests from WI-014-03 are acceptable for v0.7 demo provided the atom test gate (WI-012) gates structural correctness. WI-013-03 is required for the L0 verification claim to be substantive rather than nominal, so it must land before any external-facing v1 federation work; it is **not** required for the WI-015 demo against `mri`. | WI-014-03 | review | deferred |
| WI-015 | v0.7 demo against `lukeed/mri` | Vendor `mri` at a pinned commit under `vendor/mri/`. Run `yakcc shave ./vendor/mri/lib/index.js` end-to-end. Verify atom decomposition reaches primitives. Run `yakcc compile <mri-parse-id>` against `mri`'s published test corpus byte-identically. GPL-prepared input refused with a clear error (license gate). Intent-card cache hit on a repeated `shave` run requires zero Anthropic API calls (network-sandboxed). Sub-slice rather than whole-slice because the vendored `mri` source is JS — yakcc's strict-TS subset and ts-morph-based slicer may not tolerate it. **Fork point inside this WI:** if the JS-tolerant shave path is too hard for v0.7's timeline, scope reduces to a vendored TS rewrite of `mri`'s algorithm (acknowledged as a demo deliverable, not a true ingestion of upstream `mri`); the reviewer / planner decision is recorded in a DEC at WI-015 dispatch time. | WI-014-03, WI-014-04, WI-014-05, (WI-013-03 not required for demo) | approve | not started |

WI-014-03 is the next implementer dispatch. WI-014-04 and WI-014-05 follow
sequentially. WI-013-03 stays deferred. WI-015 is the v0.7 closer.

**Closure note (post-v0.7):** WI-014-03 (`3afb72f`), WI-014-04 (`47df53a`),
WI-014-05 (`2eaa9c1`), and WI-015 (`4ded2c2`, plus vitest-timeout fix
`e7b2c64`) all landed. The v0.7 demo against `lukeed/mri` is closed under
the offline-tolerant acceptance harness path. Three v0.7 follow-ups did
**not** land inside v0.7 and are lifted into v1 below: WI-013-03
(property-test corpus, was deferred), B-003 (parent-block lineage
population in `atom-persist`, partial WI-015 acceptance criterion (e)),
and B-002 (`seedIntentCache` test-helper export needed to re-enable
three `it.skip`s in `assemble-candidate.test.ts`). All three are
prerequisites for any external-facing v1 federation work and are
encoded as v1 work items rather than v0.7 stragglers because the v0.7
demo and its acceptance bar passed without them per
DEC-V07-CLOSURE-001 below.

### Initiative: v1 federation + L0 substantiation (`@yakcc/federation`)

Status: **active.** Branched from v0.7 closure at `4ded2c2` on `main`. The
v1 thesis (federated registry, WASM backend, additional hooks, large-scale
differential validation) is documented in the v1 stage section above; this
initiative encodes the **first wave** — substantiating L0 verification and
shipping an F1 read-only federation mirror against the existing v0.7
shave/universalize substrate. WASM, additional hook surfaces, large-scale
differential execution, and F2+ attestation publishing are deferred to a
follow-on v1 wave or a sibling initiative.

The wave below sequences the work so that the no-ownership / permissive-only
cornerstones survive the move from single-machine to two-machine. The L0
verification claim is made substantive **before** any block leaves a single
machine (WI-016); the federation protocol design is locked **before** any
package is written against it (WI-019); the federation demo runs on a
substrate where every shaved atom carries a real property-test artifact
and a populated parent-block lineage (WI-016 + WI-017 prerequisites). This
ordering preserves Sacred Practice #12 (no parallel mechanisms): we do not
ship federation against a nominally-L0 substrate and then retrofit
property tests on top.

| ID | Title | Description | Deps | Gate | State |
|---|---|---|---|---|---|
| WI-016 | Property-test corpus extraction (lifted from WI-013-03) | Generate property tests per atom for the existing `@yakcc/shave` atom-persist path. Lives in `@yakcc/shave` with a new `corpus/` module (per the deferred WI-013-03 description). Three extraction sources, in priority order: (a) **upstream tests where adaptable** — when an atom is shaved from a library that ships its own test corpus (e.g. `mri`'s published tests), extract the relevant cases and translate to `fast-check` properties; (b) **documented usage where absent** — when no upstream tests exist but documented call patterns do (JSDoc `@example`, README), synthesize property tests from those examples; (c) **AI-derived against the proposed contract as last resort** — when neither source applies, prompt Haiku/Sonnet to generate `fast-check` properties from the IntentCard + inferred type signature. Each generated property test is persisted into the atom's `proof/manifest.json` (replacing the empty array or single-tautology placeholder from WI-014-03's bootstrap path), and the manifest validator rejects atoms whose `property_tests` array is still the placeholder once WI-016 lands. The AI-derived path uses the same on-disk cache scheme as `extractIntent` (DEC-SHAVE-003) so re-runs are deterministic and the second `yakcc shave` of the same source is offline. | WI-018 (cache-seed helper for tests), WI-014-03 (already landed, supplies the empty-manifest baseline) | approve | complete (0be5f9a, 2026-05-01) |
| WI-017 | Parent-block lineage population in `atom-persist` (lifted from B-003) | The schema (`packages/registry/src/schema.ts` v4) and the manifest emitter (`packages/compile/src/manifest.ts`) both already accept the parent-block lineage shape: registry rows have a `parent_block_root TEXT NULL` column, and `ProvenanceEntry` accepts an optional `recursionParent: BlockMerkleRoot`. The `@yakcc/shave` atom-persist path currently always writes `parent_block_root = null`; this work item populates it. **Concrete behavior:** when `shave()` (or `universalize()` via the compile resolver) recurses into a nested function declaration, the inner atom's `parent_block_root` is set to the outer atom's `BlockMerkleRoot` at persist time, and `compile`'s provenance manifest records the chain on every non-root entry. Acceptance: the manifest emitted by `yakcc compile` against a synthetic two-level-deep nested function names both atoms by `BlockMerkleRoot` and correctly identifies the inner atom's `recursionParent` as the outer atom's `BlockMerkleRoot`. Crosses `@yakcc/shave` (atom-persist) plus `@yakcc/compile` (manifest emission consumes the new field; no behavior change to existing seed-corpus assemblies, which are flat). | WI-014-03, WI-014-04 (already landed) | review | complete (abdc1e8, 2026-05-01) |
| WI-018 | Public `seedIntentCache` test-helper export from `@yakcc/shave` (lifted from B-002) | Three tests in `packages/compile/src/assemble-candidate.test.ts` are marked `it.skip` because they need to seed the intent-card cache and the only existing path is the internal `dist/cache/file-cache.js` import which vitest cannot resolve through the workspace alias. Add a public test-helper export `seedIntentCache(spec: SeedSpec, card: IntentCard): Promise<void>` on `@yakcc/shave`'s public API surface so the skipped tests can re-enable. The helper writes through the same cache path that `extractIntent` reads from (DEC-SHAVE-003), so any cache-key drift between writer and reader is impossible. Acceptance: the three `it.skip` calls in `assemble-candidate.test.ts` can be re-enabled and pass; no production code path changes (the helper is test-only by convention but exported from the package's main entry — Sacred Practice #12 forbids a parallel `@yakcc/shave/test-helpers` entry that duplicates the cache machinery). | (none — fully unblocked) | review | complete (c47174f → 58f4c3c, 2026-04-30) |
| WI-019 | v1 federation protocol design (plan-only) | Design pass producing `FEDERATION_PROTOCOL.md` and the DEC entries that the F1 read-only mirror (WI-020) and the v1 demo (WI-021) build against. **Scope:** wire format for replication requests (content-addressed pull keyed by `BlockMerkleRoot`, with `SpecHash` as the lookup index for "find me an implementation of this contract"); conflict-free monotonic merging rules (the registry already has the right shape — block identity is a Merkle root; merging is set-union of triplets, with monotonic improvement encoded as new triplets at the same `SpecHash`, never as overwrites of an existing `BlockMerkleRoot`); F1 read-only-mirror semantics (a federation peer pulls triplets but does not publish; the trust layer is a follow-on); how `parent_block_root` (WI-017) and the `property_tests` artifacts (WI-016) survive cross-peer transfer (both are atomically part of the triplet, so they survive by construction — WI-019 documents this rather than introducing new machinery). **Plan-only:** no `packages/federation/` source ships in this WI; the artifact is a markdown design document plus DEC entries in MASTER_PLAN.md. The reviewer gate is "every claim in `FEDERATION_PROTOCOL.md` is consistent with `FEDERATION.md`'s F0..F4 axis and with `VERIFICATION.md`'s triplet identity"; the planner gate is "every load-bearing protocol decision has a DEC entry." **Landed:** `FEDERATION_PROTOCOL.md` written; `DEC-V1-FEDERATION-PROTOCOL-001` recorded below. | (none — fully unblocked, parallel with WI-017 and WI-018) | approve | landed |
| WI-020 | `@yakcc/federation` package skeleton + content-address mirror sync (F1 read-only) | Stand up `packages/federation/` as a typed-interface package implementing the F1 read-only-mirror behavior designed in WI-019. **Public surface:** `pullBlock(remote, merkleRoot): Promise<BlockTripletRow>` (content-addressed pull); `pullSpec(remote, specHash): Promise<BlockMerkleRoot[]>` (selector-index pull); `mirrorRegistry(remote, local): Promise<MirrorReport>` (bulk pull of every block on a remote whose `BlockMerkleRoot` is not yet in `local`). **Wire transport:** HTTP+JSON for the demo path; transport interface is abstract so a future libp2p/IPFS path slots in without rewriting the merge logic. **No publishing path** in this WI — F1 is read-only mirror. **No trust-list logic** in this WI — pulled blocks are all stored, then trust filtering happens at selection time per `FEDERATION.md` DEC-FED-006 (which is also a follow-on, not WI-020). **Tests:** in-process two-registry round-trip; cross-process two-registry round-trip via local HTTP; verify byte-identical triplet shape on both sides. **WI-020 reviewer pass found the wire `blockMerkleRoot` recomputation in `wire.ts` diverged from the canonical `@yakcc/contracts` `blockMerkleRoot()` formula (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002):** the contracts formula folds artifact bytes into the proof root, but the wire formula hashed only `proofManifestJson`. The wire MUST align with the contracts formula; this required WI-022 (registry artifact-bytes persistence) to land first so a `BlockTripletRow` can carry the bytes the wire needs to emit. **Remediation reprovisioned post-WI-022** under work-item id `wi-020-federation-mirror-v2` on a fresh `feature/wi-020-federation-mirror-v2` worktree off main; the abandoned `feature/wi-020-federation-f1-mirror` worktree carried no committed federation work. **Landed:** v2 source commit at `3269a03` (federation package: `wire.ts` consumes `@yakcc/contracts` `blockMerkleRoot()` directly, no parallel helper; `artifactBytes: Record<string, base64>` on the wire; `pullBlock`/`pullSpec`/`mirrorRegistry`/`createHttpTransport`/`serveRegistry` public surface; CLI verbs `mirror`/`pull-block`/`pull-spec`); merge into main at `9a7dcc2` after origin/main reconciliation through `172a93f` (WI-025 vector-search) and `b93cb3b` (FEDERATION.md/VERIFICATION.md docs). Federation suite: 109 tests green; CLI suite: 48 tests green; full `pnpm -r build` clean. **Two non-blocking reviewer findings deferred to backlog:** B-008 — `Registry.enumerateSpecs()` primitive (`serveRegistry` currently accepts an optional `enumerateSpecs` callback as a workaround per DEC-SERVE-SPECS-ENUMERATION-020, which production callers must wire from their SQLite layer or `/v1/specs` returns `[]`); B-009 — `federation pull --registry` persist-on-pull (the `--registry` flag is parsed but unused; the pull verb is read-only diagnostic in this WI, registry persistence on pull is a follow-on). Reference: `FEDERATION_PROTOCOL.md`, `packages/federation/`. Evaluation Contract: `tmp/eval-wi-020-v2.json`. Scope Manifest: `tmp/scope-wi-020-v2.json`. R-WI020-GOV-001 (FEDERATION_PROTOCOL.md §4 `artifactBytes` bullet) was addressed in WI-022 slice (a). | WI-019, WI-022 | approve | landed (v2 source `3269a03`, merge `9a7dcc2`; backlog: B-008, B-009) |
| WI-022 | Registry persistence of artifact bytes (`BlockTripletRow.artifacts` + schema column) | Add the `artifacts: Map<string, Uint8Array>` field to `BlockTripletRow` and the corresponding `block_artifacts` storage so artifact bytes survive into and out of the registry. **Concrete behavior:** (a) extend the registry schema with a `block_artifacts(block_merkle_root TEXT NOT NULL REFERENCES blocks(block_merkle_root), path TEXT NOT NULL, bytes BLOB NOT NULL, declaration_index INTEGER NOT NULL, PRIMARY KEY(block_merkle_root, path))` table; (b) bump the registry `SCHEMA_VERSION` and add a migration that backfills empty bytes for pre-WI-022 blocks under the same paths their manifests declare (preserves block identity at write boundary because the merkle root recorded for those blocks was computed against whatever bytes the persister had at write time — see migration note in DEC-V1-FEDERATION-WIRE-ARTIFACTS-002); (c) extend `storeBlock` to write the artifacts table from `BlockTripletRow.artifacts`; (d) extend `getBlock` to hydrate the artifacts Map (declaration order preserved); (e) update `@yakcc/shave` `persist/triplet.ts` to populate `BlockTripletRow.artifacts` from the same `Map` it already builds for `blockMerkleRoot()` (no second source of truth — the artifacts that contributed to the merkle root are the same artifacts persisted). **Public surface:** `BlockTripletRow.artifacts: Map<string, Uint8Array>` (new readonly field); no other public-API change. **No federation surface in this WI.** WI-022 is a registry/contracts-side enabler; the wire surface lands in WI-020 remediation. **Landed:** slice (a) at `fe74afe` (registry artifact-bytes persistence + migration 4→5 + FEDERATION_PROTOCOL.md §4 wire-side documentation closing R-WI020-GOV-001), slice (b) at `a169a42` (shave persist threading: `BuiltTriplet.artifacts` + atom-persist threading into `storeBlock`); cleanup at `4b107a8` (workspace-alias imports + stray-artifact build guard). | WI-019 | approve | landed (slices a + b: `fe74afe`, `a169a42`; cleanup `4b107a8`) |
| WI-021 | v1 federation demo + acceptance | Analogue of WI-015 for federation. Two machines (or two registries on one machine, sandboxed): **machine A** runs `yakcc shave` end-to-end against a fresh empty registry on the demo's argv-parser substrate, persisting atoms with real property-test corpora (WI-016) and (when the substrate decomposes into multiple atoms) populated parent-block lineage (WI-017). **Machine B** runs `yakcc federation mirror <machineA-url>` against an empty local registry, then runs `yakcc compile` against the demo's target spec and verifies byte-identical output to machine A's compile. Acceptance criteria: (a) every atom on B has a `property_tests` artifact whose body matches A's (manifest equality, **and the bytes Map is byte-identical** per DEC-V1-FEDERATION-WIRE-ARTIFACTS-002); (b) `parent_block_root` values are byte-identically preserved A→B alongside every other column (when present; substantive multi-atom production is gated on B-010); (c) `yakcc compile`'s emitted TS module is byte-identical on A and B (the load-bearing v1 wave-1 invariant); (d) GPL-prepared input fed to A's `shave` path is refused as in WI-015 (the license gate is local to A; the federation pull on B never sees the refused source); (e) the federation pull is **content-addressed only** — B never sees A's local file paths or any author identity (cornerstone preservation, validated against the wire-format spec from WI-019). **Eval contract revised 2026-05-01** after the reviewer flagged a structural blocker (`REVIEW_VERDICT: blocked_by_plan`): `@yakcc/shave`'s offline-tolerant universalize path produces a single block under DEC-UNIVERSALIZE-WIRING-001 (multi-leaf intentCard wiring deferred), so WI-017 lineage cannot be exercised non-trivially within WI-021's example-only scope. Substantive multi-atom exercise is now tracked as **B-010**; the demo's job is to prove the NEW federation byte-identity invariant on a substrate where prior WIs landed. 8/9 acceptance tests already pass on the implementer's first slice — including the load-bearing byte-identical compile-output assertion. | WI-016, WI-017, WI-019, WI-020, WI-022 | approve | landed (merge `d9cb449`, 2026-05-01 — v1 wave-1 closer) |
| WI-023 | Deterministic intent extraction (static IntentCard path) | Replace the Anthropic API call inside extractIntent() with a parallel TypeScript-Compiler-API + JSDoc-parser path, gated by a new intentStrategy: "static" \| "llm" axis on ShaveOptions and ExtractIntentContext. Default "static". The LLM path is preserved unchanged behind strategy: "llm" so WI-016's AI-derived property-test fallback retains the existing client surface. New constants STATIC_MODEL_TAG = "static-ts@1" and STATIC_PROMPT_VERSION = "static-jsdoc@1" populate the IntentCard envelope's modelVersion/promptVersion fields for the static path; because the existing cache key (cache/key.ts:keyFromIntentInputs) already mixes modelTag and promptVersion into the BLAKE3 derivation, static and LLM cards land in disjoint cache namespaces by construction — no registry needed. The static extractor produces an IntentCard of identical shape to the LLM path (same validateIntentCard runs after both); fields synthesize from JSDoc tags (@param, @returns/@return, @requires→preconditions, @ensures→postconditions, @throws/@remarks/@note/@example→notes) plus the function signature; sources without JSDoc still produce valid cards via signature-only synthesis. seedIntentCache gains an optional strategy?: "static" \| "llm" field that auto-selects the right tag pair as default while preserving WI-018's three re-enabled assemble-candidate tests verbatim. **Note:** dispatched 2026-05-01 under tentative ID WI-022 from a stale local main; remote already claimed WI-022 for the artifact-bytes work. Renumbered to WI-023 at rebase resolution. The original commit message and the merge commit reference WI-022; the @decision IDs (DEC-INTENT-STRATEGY-001 et al) carry no WI number so are unaffected. | WI-018 (already merged — strategy-aware seedIntentCache builds on it) | review | complete (5110e00, 2026-05-01) |
| WI-024 | Cleanup + build fix (workspace-alias imports, stray dist artifacts, plan-state drift) | Fix the broken pnpm -r build on packages/compile by replacing cross-package relative imports in assemble-candidate.test.ts (lines 86-87) with @yakcc/shave workspace-alias imports. This requires exposing DEFAULT_MODEL, INTENT_PROMPT_VERSION, and sourceHash on @yakcc/shave's public surface (additive — no breaking changes; STATIC_MODEL_TAG and STATIC_PROMPT_VERSION are already exported per WI-023). Same root cause produces stray .d.ts/.js/.map artifacts inside packages/shave/src/cache/ and packages/shave/src/intent/ during compile-package builds; those clean up automatically once the imports are fixed (delete the leftover stray files in this WI). Also: add DECISIONS.md to .gitignore (it is auto-generated by stop.sh from @decision annotations — should never have been committable in the first place); delete DECISIONS.md.tmp.1901 (crashed-write artifact from a stop.sh run); correct MASTER_PLAN.md State column for WI-016/017/018/019/020 to reflect commit reality (all are landed per git log: 0be5f9a/abdc1e8/c47174f+58f4c3c/fe161db/72e0e60). Acceptance: pnpm -r build passes for all 12 workspace packages; pnpm --filter @yakcc/shave test stays green at 277/278; pnpm --filter @yakcc/compile test stays green at 48/48; no .d.ts/.js/.map artifacts present under packages/shave/src/ after build; git status clean except for tracked changes. | WI-023 (already merged — cleanup/fixup that follows from the WI-022/023 series and the inherited remote v1 wave-1 work landing simultaneously) | review | landed (`4b107a8`, 2026-05-01) |
| WI-026 | Windows-portability fix in v0.7-mri-demo acceptance harness | Fix the path-construction bug in `examples/v0.7-mri-demo/test/acceptance.test.ts:97-100` that breaks Test B on Windows. The test composes `srcPath` via `join(new URL(".", import.meta.url).pathname, "../src/argv-parser.ts")`. On Windows, `URL.pathname` yields `/C:/src/...` (URL-style with leading slash), which `path.join` then treats as drive-rooted and produces `C:\C:\src\yakcc\...` — `ENOENT`. **Fix:** import `fileURLToPath` from `node:url` and use `fileURLToPath(new URL("../src/argv-parser.ts", import.meta.url))`. This collapses the `join` + `pathname` pair into a single URL-relative resolution that returns a native OS path. The test was authored on POSIX where the bug is invisible. **Secondary fix surfaced during implementation:** Test B also pinned `intentStrategy: "llm"` explicitly because WI-023 flipped the default to `"static"`; under the new default the pipeline reaches `decompose()`, which throws `CanonicalAstParseError` on the argv-parser's `continue`/`break` statements (a pre-existing decompose limitation unmasked by WI-023, tracked as backlog item B-011 below — NOT a regression introduced by WI-026). **Acceptance:** `pnpm --filter v0.7-mri-demo test` reports 12/12 passing on Windows (currently 11/12 — Test B fails). No other test changes. No source changes outside the example. | (none — orthogonal to WI-024) | approve | landed (impl `563122d`, B-011 follow-up `cc4bfe8`, merge `d53c1b3`, 2026-05-01) |
| WI-028 | Plan-state drift cleanup (WI-024/WI-026 ledger correction + merged-branch prune) | Janitorial pass to bring MASTER_PLAN.md's State column back into sync with git reality after a busy session. **Concrete corrections (this WI's content):** (a) WI-024's State column was `**not started — orchestrator-dispatched 2026-05-01**` despite the implementation having landed at `4b107a8` (the workspace-alias imports / stray-artifact / DECISIONS.md gitignore work shipped); corrected to `landed (4b107a8, 2026-05-01)`. (b) WI-026's State column was `in progress (orchestrator-dispatched 2026-05-01 — WI-015 ran-it follow-up)` despite the merge having landed at `d53c1b3`; corrected to `landed (impl 563122d, B-011 follow-up cc4bfe8, merge d53c1b3, 2026-05-01)`. (c) Add this WI-028 row itself (the dormancy hook requires a WI entry before any source/plan write, even for a doc-only fix). **Out of scope:** the merged feature-branch prune (`feature/docs-state-refresh`, `feature/f4-protocol-split`, `feature/f4-threat-model`, `feature/readme-refresh`, `feature/v2-self-hosting-plan`, `feature/wi-025-vector-search` — all fully merged into main per `git branch --merged main`) is a Guardian-gated git operation, not a plan edit; it happens via `git branch -d` in the user's prompt after this WI lands. **Acceptance:** `git diff --stat` on the worktree shows `MASTER_PLAN.md` only; the State column for WI-024/WI-026 reflects commit reality; no other rows touched. | (none — pure plan correction) | approve | landed (impl `16463fb`, merge `6463154`, 2026-05-01) |

v1 dependency waves: **W1** = `{WI-017, WI-018, WI-019}` (three parallel
leaves; WI-017 and WI-018 are pure code unblockers, WI-019 is the
plan-only design pass). **W2** = `{WI-016, WI-022}` (WI-016 depends on
WI-018's cache-seed helper landing first so the corpus tests can stably
seed the LLM-cache layer; WI-022 depends on WI-019 for the protocol
clarity that motivates persisting artifact bytes — see
DEC-V1-FEDERATION-WIRE-ARTIFACTS-002). **W3** = `{WI-020}` (the
read-only-mirror package can only satisfy the wire integrity gate after
WI-022 lands artifact bytes into `BlockTripletRow`). **W4** = `{WI-021}`
(the v1 demo requires real property tests, real parent-block lineage,
artifact-bytes-on-the-wire, and the read-only-mirror package). Critical
path runs WI-018 → WI-016 → WI-021. **First implementer dispatch was
WI-018 (DEC-V1-FIRST-DISPATCH-WI018-001); after the WI-020 reviewer
adjudication (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002) the active dispatch
sequence was WI-022 (registry artifact-bytes persistence) → WI-020
remediation (wire formula realignment) → WI-021. WI-022 landed (slices
a + b at `fe74afe` / `a169a42`); WI-020 remediation landed as
`wi-020-federation-mirror-v2` (v2 source `3269a03`, merge into main at
`9a7dcc2`). The active dispatch is now **WI-021 (v1 wave-1 demo +
acceptance)** — the final v1 wave-1 work item, closing the wave by
proving the cross-machine federation invariants end-to-end on a
substrate where every shaved atom carries a real property-test artifact
(WI-016) and a populated parent-block lineage (WI-017), and the wire
carries artifact bytes (WI-022 + WI-020). Evaluation Contract:
`tmp/eval-wi-021.json`. Scope Manifest: `tmp/scope-wi-021.json`. Two
non-blocking WI-020 reviewer findings are tracked as backlog items
B-008 (`Registry.enumerateSpecs()` primitive) and B-009 (`federation
pull --registry` persist-on-pull); both are explicitly out of scope for
WI-021 because (i) WI-021's federation pull goes through
`mirrorRegistry`, which already writes via `Registry.storeBlock` (the
B-009 hole only affects the diagnostic `pull-block`/`pull-spec` verbs),
and (ii) WI-021's `serveRegistry(registryA)` can supply the optional
`enumerateSpecs` callback inline against registryA's SQLite layer
without changing Registry's public surface (B-008 is a code-quality
cleanup, not a correctness requirement for the demo).**

**Backlog item B-011 (surfaced 2026-05-01 during WI-026 — static-mode
decompose chokes on `continue`/`break` inside loops):** WI-023 flipped
the default `intentStrategy` from `"llm"` to `"static"`. Under the new
default, the v0.7 mri-demo's `argv-parser.ts` source — which contains
`continue`/`break` inside its argv-iteration loop — no longer reaches a
clean `AnthropicApiKeyMissingError` at intent-extraction; instead it
gets past intent (no API call needed) and `decompose()` throws
`CanonicalAstParseError` because the slicer can't lift those
control-flow statements out of loop context when extracting nested
function bodies. Pre-existing decompose behavior, masked by the LLM
path's earlier API-key failure. **Why it matters for v2:** v2
self-hosting (WI-V2-01..10) requires shaving yakcc itself with the
static path as production default. yakcc's own source contains plenty
of `continue`/`break` inside loops; if `decompose()` chokes on them,
static-path atom-level coverage is materially below what bootstrap
two-pass equivalence (WI-V2-01) requires. **Suggested investigation:**
audit `packages/shave/src/recursion.ts` and the slicer for
`continue`/`break` handling; the right answer is likely (a) extract the
enclosing loop as the atom rather than slicing into the loop body, or
(b) reject the slice and surface a structured "unsliceable" sentinel
rather than throwing. Add `continue`/`break`-inside-loop fixtures to
`packages/shave`'s decompose test suite. **Acceptance for the eventual
fix:** `pnpm --filter v0.7-mri-demo test` passes 12/12 with Test B's
`intentStrategy: "llm"` argument REMOVED.

**Out of v1 wave-1 (deferred to a follow-on v1 wave or a sibling
initiative):** WASM backend in `@yakcc/compile`; `@yakcc/hooks-cursor` and
`@yakcc/hooks-codex`; F2+ attestation publishing path; large-scale
differential execution against upstream library sources (the v0.7 demo's
focused per-target test corpus stays the v1 demo's correctness bar; the
fuzz-driven cross-corpus differential pass deferred per DEC-V1-WAVE-1-SCOPE-001
below). This deferral is intentional: shipping F1 read-only mirror with
substantive L0 verification proves the cross-machine federation invariants
on a smaller surface; expanding to F2 publishing and large-scale fuzzing
without that proof point would conflate two independent risks.

### Initiative: v1 wave-2 — Claude Code integration + WASM

| ID | Title | Description | Deps | Gate | State |
|----|-------|-------------|------|------|-------|
| WI-025 | Vector-search retrieval API in @yakcc/registry | Wrap sqlite-vec KNN around the existing contract_embeddings table to deliver Registry.findCandidatesByIntent(intentCard, {k?, rerank?}) returning readonly CandidateMatch[]. Pipeline: derive query text from IntentCard (behavior + inputs.name+typeHint + outputs.name+typeHint joined) → generateEmbedding() (existing path) → vec0 KNN top-k against contract_embeddings → optional structural rerank via existing structuralMatch(spec, candidate). New CLI: yakcc query "<query>" [--top k] [--rerank] [--registry <path>] for free-text or card-file input. Embedding storage was wired in v0 (storage.ts:123-126); WI-025 is purely the query-side surface plus the CLI. Closes the gap that yakcc search today does linear-scan structural matching only with no semantic ranking. Acceptance: (i) findCandidatesByIntent returns results ordered by ascending cosineDistance; (ii) rerank: "structural" reorders by combined cosine + structural score; (iii) yakcc query against the seed corpus surfaces a relevant block within top-3 for at least 3 distinct natural-language queries; (iv) pnpm --filter @yakcc/registry test passes including new vector-search tests; (v) pnpm -r build clean. | (none — embedding infra wired in v0) | review | landed (impl `33817fe`, merge `594e628`, 2026-05-01) |
| WI-V1W2-WASM-01 | WASM backend scaffold in `@yakcc/compile` | Add `wasm-backend.ts` alongside the existing `ts-backend.ts` in `packages/compile/src/`; define `compileToWasm(assembly): Uint8Array` as the new entry point, mirroring the public shape of `compileToTypeScript` so the two backends are interchangeable at the assembly→artifact boundary. Wire emit-routing in `assemble.ts` (or the equivalent dispatch site) to switch backends by an explicit `target: "ts" \| "wasm"` parameter — no implicit detection, no parallel compile pipeline (Sacred Practice #12: the assembly graph and contract-resolution path are shared between backends; only the codegen tail differs). **Strategy choice deferred to implementer at dispatch time** (captured as `DEC-V1-WAVE-2-WASM-STRATEGY-001` per implementer's @decision annotation): three reasonable approaches are (a) `binaryen` JS bindings to build a Module programmatically, (b) hand-rolled WASM binary emitter against the WebAssembly binary spec, (c) emit WAT text and feed it to `binaryen`'s `parseText` to get a binary. Each has different complexity/dependency trade-offs and the implementer is closer to the codegen surface than the planner; the choice is captured at first-line-of-code time, not pre-committed here. **Acceptance:** a minimal `add(a: number, b: number): number` substrate compiles through `compileToWasm(...)` to a valid `.wasm` byte sequence that (i) decodes successfully through `WebAssembly.Module(bytes)` (no `CompileError`), (ii) instantiates and exports the `add` function, (iii) returns the same value as the ts-backend output for at least three input pairs (positive, negative, zero). `pnpm --filter @yakcc/compile test` passes including new wasm-backend tests; `pnpm -r build` clean. **Scope Manifest hint:** `packages/compile/src/wasm-backend.ts` (new), `packages/compile/src/assemble.ts` (route dispatch only), `packages/compile/test/wasm-backend.test.ts` (new); forbidden: any file under `packages/contracts/`, `packages/registry/`, `packages/ir/`, `packages/shave/`, `packages/federation/` (codegen is a leaf surface). Evaluation Contract and Scope Manifest authored at provisioning time. Pre-assigned decision: `DEC-V1-WAVE-2-WASM-STRATEGY-001` (closed by implementer's @decision annotation). | (none — additive, fully unblocked off main at `550eefe`) | review | **not started — wave-2 W1 dispatch pending** |
| WI-V1W2-WASM-02 | Type-lowering for primitives + structural types | Extend `wasm-backend.ts` to lower `number` (i32/i64/f64 by inferred numeric domain), `bigint` (i64 with overflow semantics), `boolean` (i32), `string` (linear-memory view + length, with host-mediated alloc/free), records (flat-struct in linear memory with field offsets), and arrays (length+pointer pair into linear memory) onto WASM values+memory. Numeric-domain inference reuses the existing `@yakcc/contracts` `IntentCard.inputs.typeHint` field (no new inference path — Sacred Practice #12); when `typeHint` is absent or ambiguous, default to f64 with a documented downgrade warning. **Acceptance:** parity test against `ts-backend` on substrates exercising 5 distinct type combinations: (i) `number → number` (numeric arithmetic, exercises i32/i64/f64 selection), (ii) `string → number` (length or codepoint-sum, exercises string-view lowering), (iii) `number → string` (decimal-format, exercises host-mediated string return), (iv) `record<{a:number,b:number}> → number` (sum-of-fields, exercises struct lowering), (v) `array<number> → number` (sum, exercises array length+pointer). Each substrate produces byte-equivalent results from both backends across at least 5 input cases. `pnpm --filter @yakcc/compile test` passes; `pnpm -r build` clean. The host-bindings used to mediate string return are stubbed at this WI's level (a minimal in-test host); the production host contract is WI-V1W2-WASM-03's job. | WI-V1W2-WASM-01 | review | **not started — blocked on WI-V1W2-WASM-01** |
| WI-V1W2-WASM-03 | Runtime/imports surface (memory, host bindings, error model) | Define the WASM-host import surface as a load-bearing v1-wave-2 contract: required imports (`memory` linear-memory instance shape, `host_log(ptr, len)` for diagnostic emission, `host_alloc(size): ptr` and `host_free(ptr): void` for string/array interchange, `host_panic(code, ptr, len)` for unrecoverable errors); required exports (`__wasm_export_<fn>` per emitted function, `_yakcc_table` placeholder for future indirect calls); trap → host-side throw mapping (`unreachable` → `WasmTrap`, division-by-zero → `WasmTrap`, integer-overflow per ts-backend semantics). Document the surface as a new `WASM_HOST_CONTRACT.md` at repo root, parallel to `FEDERATION_PROTOCOL.md`'s structure (sections: scope, imports, exports, error model, versioning, deferred surfaces). The contract is **the** authority for the wasm-host boundary (Sacred Practice #12: there is one contract, not "the doc says X but the test fixture does Y"); host implementations elsewhere in the repo MUST conform. **Acceptance:** a non-trivial substrate (≥3 functions, including string-handling and a panic path) compiled through `compileToWasm` executes against the documented host runtime and produces output byte-equivalent to the ts-backend output for at least 5 input cases including one that triggers `host_panic`. `WASM_HOST_CONTRACT.md` is committed at repo root; `pnpm --filter @yakcc/compile test` passes including a host-conformance test fixture; `pnpm -r build` clean. **Scope Manifest hint:** `packages/compile/src/wasm-backend.ts` (extend), `packages/compile/src/wasm-host.ts` (new — the in-process host runtime used by tests and downstream consumers), `WASM_HOST_CONTRACT.md` (new — repo-root doc), `packages/compile/test/wasm-host.test.ts` (new). Pre-assigned decision: `DEC-V1-WAVE-2-WASM-HOST-CONTRACT-001` (closed by implementer's @decision annotation: which trap classes map to which host-throw shapes; whether host_alloc must be a bump allocator or may be a free-list; whether memory growth is permitted in v1). | WI-V1W2-WASM-01 | approve | in progress (worktree dispatched 2026-05-02 — DEC-V1-WAVE-2-WASM-HOST-CONTRACT-001 closed: 7-kind WasmTrap union, bump allocator @ offset 16, no memory growth in v1; tests 77/77; awaits PR review) |
| WI-V1W2-WASM-04 | Parity harness + acceptance demo | Create `examples/v1-wave-2-wasm-demo/` analogue to `examples/v1-federation-demo/`: a programmatic harness running both backends (`compileToTypeScript` and `compileToWasm`) against property-test corpora and asserting equivalence at the output-value level. The harness reuses the existing v1 property-test corpus shape (per WI-016) where applicable; substrates that the WI-V1W2-WASM-02 type-lowering does not yet cover are marked as `pending` rather than skipped silently (Sacred Practice #12 / loud failure over silent fallback). **Acceptance:** the demo runs to completion against 3 substrates spanning the WI-V1W2-WASM-02 type matrix — (i) numeric (covers i32/i64/f64 paths), (ii) string-handling (covers linear-memory string view + host_alloc/free), (iii) mixed (record-of-numbers, exercises struct lowering + host bindings together). For each substrate, ≥10 property-test cases run through both backends and the harness asserts byte-equality of all outputs (or value-equality with documented float-tolerance for f64 substrates per existing ts-backend tolerance). The demo is invocable as `pnpm --filter v1-wave-2-wasm-demo test`; CI runs it on every commit (gated on the test suite, not on a separate workflow); `pnpm -r build` clean. **Scope Manifest hint:** `examples/v1-wave-2-wasm-demo/` (new directory), no source-code edits to `packages/*/`. **This is the v1 wave-2 WASM-track closer**: when this lands together with the IDE-hooks-track closers, v1 wave-2 closes per `DEC-V1-WAVE-2-SCOPE-001`. | WI-V1W2-WASM-02, WI-V1W2-WASM-03 | approve | **not started — blocked on WI-V1W2-WASM-02 + WI-V1W2-WASM-03** |
| WI-V1W2-HOOKS-01 | Production-harden `@yakcc/hooks-claude-code` | Replace the v0 passthrough stub in `packages/hooks-claude-code/src/index.ts` with real implementations of the hook contract documented in v0's facade DEC. **`registerSlashCommand()`** registers a `/yakcc` Claude Code slash command via Claude Code's slash-command extension API (the exact wiring point becomes the implementer's discovery — Claude Code's harness exposes a registration surface; the production wiring is what this WI delivers). **`onCodeEmissionIntent(ctx)`** is the load-bearing path: extract an `IntentCard` from the emission context (behavior text, input/output types from the immediate AST context), call `registry.findCandidatesByIntent(intentCard, { k: 5, rerank: "structural" })` (the WI-025 vector-search surface, already landed at `594e628`), and return one of three typed results: (a) `{ kind: "registry-hit", block }` for the top-1 candidate when its combined cosine+structural score exceeds a configurable threshold (default 0.65 — captured as `DEC-V1-WAVE-2-HOOKS-THRESHOLD-001` at implementer dispatch); (b) `{ kind: "synthesis-required", contractSpecSkeleton }` with a derived `ContractSpec` skeleton (signature lifted from the AST context, behavior-text from the prompt, property_tests left as placeholder for the human/synthesizer to fill); (c) `{ kind: "passthrough" }` only when the hook itself errors (registry-open failure, embedding-generation failure, etc) — `passthrough` is no longer the default-success path, it's the explicit-error path. **Closes** `DEC-HOOK-FACADE-V0` (the v0 stub DEC); **opens** `DEC-HOOK-CLAUDE-CODE-PROD-001` (production hook semantics: when registry-hit fires vs synthesis-required, threshold rationale, error-mode mapping). **Acceptance:** `pnpm --filter @yakcc/hooks-claude-code test` passes (currently has zero tests — this WI introduces the test suite); both registry-hit and synthesis-required paths are exercised against an in-memory `@yakcc/registry` instance seeded with at least 3 contract embeddings; the passthrough path is exercised by an injected registry-open failure; `pnpm -r build` clean. **Scope Manifest hint:** `packages/hooks-claude-code/src/index.ts` (rewrite), `packages/hooks-claude-code/src/intent-extraction.ts` (new), `packages/hooks-claude-code/test/` (new test suite), `packages/contracts/src/` is read-only-import (uses existing `IntentCard`/`ContractSpec` types — no contract changes). Pre-assigned decision: `DEC-V1-WAVE-2-HOOKS-THRESHOLD-001`. | WI-025 (already landed at `594e628`); fully unblocked off main at `550eefe` | review | **not started — wave-2 W1 dispatch pending** |
| WI-V1W2-HOOKS-02 | Scaffold `@yakcc/hooks-cursor` | New package at `packages/hooks-cursor/` mirroring the post-hardening shape of `@yakcc/hooks-claude-code`. As part of this WI, **rename the shared hook interface** in `@yakcc/hooks-claude-code` (or lift it into `@yakcc/contracts` if the type is small and stable) from `ClaudeCodeHook` → `IdeHook` and re-export from both packages so the type lives in one place (Sacred Practice #12: single source of truth — the IDE-hook contract is not Claude-Code-specific). Initial implementation wires the **registry-hit path only**: extract an `IntentCard` from Cursor's emission-context shape, call `registry.findCandidatesByIntent`, return `registry-hit` or `passthrough`. The `synthesis-required` path is deferred to a follow-on slice if Cursor's surface differs materially from Claude Code's at the contract-skeleton-derivation step (the deferral, if exercised, is captured as a backlog item, not silently). **Acceptance:** the package builds via `pnpm --filter @yakcc/hooks-cursor build`; `createHook(registry): IdeHook` is the public entry; one smoke test exercises the registry-hit path against an in-memory registry seeded with at least 1 contract embedding; the renamed `IdeHook` interface compiles in both `hooks-claude-code` and `hooks-cursor` consumers; `pnpm -r build` clean. **Scope Manifest hint:** `packages/hooks-cursor/` (new directory), `packages/hooks-claude-code/src/index.ts` (rename/re-export only — no semantic change beyond the rename), forbidden: any change to the WI-V1W2-HOOKS-01 production semantics for `hooks-claude-code` other than the type rename. | WI-V1W2-HOOKS-01 | review | **not started — blocked on WI-V1W2-HOOKS-01** |
| WI-V1W2-HOOKS-03 | Scaffold `@yakcc/hooks-codex` | New package at `packages/hooks-codex/` for OpenAI's Codex CLI, same pattern as WI-V1W2-HOOKS-02 but against Codex's emission-context surface. Implementer picks at dispatch how much of the contract fits in this slice: **registry-hit path is the minimum** (matches WI-V1W2-HOOKS-02 acceptance); `synthesis-required` is included only if Codex's surface makes it natural (the implementer makes that call against the actual Codex extension surface and documents the choice as `DEC-V1-WAVE-2-HOOKS-CODEX-SCOPE-001`). The shared `IdeHook` type from WI-V1W2-HOOKS-02 is consumed directly — no parallel hook interface (Sacred Practice #12). **Acceptance:** same shape as WI-V1W2-HOOKS-02 — package builds, `createHook(registry): IdeHook` public entry, one smoke test exercises the registry-hit path, `pnpm -r build` clean. **Scope Manifest hint:** `packages/hooks-codex/` (new directory); forbidden: any change to `hooks-claude-code` or `hooks-cursor` other than reading the shared `IdeHook` type. | WI-V1W2-HOOKS-01 | review | **not started — blocked on WI-V1W2-HOOKS-01** |

v1 wave-2 dependency map: **W1** = `{WI-V1W2-WASM-01, WI-V1W2-HOOKS-01}` (parallel; both unblock everything else in their respective track; both are fully unblocked off main at `550eefe` and may dispatch concurrently in sister sessions, since they touch disjoint packages — `@yakcc/compile` vs `@yakcc/hooks-claude-code` — with no merge-conflict surface). **W2** = `{WI-V1W2-WASM-02, WI-V1W2-WASM-03}` parallel after WI-V1W2-WASM-01 lands (type-lowering and host-contract are structurally orthogonal — type-lowering touches the codegen tail; host-contract touches the runtime surface and a new repo-root doc); `{WI-V1W2-HOOKS-02, WI-V1W2-HOOKS-03}` parallel after WI-V1W2-HOOKS-01 lands (disjoint packages: hooks-cursor vs hooks-codex). **W3** = `{WI-V1W2-WASM-04}` after WI-V1W2-WASM-02 + WI-V1W2-WASM-03 land (parity demo needs both type-lowering and host-contract to be stable). The hooks track terminates at W2 (HOOKS-02 and HOOKS-03 are scaffolds, not full demos; a v1-wave-3 may extend them once the WASM track has shipped and the IDE surfaces have soaked in real use). Critical path: WI-V1W2-WASM-01 → WI-V1W2-WASM-03 → WI-V1W2-WASM-04 (the host-contract is the longer of the two W2 WASM legs because it touches a load-bearing repo-root doc and requires `approve` gate). When WI-V1W2-WASM-04 + WI-V1W2-HOOKS-02 + WI-V1W2-HOOKS-03 all land, v1 wave-2 closes per `DEC-V1-WAVE-2-SCOPE-001`.

### Initiative: v1 wave-1 cleanup (B-008/B-009/B-010 promotion)

Status: **active.** Branched from v1 wave-1 closure at `d9cb449` (post-WI-021 land). This initiative promotes three small backlog items surfaced during the WI-020 v2 reviewer pass and the WI-021 demo reviewer pass into scoped work items. They are independent (touch disjoint packages) and may run in parallel after WI-029 lands; the recommended dispatch order is WI-029 → {WI-030, WI-031 in parallel}, because WI-029 simplifies the federation `serveRegistry` call surface that future demo work will consume. The runtime goal id is `g-v1-cleanup`.

**Renumber note (2026-05-01):** Originally drafted as WI-026/027/028. A concurrent session pushed a different "WI-026" (Windows-portability fix in v0.7-mri-demo acceptance harness) to `origin/main` first, claiming the WI-026 number. Per Sacred Practice #12 (single source of truth for state, no parallel mechanisms), this initiative renumbers to **WI-029/030/031** — next available numbers above the now-landed WI-025 and concurrently-landed WI-026. Eval contracts and scope manifests live at `tmp/eval-wi-029-enumerate-specs.json` / `tmp/scope-wi-029-enumerate-specs.json` (and the matching wi-030/wi-031 pair files). The runtime work-item rows under `cc-policy workflow work-item-set` track the new numbers; the prior `wi-026-enumerate-specs` runtime row is marked abandoned. Net effect: there is no WI-027 row in the table; the work is in WI-030.

Each row's source backlog entry, prior reviewer reference, and DEC linkage is named in the description; the backlog markers in `tmp/backlog.md` are flipped to "promoted (WI-xxx)" so the items are not double-counted.

| ID | Title | Description | Deps | Gate | State |
|----|-------|-------------|------|------|-------|
| WI-029 | `Registry.enumerateSpecs()` primitive (lifted from B-008) | Add `Registry.enumerateSpecs(): Promise<readonly SpecHash[]>` (sibling shape to existing async readers like `getBlock`/`findByCanonicalAstHash`) to `@yakcc/registry`'s public surface, implemented as a single `SELECT DISTINCT spec_hash FROM blocks ORDER BY spec_hash` prepared statement on the SQLite registry. Then drop the `enumerateSpecs?: () => Promise<readonly SpecHash[]>` field from `@yakcc/federation`'s `ServeOptions` and route `serveRegistry`'s `/v1/specs` handler through `registry.enumerateSpecs()` directly. Production callers become `serveRegistry(registry, { port, host })` with no inline callback. **Closes** the workaround documented in `DEC-SERVE-SPECS-ENUMERATION-020`; the planner will mark that DEC closed in a follow-up pass. **Wire format unchanged**: `/v1/specs` JSON shape stays byte-identical pre/post-WI-029; the change is the source of the array, not its representation. Acceptance: `serveRegistry(registry)` (no options arg) works against any registry; `ServeOptions.enumerateSpecs` is removed from the type; `pnpm --filter @yakcc/registry test` and `pnpm --filter @yakcc/federation test` both stay green; `pnpm -r build` is clean. The v1 federation demo's inline `enumerateSpecs:` argument at its `serveRegistry` call site is removed in this WI (pre-authorized in scope manifest) since the field's removal is a TypeScript-level break. Evaluation Contract: `tmp/eval-wi-029-enumerate-specs.json`. Scope Manifest: `tmp/scope-wi-029-enumerate-specs.json`. Source backlog: B-008 (post-WI-020 v2 reviewer finding). Implementer source diff already in flight on `feature/wi-026-enumerate-specs` worktree (uncommitted) at the time of renumber; Guardian renames branch+worktree to `feature/wi-029-enumerate-specs` before the next dispatch. | (none — fully unblocked off main at d9cb449) | review | landed (impl `af49e57`, merge `9cca308`, 2026-05-01 — closes B-008, DEC-SERVE-SPECS-ENUMERATION-020) |
| WI-030 | `federation pull --registry` persist-on-pull (lifted from B-009) | Wire the existing `--registry <db>` flag on `yakcc federation pull --remote <url> --root <merkleRoot>` to actually persist the pulled `BlockTripletRow` to the named registry. Today the flag is parsed but unused (per the doc-comment at `packages/cli/src/commands/federation.ts:311`: "—registry is accepted (for future persistence) but not required for the current read-only diagnostic pull path"). Implementation: open the registry via `openRegistry(registryPath)` when the flag is supplied, call `registry.storeBlock(row)` on success, close in a `finally` block. **storeBlock's existing `DEC-STORAGE-IDEMPOTENT-001` contract** provides idempotency at the (block_merkle_root) primary key boundary; **WI-022's storeBlock integrity-recompute** catches any byte corruption. The CLI MUST NOT pre-check, enrich, or batch — it is a pass-through between `pullBlock` and `storeBlock`. **Read-only fallback preserved**: when `--registry` is omitted, the existing diagnostic-only behavior is unchanged (no registry opened, no persistence). Three failure modes (registry-open-failure, pull-transport-failure, persist-failure) emit distinct `logger.error` messages so operators can route to the right fix. Acceptance: `yakcc federation pull --remote <url> --root <root> --registry <db>` inserts the row into the registry on success; second invocation is a no-op (count stays at 1); `--registry` omitted preserves diagnostic-only behavior; `pnpm --filter @yakcc/cli test` passes. **`pullBlock`'s signature is unchanged** — the persist coupling lives entirely at the CLI layer per the backlog scope note ("Out of scope: changing pullBlock / pullSpec signatures"). Evaluation Contract: `tmp/eval-wi-030-pull-persist.json`. Scope Manifest: `tmp/scope-wi-030-pull-persist.json`. Source backlog: B-009 (post-WI-020 v2 reviewer finding). | (none — fully unblocked off main at d9cb449; runs in parallel with WI-031) | review | landed (impl `8aece1c`, merge `710e895`, 2026-05-01 — closes B-009; this is the work originally tentatively numbered WI-027 in the cleanup-wave draft) |
| WI-031 | Wire intentCard attachment for multi-leaf plans in `@yakcc/shave` (lifted from B-010) | Close `DEC-UNIVERSALIZE-WIRING-001`'s deferred multi-leaf hole. Today `universalize()`'s multi-leaf branch in `packages/shave/src/index.ts` (around line 449, 'Per-leaf intentCard attachment is future work') leaves non-root NovelGlueEntries without an attached `intentCard`, so `maybePersistNovelGlueAtom` returns `undefined` for those leaves and they are never persisted as separate atoms. The slice produces multiple persisted atoms, exercising **WI-017**'s `parent_block_root` lineage substantively for the first time end-to-end through the offline-tolerant test pattern. Wiring strategy: implementer picks (a) per-leaf `extractIntent(leafSource, {offline:true})` (cache-first, with `seedIntentCache` supplying cards) OR (b) root-card-propagate with per-leaf field overrides (`behavior`, `inputs.name`, `outputs.name`); choice documented as a new @decision. The `parent_block_root` value passed to `maybePersistNovelGlueAtom` is the literal `BlockMerkleRoot` returned by the prior persist call for the outer atom (the contract documented at `atom-persist.ts:64-72`). **Offline-tolerance is non-negotiable**: tests run with `seedIntentCache` only, no live `ANTHROPIC_API_KEY`. **Determinism is non-negotiable**: re-running `universalize()` against the same source produces byte-identical persisted rows. Tests use `openRegistry(':memory:')` (real SQLite) so the `parent_block_root` assertion exercises actual persistence. Acceptance: shaving a multi-function source through `universalize()` in the offline-tolerant pattern produces multiple `BlockTripletRows` on a registry, with non-root rows carrying populated `parent_block_root`; `pnpm --filter @yakcc/shave test` stays green at 277+ tests. After WI-031 lands, **WI-021's eval contract may be re-tightened** (per `DEC-WI021-EVAL-REVISION-001`) to require non-trivial WI-017 lineage exercise in the v1 federation demo — that re-tightening is a separate planner pass. Evaluation Contract: `tmp/eval-wi-031-multi-leaf-intent.json`. Scope Manifest: `tmp/scope-wi-031-multi-leaf-intent.json`. Source backlog: B-010 (post-WI-021 reviewer finding). | (none — fully unblocked off main at d9cb449; runs in parallel with WI-030) | review | landed (impl `8dfb44b`, merge `3049ec3`, 2026-05-01 — closes B-010, DEC-UNIVERSALIZE-WIRING-001 / DEC-UNIVERSALIZE-MULTI-LEAF-INTENT-001; concurrent-session convergent commit `f3092ca` archived on `feature/wi-031-multi-leaf-intent` for B-012 test-coverage merge) |
| WI-032 | README accuracy refresh + missing core-package docs | Audit pass found `README.md` (root), `packages/registry/README.md`, and `packages/cli/README.md` carry false claims about v1 capability state — root and registry both say `findCandidatesByIntent` is "planned (WI-025)" when it shipped at `33817fe`/`af49e57`/`9cca308`; root says the v1 federation demo "has not been run yet" when WI-021 landed at `d9cb449`; CLI README's commands table omits `query` (WI-025) and the entire `federation` subcommand family (`serve`/`mirror`/`pull-block`/`pull-spec`, all WI-020) plus the now-active `--registry` persist flag (WI-030 at `8aece1c`). Three core packages (`@yakcc/shave`, `@yakcc/federation`, `@yakcc/variance`) lack READMEs entirely despite being central to v1's surface; `@yakcc/shave` exports 50+ symbols including the multi-leaf intentCard wiring just landed in WI-031 (`3049ec3`, `DEC-UNIVERSALIZE-MULTI-LEAF-INTENT-001`). This WI: (a) corrects the false claims in the three existing READMEs, (b) creates the three missing READMEs grounded in actual `src/index.ts` exports, (c) adds a brief mention of WI-031's multi-leaf wiring + WI-030's persist-on-pull to the relevant new READMEs. Acceptance: `pnpm -r build` stays clean; no source files modified; new READMEs accurately reflect the public API surfaces of their respective packages; all stale claims about "not yet wired" / "planned" features that have actually shipped are removed. | (none — pure documentation) | approve | landed (impl `26ab966`, merge `333c68b`, 2026-05-01) |
| WI-033 | Fix B-011: slicer chokes on `continue`/`break` inside loops (`DEC-SLICER-LOOP-CONTROL-FLOW-001`) | Bug surfaced live by user via `node packages/cli/dist/bin.js shave examples/v0.7-mri-demo/src/argv-parser.ts --offline` (post WI-032 merge): `decompose()` extracts a loop body containing `continue`, `canonicalAstHash` parses it standalone, ts-morph emits TS1313 (`'continue' not in enclosing iteration`), `canonical-ast.ts:356` raises `CanonicalAstParseError`. **Strategy A (chosen):** when a loop's body has escaping `continue`/`break`/labeled-jump, the slicer's `decomposableChildrenOf` returns `[]` and `recurse()` emits an `AtomLeaf` for the loop itself with `atomTest.reason = "loop-with-escaping-cf"` (new variant of `AtomTestReason`). New predicate `hasEscapingLoopControlFlow(blockNode)` walks descendants for `ContinueStatement`/`BreakStatement`, finds each statement's binding scope (nearest loop ancestor for `continue`, loop-or-switch for `break`, label match for labeled), and returns `true` when the binding scope lies outside the block. Atom granularity coarsens ~15-30% in affected functions; strictly better than current total-failure state. Strategies B (typed unsliceable sentinel) and C (rewrite `continue`→`return`) explicitly rejected — see DEC body in `recursion.ts`. Closes B-011. Removes the WI-026 workaround (`intentStrategy: "llm"` pin) from `examples/v0.7-mri-demo/test/acceptance.test.ts` Test B. **Verified:** `node packages/cli/dist/bin.js shave examples/v0.7-mri-demo/src/argv-parser.ts --offline` exits 0 producing 13 atoms (the big atom at `[2793..4540]` is the `parseArgv` while-loop, now correctly atomic per the fix); `pnpm --filter v0.7-mri-demo test` 12/12 with `intentStrategy: "llm"` removed; `pnpm --filter @yakcc/shave test` 290 passed/1 skipped (was 285, +5 new tests covering continue/break/labeled-break/break-in-switch/argv-parser-fixture); `pnpm -r build` clean across all 12 packages. | (none — orthogonal to WI-030/WI-031) | approve | landed (impl `0e974bc`, merge `ba9c55a`, 2026-05-01 — closes B-011, DEC-SLICER-LOOP-CONTROL-FLOW-001) |
| WI-034 | Yakcc self-shave survey + slicer predicate extension for escaping `return`/`await`/`yield` (`DEC-SLICER-FN-SCOPED-CF-001`) | Programmatic survey running `@yakcc/shave`'s `universalize()` (with license bypass via SPDX header prepend, since yakcc's own files lack SPDX comments — itself a backlog item, B-012) over 117 source files in `packages/*/src/`. **Baseline at WI-033 (commit `ba9c55a`): 70/117 success (59.8%).** Failure breakdown: 35 × `canonical-ast--return-outside-function`, 9 × `canonical-ast--await-outside-async`, 2 × `did-not-reach-atom`, 1 × `canonical-ast-other`. 44 of 47 failures share one shape: the slicer extracts a non-leaf node (IfStatement, TryStatement, Block) whose source contains a `return`/`await`/`yield` whose binding scope (the enclosing function) is outside the extracted node. Existing `safeCanonicalAstHash` in `recursion.ts:170-204` already wraps **leaf** statements (`ReturnStatement`, `ContinueStatement`, `BreakStatement`, `YieldExpression`) in a synthetic `function __w__() { … }`; the bug is it doesn't catch **non-leaf** nodes that contain those constructs. **Fix:** extend `safeCanonicalAstHash` with `detectEscapingFunctionScopedConstructs(node)` predicate that walks descendants checking each `ReturnStatement`/`AwaitExpression`/`YieldExpression`'s binding scope. When escaping detected, wrap in `function __w__() { … }`, `async function __w__() { … }`, or `function* __w__() { … }` flavor as appropriate. Last-resort fallback: `canonicalAstHash(fullSource, { start, end })` — full source always contains the original binding scopes; emitCanonical scopes the hash to the inner range so the result is wrap-independent. Reference sketch + tests + DEC text in `tmp/wi-034-predicate-extension-sketch.md`. **Backlog items filed by this WI:** B-012 (yakcc source files lack SPDX-License-Identifier comments — license gate refuses 116/117 files without bypass), B-013 (2 files hit `did-not-reach-atom`: needs slicer policy investigation per file), B-014 (1 file hits `';' expected` — `packages/cli/src/bin.ts`; needs ts-morph triage). Survey artifacts: `tmp/v2-self-shave-survey.mjs` (the script), `tmp/v2-self-shave-survey.json` (raw per-file data), `tmp/v2-self-shave-survey.md` (human report). **Acceptance:** post-fix re-run shows ≥95% success rate; 5 new recursion.test.ts cases (if-with-return, try-catch-with-return, async-await-in-loop-body, generator-with-yield-in-if, yakcc-self-shave-fixture) all green; `pnpm --filter @yakcc/shave test` 290+ stays green plus the new tests; `pnpm -r build` clean. | (none — orthogonal to brother session's WI-035 bootstrap two-pass equivalence harness) | approve | landed (impl `b3da220` + slicer-fix `cfcf603`, merge `51bf263`, 2026-05-02 — DEC-SLICER-FN-SCOPED-CF-001; baseline 70/117 (59.8%) → post-fix 108/117 (92.3%) self-shave success; remaining 9 failures filed as B-013/B-014; backlog also opened B-012 SPDX-headers gap) |
| B-012 | yakcc source files lack SPDX-License-Identifier headers (license gate refuses 116/117 own files without bypass) | The license gate (`packages/shave/src/license/gate.ts`) refuses unknown-licensed sources by design. yakcc IS MIT-licensed (per repo `LICENSE`), but virtually no `.ts` source file under `packages/*/src/` carries an `// SPDX-License-Identifier: MIT` comment. Result: WI-034's self-shave survey saw 116/117 files refused at the license gate before reaching decompose; only the survey's bypass (synthetic SPDX prepend) revealed real decompose behavior. **Action:** add `// SPDX-License-Identifier: MIT` as the first line of every `.ts` source file in `packages/*/src/` and `examples/*/src/`. ~117 file edits (single-line prepends, mechanical). After B-012 lands, the WI-034 survey can run via the public `shave()` API without the SPDX-prepend hack. **Why it matters for v2:** WI-V2-01 bootstrap two-pass equivalence will run yakcc on yakcc; yakcc's license gate on yakcc's own source has to accept the source for any of this to work. Surfaced by WI-034 (2026-05-02). |
| WI-036 | Extend `decomposableChildrenOf` for ClassDeclaration / ExpressionStatement / VariableStatement (closes most of B-013) | WI-034's post-fix audit left 9 self-shave failures, of which 7 are `did-not-reach-atom`. Inspection of those 7 reveals the slicer's `decomposableChildrenOf` (`packages/shave/src/universalize/recursion.ts:331-450`) has no policy for three node kinds: **ClassDeclaration** (1 file: `packages/registry/src/storage.ts` — a 20KB class), **ExpressionStatement** (2 files), **VariableStatement** (2 files). The 2 remaining `did-not-reach-atom` are ReturnStatement-shaped nodes that need separate investigation. **Strategy:** add three new dispatch branches: (a) `ClassDeclaration` → array of methods + accessors + constructor + static blocks (the obvious decomposable units); (b) `ExpressionStatement` → `[expression]` (an ExpressionStatement is just `expr;` — the wrapped expression is what carries the atomic content); (c) `VariableStatement` → declarations' initializer expressions (skip `const x: T;` declarations with no initializer). Plus: investigate the 1 remaining `await-outside-async` in `packages/federation/src/pull.ts` — likely an arrow-function async detection edge case in WI-034's `nodeIsAsync` predicate. **Acceptance:** post-fix re-run shows ≥97% success rate (target: 113-115/117); no existing shave test regressions; brother session's WI-V2-01 demo subset `packages/contracts/src/ + packages/registry/src/` reaches 13/13 (100%) — first-contact bootstrap now possible without per-file workarounds. New tests in `packages/shave/src/universalize/recursion.test.ts` covering: class with methods decomposes, expression-statement-with-arrow-fn decomposes, variable-statement-with-arrow-init decomposes, await-in-arrow-async edge case. **Out of scope:** the 2 ReturnStatement-shaped did-not-reach (deferred per-file investigation), the 1 cli/bin.ts `';' expected` (B-014). | (none — orthogonal to brother session's WI-035 bootstrap two-pass equivalence harness; touches `@yakcc/shave` only) | approve | in progress (orchestrator-dispatched 2026-05-02 — Task A continuation; baseline 108/117 (92.3%) → post-fix 110/117 (94.0%) self-shave success; contracts+registry subset 13/13; 4 new dispatch branches: ClassDeclaration/ClassExpression, ExpressionStatement, VariableStatement, CallExpression; nodeIsAsync fix; 5 new tests; 300/300 shave tests pass) |
| WI-V2-BOOT-PREFLIGHT | v2 bootstrap demo — slicer determinism preflight | Validates the load-bearing assumption that yakcc's slicer is deterministic across runs (BlockMerkleRoot is content-addressed; if two passes over the SAME source produce different hashes, content addressing is broken and the bootstrap demo cannot work). Script `tmp/v2-bootstrap-preflight.mjs` ran `universalize()` 3 times each over 5 representative yakcc source files (merkle.ts/storage.ts/serve.ts/strict-subset.ts/shave.ts), captured `slicePlan` summaries (kind+sourceRange+canonicalAstHash per entry), byte-compared all passes. **Result: PASS** — all 5 files produce identical slice plans across 3 runs (23/96/36/56/26 entries respectively). Performance note: large files take 23-31s each; full 118-file bootstrap will take ~30-60 min. Determinism is empirical, not just designed-in. | (none — read-only) | approve | landed (preflight-only WI; no source changes; 2026-05-02) |
| WI-V2-BOOTSTRAP-01 | Registry.exportManifest() primitive for v2 bootstrap demo | Add `Registry.exportManifest(): Promise<readonly BootstrapManifestEntry[]>` to `@yakcc/registry`'s public surface. Returns the registry's full block content as a sorted, deterministic JSON-friendly array — one entry per stored block, sorted by `blockMerkleRoot` ASCII ASC. Each entry: `{blockMerkleRoot, specHash, canonicalAstHash, parentBlockRoot, implSourceHash, manifestJsonHash}` (NO `createdAt`, NO ROWID — both are non-deterministic and the merkle root excludes them anyway, see `packages/contracts/src/merkle.ts:158`). `implSourceHash` and `manifestJsonHash` are BLAKE3 of the corresponding artifact bytes (re-derive from the existing `block_artifacts` table; no schema change). **Why:** WI-V2-BOOTSTRAP-03's `--verify` mode must compare a freshly-shaved registry against a committed `bootstrap/expected-roots.json`; comparing raw SQLite bytes is impossible (`Date.now()` taint), so the comparison happens at the JSON-manifest layer. **Public surface:** `BootstrapManifestEntry` interface in `@yakcc/registry`'s types; `exportManifest()` method on the `Registry` interface; SQLite implementation in `packages/registry/src/storage.ts` runs a single `SELECT ... FROM blocks JOIN block_artifacts ...` query and constructs the array. **Acceptance:** `pnpm --filter @yakcc/registry test` green with 2+ new tests (basic shape; determinism: store 5 blocks, dump manifest twice, byte-compare); `pnpm --filter @yakcc/registry typecheck` clean; no public-API changes beyond the additive method. | (none — pure additive on @yakcc/registry; orthogonal to brother's WASM/hooks territory) | approve | in progress (orchestrator-dispatched 2026-05-02 — landed locally; 4 new tests (empty registry, sorted-on-insert-order-divergence, deterministic-across-calls, hash-correctness); 93/93 registry tests pass; awaits Guardian merge before WI-V2-BOOTSTRAP-02 dispatch) |
| WI-V2-BOOTSTRAP-02 | yakcc bootstrap CLI verb (one-shot mode) | Add `yakcc bootstrap` CLI verb in `packages/cli/src/commands/bootstrap.ts`, register in CLI dispatch (`packages/cli/src/index.ts` + `packages/cli/src/bin.ts`). Walks `packages/*/src/**/*.ts` and `examples/*/src/**/*.ts` (skip `__tests__/`, `__fixtures__/`, `__snapshots__/`, `*.test.ts`, `*.d.ts`, `vitest.config.ts`), sorts the file list lexicographically (DEC-V2-BOOT-FILE-ORDER-001), calls `await shaveImpl(absPath, registry, {offline: true})` per-file. Captures per-file outcomes into a structured JSON report. CLI flags: `--registry <path>` (default `bootstrap/yakcc.registry.sqlite` — gitignored), `--report <path>` (default `bootstrap/report.json`), `--manifest <path>` (default `bootstrap/expected-roots.json`). Force `corpusOptions: { disableSourceC: true }` so AI-derived corpus cache hits don't introduce non-determinism (DEC-V2-BOOT-NO-AI-CORPUS-001). After all files shave, calls `registry.exportManifest()` (WI-V2-BOOTSTRAP-01) and writes the result to `--manifest`. Exit 0 only if all files succeed (118/118 today); failures emit per-file errors and exit 1. **Acceptance:** `node packages/cli/dist/bin.js bootstrap` on a clean checkout produces 118 successful shaves and writes a valid `expected-roots.json` (sorted by blockMerkleRoot, every entry well-formed). `pnpm --filter @yakcc/cli test` includes a smoke test that runs bootstrap against a fixture mini-project and asserts manifest shape. | WI-V2-BOOTSTRAP-01 (needs `exportManifest`) | approve | landed (impl 6d9bd3c, merge 5d10ee1, 2026-05-02 — 5 new bootstrap tests (63/63 cli suite green), smoke run: 121/126 files shaved (5 pre-existing license failures: GPL fixture + 4 SPDX-missing hooks/wasm files, all tracked under B-012), manifest: 1739 entries byte-identical across 3 independent runs; unblocks WI-V2-BOOTSTRAP-03) |
| WI-V2-BOOTSTRAP-03 | yakcc bootstrap --verify mode + committed expected-roots.json | Extend `bootstrap.ts` (WI-V2-BOOTSTRAP-02) with a `--verify` flag. When set, the command shaves all files into a fresh `:memory:` registry, dumps the manifest via `exportManifest()`, byte-compares against the committed `bootstrap/expected-roots.json`. Exit 0 only on byte-equal match. On mismatch, emits a structured diff (added merkle roots, removed merkle roots, changed-source paths grouped by their merkle roots). Then commit the canonical `bootstrap/expected-roots.json` to the repo (the artifact that "implements what we preach" — sorted JSON of every yakcc atom's content address). Add `bootstrap/yakcc.registry.sqlite` and `bootstrap/yakcc.registry.sqlite-{wal,shm}` to `.gitignore`. **Acceptance:** `yakcc bootstrap --verify` exits 0 on a clean checkout from origin/main; modifying any source file (even a comment-only edit that changes `canonicalAstHash` for some atom) fails verify with a structured diff naming the changed `BlockMerkleRoot`(s); `bootstrap/expected-roots.json` is checked in (~118 entries; ~30-50KB); `pnpm --filter @yakcc/cli test` includes a verify-mode test. | WI-V2-BOOTSTRAP-02 | approve | landed (impl 8e42994, 2026-05-03 — DEC-V2-BOOTSTRAP-EMBEDDING-001: bootstrap uses zero-vector EmbeddingProvider so exportManifest() runs without huggingface.co network dep; DEC-V2-BOOTSTRAP-VERIFY-001: --verify uses :memory: registry + byte-identity gate; runVerify() builds VerifyDiff (addedRoots/removedRoots grouped by source path); 8/8 cli bootstrap tests pass including 3 new verify tests (byte-identical OK, stale-manifest structured diff, missing-manifest error); expected-roots.json committed: 1766 entries from 122/129 files (7 LicenseRefusedError — 1 GPL fixture + 6 SPDX-missing files match existing B-012); closes #8) |
| WI-V2-BOOTSTRAP-04 | docs/V2_SELF_HOSTING_DEMO.md + CI integration | Document the full bootstrap demo procedure in `docs/V2_SELF_HOSTING_DEMO.md` (fresh-clone reproduction in 3 commands: `pnpm install`, `pnpm -r build`, `node packages/cli/dist/bin.js bootstrap --verify`). Update root `README.md` with a one-paragraph callout pointing at the doc. Add a CI step (`.github/workflows/bootstrap.yml` or extend existing) that runs `yakcc bootstrap --verify` on every push to main and on every PR. CI failure = source change without `expected-roots.json` regeneration = drift caught at PR time. **Acceptance:** CI step runs and stays green on `main` post-WI-V2-BOOTSTRAP-03 merge; doc is grounded against a real fresh-clone reproduction; `bootstrap --verify` runtime in CI is acceptable (~30-60 min — separate workflow if needed). | WI-V2-BOOTSTRAP-03 | approve | not started — sequential after WI-V2-BOOTSTRAP-03 lands |
| WI-038 | Drive yakcc-self-shave from 96.6% to 100% — surgical fix for 4 residual failures | After WI-037 closed 7 of the 7 known categories and bumped to 96.6% (114/118), 4 failures remain — but they're a *different shape* than what WI-037 set out to solve. **(a)** 3 × `recursion-depth-exceeded` (`packages/federation/src/serve.ts`, `packages/ir/src/strict-subset.ts`, `packages/shave/src/universalize/recursion.ts`) — the slicer DOES descend now (WI-037 fixed the did-not-reach-atom path) but hits the default `maxDepth=8` ceiling on deeply-nested Promise/callback chains. **Fix:** raise the default `maxDepth` from 8 to 24 in `packages/shave/src/universalize/recursion.ts` `RecursionOptions`. The depth limit was set conservatively for v0.7 when the slicer rarely descended past 3-4 levels; post-WI-036/037 the legitimate descent depth grows for real-world code with Promise callbacks, IIFE wrappers, and deeply-nested object literals. Verify no test regression (existing tests should comfortably fit under the new ceiling). **(b)** 1 × `canonical-ast--await` in `packages/federation/src/pull.ts` — two combined root causes: (1) `nodeIsAsync` using ts-morph's `isAsync()` without try/catch could throw for certain node kinds (e.g. MethodDeclaration shorthand on ObjectLiteralExpression); (2) `safeCanonicalAstHash`'s `CONTEXT_DEPENDENT_STATEMENT_KINDS` branch for `ReturnStatement` always wrapped in `function __w__() { ... }` even when the return contained an `await` — fixed by using `detectEscapingFunctionScopedConstructs` to choose the appropriate async/non-async wrapper. Both fixes together resolve the canonical-ast--await path. **Acceptance:** post-fix re-run of `tmp/v2-self-shave-survey.mjs` shows **100% (118/118)**; all `pnpm -r build` (all packages), `pnpm --filter @yakcc/shave test` (307 passed/1 skip, +3 new WI-038 tests), `pnpm --filter @yakcc/compile test` (48/48), `pnpm --filter v0.7-mri-demo test` (12/12) stay green; CLI smoke `node packages/cli/dist/bin.js shave packages/federation/src/pull.ts --offline` exits 0; `DEC-SLICER-MAX-DEPTH-001` annotation added to recursion.ts. | (none — touches `@yakcc/shave` only) | approve | landed (impl commit TBD, 2026-05-02 — baseline 114/118 (96.6%) → post-fix 118/118 (100.0%) self-shave success; DEC-SLICER-MAX-DEPTH-001; 3 new recursion.test.ts cases) |
| WI-037 | Drive yakcc-self-shave to 100% — bundles the 4 remaining gaps in one pass | After WI-036 left us at 110/117 (94.0%), 7 failures remain across 4 categories. WI-037 closes all four in a single coordinated dispatch: **(a)** Add ConditionalExpression → `[cond, then, else]` and BinaryExpression → `[left, right]` to `decomposableChildrenOf` in `packages/shave/src/universalize/recursion.ts` (~20 LOC, addresses the ~4 expression-level failures). **(b)** Add ReturnStatement → `[expression]` to `decomposableChildrenOf` so non-leaf returns (`return <giant arrow fn>` style in `federation/http-transport.ts` and `federation/serve.ts`) get a child to descend into; the existing `safeCanonicalAstHash` already wraps such fragments correctly via the WI-034 escaping-function-scoped predicate. **(c)** Triage `packages/cli/src/bin.ts` `';' expected` failure: hypothesis is shebang-line interaction with the survey's SPDX prepend (the survey originally injected SPDX as line 1 *before* the shebang, which broke parsing); the survey script in this WI's `tmp/v2-self-shave-survey.mjs` has been updated to inject SPDX as line 2 when shebang is present, which should resolve cli/bin.ts. If a real bug remains beyond the SPDX-position issue, add a per-file note in MASTER_PLAN. **(d)** B-012 SPDX header sweep: write a script in `tmp/wi-037-spdx-sweep.mjs` that adds `// SPDX-License-Identifier: MIT` to every `.ts` source file under `packages/*/src/` and `examples/*/src/` (NOT under `__tests__/`, `__fixtures__/`, `__snapshots__/`, `dist/`, or `node_modules/`; NOT to `.test.ts` files; NOT to `.d.ts` files). For files starting with `#!/usr/bin/env node` shebang, inject SPDX on line 2 (preserve shebang as line 1 — required by OS for executability). Skip files that already carry an SPDX header. Run the script, verify the diff is clean (only line additions, no content modifications), commit the file changes. After B-012 lands, the actual `yakcc shave foo.ts` CLI works on yakcc's own source without the survey's bypass. **Acceptance:** post-fix re-run of `tmp/v2-self-shave-survey.mjs` shows ≥99% success rate (≥116/117); all `pnpm -r build`, `pnpm --filter @yakcc/shave test`, `pnpm --filter @yakcc/compile test`, `pnpm --filter v0.7-mri-demo test` stay green; CLI smoke `node packages/cli/dist/bin.js shave packages/contracts/src/canonical-ast.ts --offline` exits 0 (NO bypass, real CLI hitting the actual license gate); ≥110 source files have new SPDX headers (B-012's mechanical sweep); 2-4 new recursion.test.ts cases covering ConditionalExpression/BinaryExpression/ReturnStatement-with-expression decomposition. Closes B-012 and B-013 and B-014 simultaneously. | (none — touches `@yakcc/shave` source + ~117 SPDX-only edits in `packages/*/src/` and `examples/*/src/`; brother session has just landed WI-V2-01 in `packages/ir/`; no concurrent dispatches expected on `@yakcc/shave` or the SPDX file set) | approve | in progress (orchestrator-dispatched 2026-05-02; baseline 110/117 (94.0%) → post-fix 114/118 (96.6%) self-shave success; SPDX sweep touched 119 files; remaining 4 failures: 3 recursion-depth-exceeded [serve.ts/strict-subset.ts/recursion.ts] + 1 canonical-ast--await [pull.ts]; closes B-012/B-013 partially/B-014) |

v1-cleanup dispatch order: **WI-029** dispatches first (smallest, simplifies federation surface, removes a parameter the demo's call site currently supplies). After WI-029 lands, **WI-030 and WI-031 may dispatch in parallel** (disjoint packages: cli vs shave; both off the same main base SHA d9cb449; no merge conflicts expected). Each WI is a separate feature branch with its own worktree; rollback is per-WI. The runtime goal `g-v1-cleanup` ends when all three are landed and their backlog markers in `tmp/backlog.md` are flipped to `landed (WI-xxx)`. After v1-cleanup closes, the planner SHOULD schedule a follow-up pass to (a) close `DEC-SERVE-SPECS-ENUMERATION-020` in the decision log; (b) close the `DEC-UNIVERSALIZE-WIRING-001` deferred-multi-leaf clause and link to the new wiring-strategy DEC; (c) consider re-tightening WI-021's eval contract per `DEC-WI021-EVAL-REVISION-001` now that B-010 is closed.

### Initiative: v2 self-hosting wave-1 (parallel WI-V2-01 + WI-V2-02)

Status: **active 2026-05-01.** The user authorized two parallel high-leverage v2 W1 dispatches off main at `ba9c55a` (post-WI-033 / continue-break slicer fix). WI-V2-01 (whole-project IR validator mode) is the prerequisite for every other v2 phase per the conformance audit; WI-V2-02 (fix the 4 real IR-conformance violations) is structurally independent and runs in a sister session. The two WIs touch disjoint surfaces (WI-V2-01 in `packages/ir`; WI-V2-02 in `packages/contracts/src/embeddings.ts` + `packages/ir/src/strict-subset-cli.ts` + `packages/cli/src/bin.ts`) so they can execute concurrently without merge conflict. WI-V2-01's self-validation evidence is the input that confirms WI-V2-02's choice of fix sites for the singletons and CLI entry-points.

| ID | Title | Description | Deps | Gate | State |
|----|-------|-------------|------|------|-------|
| WI-V2-01 | Whole-project IR validator mode | Add `validateStrictSubsetProject(tsconfigPath): Promise<ProjectValidationResult>` to `@yakcc/ir` (or, alternatively, a `mode: 'project' \| 'isolated'` option on existing `validateStrictSubset`; implementer picks per `DEC-V2-IR-PROJECT-MODE-001`). The new mode loads a real `tsconfig.json` via ts-morph's `tsConfigFilePath` constructor option and resolves cross-file relative imports, workspace `@yakcc/*` cross-package imports, and `node:*` builtin imports through the actual TypeScript resolver — eliminating the ~98% false-positive `no-untyped-imports` rate seen in isolated mode against whole-package source (per `~/.claude/plans/v2-ir-conformance-audit.md` 2026-05-01). Both modes consume the SAME rule registry (Sacred Practice #12); project mode does NOT relax any substantive rule; the only behavioral difference is that no-untyped-imports stops emitting false positives because real resolution succeeds. Acceptance includes a self-validation pass against `packages/ir/tsconfig.json` producing zero or near-zero false-positive no-untyped-imports while still surfacing the 4 real violations that become WI-V2-02's input. Evaluation Contract: `tmp/eval-wi-v2-01-ir-project-mode.json`. Scope Manifest: `tmp/scope-wi-v2-01-ir-project-mode.json`. Pre-assigned decision: `DEC-V2-IR-PROJECT-MODE-001` (closed by implementer's @decision annotation). | (none — pure additive) | review | landed (impl `a968416`, merge `e972b9c`, 2026-05-01 — DEC-V2-IR-PROJECT-MODE-001; 99/99 IR tests green, 11 new project-mode tests, 5 fixtures across 14 files) |
| WI-V2-02 | Fix the 4 real IR-conformance violations | Two singleton mutables in `packages/contracts/src/embeddings.ts:49,113` (refactor `let` to function-scoped closure or Map cache); two CLI entry-point top-level dispatches in `packages/ir/src/strict-subset-cli.ts:111` and `packages/cli/src/bin.ts:7` (either wrap in `if (import.meta.url === ...) main()` pattern, or relax `no-top-level-side-effects` with a documented `// @cli-entry` exemption captured as `DEC-IR-CLI-ENTRY-EXEMPTION-001`). Implementer picks the strategy per call site at dispatch. Acceptance: WI-V2-01's self-validation pass goes from "4 real violations" to "0 violations" against the same fixed source set. | (none — structurally orthogonal to WI-V2-01) | review | in progress (orchestrator-dispatched 2026-05-01, sister session) |

WI-V2-01 + WI-V2-02 together complete the v2 wave W1 (`{WI-V2-01, WI-V2-02}` per the dependency-wave map below). When both land, WI-V2-03 + WI-V2-04 (W2) become unblocked.

### Initiative: v2 self-hosting

Status: **planned.** Gated on v0.7 closure (WI-015 demo, done) and v1 wave-1 closure (WI-021 federation demo). Detailed phase breakdown landed 2026-05-01 informed by the IR conformance audit (`~/.claude/plans/v2-ir-conformance-audit.md`); WIs are marked "deferred" until both gating demos run.

| ID | Title | Description | Deps | Gate | State |
|----|-------|-------------|------|------|-------|
| WI-V2-01 | Whole-project IR validator mode | Add a "project mode" to `@yakcc/ir`'s `validateStrictSubset` API that loads a real `tsconfig.json` and resolves cross-file/cross-package/Node-builtin imports before running rules. Today the validator runs in isolated-file mode using a fresh in-memory ts-morph Project per call — fine for block-level seed-corpus validation, but yields ~98% false-positive `no-untyped-imports` violations when run against whole-package source (per audit 2026-05-01). New API: `validateStrictSubsetProject(tsconfigPath): ProjectValidationResult`. Pre-assigned decision: `DEC-V2-IR-PROJECT-MODE-001`. The validator is the prerequisite for every other v2 phase. | (none — pure additive) | review | deferred (v2 gate) |
| WI-V2-02 | Fix the 4 real IR-conformance violations | Two singletons in `packages/contracts/src/embeddings.ts:49,113` (refactor `let` to function-scoped closure or Map cache); two CLI entry-point dispatches in `packages/ir/src/strict-subset-cli.ts:111` and `packages/cli/src/bin.ts:7` (either wrap in `if (import.meta.url === ...) main()` pattern, or relax the `no-top-level-side-effects` rule with a `// @cli-entry` exemption documented as `DEC-IR-CLI-ENTRY-EXEMPTION-001`). Both choices are reasonable; pick at WI dispatch. | (none) | review | deferred (v2 gate) |
| WI-V2-03 | IR subset extensions for self-hosting (Phase B) | Audit-driven: extend `@yakcc/ir` to accept the constructs yakcc itself uses but the IR doesn't yet. Likely candidates: async/await (used throughout shave/registry/federation), classes (used by sqlite-registry wrapper, ts-morph project handles), conditional/mapped/deep-generic types (used in contracts/types.ts), `unknown` and narrowing patterns. Each extension requires: validator rule (or relaxation), compile-target lowering verification, property-test pattern, `@decision` if non-trivial trade-offs. Scope contingent on what WI-V2-01 reports — until whole-project validator runs, the real construct gap is unknown. | WI-V2-01 | approve | deferred (v2 gate) |
| WI-V2-04 | Foreign-block boundary primitives (Phase C) | New triplet variant `kind: "foreign"` in `@yakcc/contracts`: blocks whose impl is `import { X } from 'foreign-pkg'`, treated as opaque leaves by the slicer. Foreign blocks have a spec (synthesizable from `.d.ts` or hand-authored) but no shaved impl and no further decomposition. Provenance manifest extends to track foreign-dep tree per non-foreign block. Deliver: schema change, slicer recognition, manifest emission, `yakcc shave --foreign-policy` CLI flag, foreign-block test fixtures (Node built-ins + sqlite-vec + ts-morph as canonical foreign deps). Pre-assigned decision: `DEC-V2-FOREIGN-BLOCK-SCHEMA-001`. | WI-V2-01 | approve | deferred (v2 gate) |
| WI-V2-05 | Source refactor for shavability (Phase D) | Driven by what `yakcc shave` reports against yakcc's own source. Likely work: decompose oversized functions that exceed atom-test thresholds (WI-012 criteria); break circular module deps if any are found; lift singleton-init side-effects into explicit construction; ensure tests still pass through every refactor. Existing test corpus is the safety harness — no behavior changes allowed, only structural refactoring. | WI-V2-02, WI-V2-03 | approve | deferred (v2 gate) |
| WI-V2-06 | Property-test coverage for yakcc atoms (Phase E) | Every yakcc-source atom must carry a non-placeholder `property_tests` artifact (per WI-016 contracts). Three sources, in priority: (a) existing tests (adapt yakcc's own test corpus into per-atom property tests where structurally possible); (b) JSDoc `@example` synthesis; (c) AI-derived against IntentCard + signature for atoms with no obvious property (the WI-016 path). Includes the dispatch-time decision: do we relax L0 property-test requirement to "explicit-examples-documented" for atoms whose property is hard to express (e.g. `formatErrorPath(node)`), or synthesize via LLM and accept the cost? Captured at WI dispatch as `DEC-V2-PROPTEST-FALLBACK-001`. | WI-V2-04, WI-V2-05 | approve | deferred (v2 gate) |
| WI-V2-07 | First shave pass over yakcc source (Phase F) | Run `yakcc shave packages/<pkg>/src` for each package in dependency order: contracts → ir → registry → compile/shave → federation → cli → hooks-claude-code → variance. Iterate failures: `did-not-reach-atom` errors, license errors, schema errors. Each failure is either a Phase B/D gap or a real bug. Output: a populated registry containing every yakcc atom + foreign-dep references, plus a list of real bugs surfaced as backlog items. | WI-V2-06 | approve | deferred (v2 gate) |
| WI-V2-08 | Compile self-equivalence (Phase G) | For each yakcc entry point (every CLI command, every package's public exports), run `yakcc compile <entry>` against the shaved registry from WI-V2-07. The recomposed yakcc must produce the same outputs as the original yakcc on every test in the existing test suite. **Not byte-identical source** (canonicalizer rewrites the AST) — **functionally equivalent behavior**. Acceptance: `pnpm test` passes against the recomposed yakcc compiled via `yakcc compile`. | WI-V2-07 | approve | deferred (v2 gate) |
| WI-V2-09 | Two-pass bootstrap equivalence (Phase H) | The crown jewel. Take the recomposed yakcc from WI-V2-08, use IT to re-shave the original yakcc source. The resulting block tree must be byte-identical at the `BlockMerkleRoot` level to the WI-V2-07 first-pass blocks. Fixed-point self-hosting: yakcc-N produces yakcc-N+1 produces yakcc-N+1 (no further drift). Any divergence is a non-determinism bug somewhere in the canonicalizer or hashing path — the most valuable test the project can have. Pre-assigned decision: `DEC-V2-BOOTSTRAP-EQUIV-001`. | WI-V2-08 | approve | deferred (v2 gate) |
| WI-V2-10 | v2 demo + CI (Phase I) | Document the self-hosting flow at `docs/V2_SELF_HOSTING_DEMO.md`: every command an external person runs, expected outputs, what to do when things diverge. Wire CI to run the WI-V2-09 two-pass equivalence check on every commit so a self-hosting regression never lands silently. This becomes the project's strongest external demo: "the compiler shaves itself, recomposes itself, and the result is byte-identical." | WI-V2-09 | approve | deferred (v2 gate) |

v2 dependency waves: **W1** = `{WI-V2-01, WI-V2-02}` (parallel; whole-project validator + fix the 4 real violations). **W2** = `{WI-V2-03, WI-V2-04}` (IR extensions + foreign-block primitives, both gated on WI-V2-01). **W3** = `{WI-V2-05, WI-V2-06}` (source refactor + property-test coverage). **W4** = `{WI-V2-07}` (first shave). **W5** = `{WI-V2-08}` (compile self-equivalence). **W6** = `{WI-V2-09}` (two-pass bootstrap). **W7** = `{WI-V2-10}` (demo + CI). Critical path: WI-V2-01 → WI-V2-03 → WI-V2-05 → WI-V2-07 → WI-V2-08 → WI-V2-09 → WI-V2-10. **Total revised estimate: 3-6 months past v1 wave-2 close** (originally 6-12 months; revised down per IR conformance audit 2026-05-01 — yakcc's source is more disciplined than earlier estimates assumed).

---

## Open questions

- **cognitive-stack monorepo conventions.** `initialize.txt` references
  cognitive-stack as the template for monorepo conventions, but the
  conventions document itself was not provided. The scaffold defaults to
  modern pnpm + Turborepo idioms (workspace protocol, `turbo.json` with task
  pipelines, package-local `tsconfig.json` extending a root base, ESLint flat
  config). When cognitive-stack conventions are shared, WI-001 will be
  re-aligned. Until then, treat current defaults as provisional.

---

## Plan history milestones

Append-only log of substrate-level milestones. Each entry names what
shipped, the SHA on `main`, and what it unblocks downstream. New entries
are added at the top; older entries are not edited.

- **2026-05-01 — WI-020 v2 landed; v1 wave-1 last work item unblocked.**
  `@yakcc/federation` package shipped via `wi-020-federation-mirror-v2`
  on a fresh `feature/wi-020-federation-mirror-v2` worktree. Source
  commit `3269a03` (federation package: typed `WireBlockTriplet` with
  inline `artifactBytes` per DEC-V1-FEDERATION-WIRE-ARTIFACTS-002,
  `wire.ts` consuming `@yakcc/contracts` `blockMerkleRoot()` directly
  with no parallel helper, `pullBlock` / `pullSpec` / `mirrorRegistry` /
  `createHttpTransport` / `serveRegistry` public surface, CLI verbs
  `mirror` / `pull-block` / `pull-spec`); merge into `main` at `9a7dcc2`
  after origin reconciliation through `172a93f` (WI-025 vector-search
  retrieval API + `yakcc query` CLI) and `b93cb3b` (FEDERATION.md F4
  adversarial-dynamics + VERIFICATION.md docs refresh). Federation
  suite: 109 tests; CLI suite: 48 tests; full `pnpm -r build` clean.
  Two non-blocking reviewer findings deferred to backlog: B-008
  (`Registry.enumerateSpecs()` primitive — `serveRegistry`'s optional
  `enumerateSpecs` callback is the documented workaround per
  DEC-SERVE-SPECS-ENUMERATION-020) and B-009 (`federation pull
  --registry` persist-on-pull — the diagnostic verbs are read-only in
  this WI). v1 wave-1 final work item is **WI-021 (v1 federation demo +
  acceptance)**: two registries (or two on one machine sandboxed),
  `yakcc shave` + atom persistence on registryA, `yakcc federation
  mirror <serveUrl>` from registryB, byte-identical `yakcc compile`
  output on both peers, all five DEC-V1-FEDERATION-PROTOCOL-001 +
  DEC-NO-OWNERSHIP-011 invariants demonstrated end-to-end. Evaluation
  Contract: `tmp/eval-wi-021.json`; Scope Manifest:
  `tmp/scope-wi-021.json`.
- **2026-04 — v0.7 closed; v1 wave-1 planning landed.** The v0.7 demo
  against `lukeed/mri` closed at `4ded2c2` (WI-015 offline-tolerant
  acceptance harness) plus `e7b2c64` (vitest timeout bump). Per-WI v0.7
  closure SHAs: WI-014-03 atom-to-triplet persistence at `3afb72f`,
  WI-014-04 registry schema + manifest parent-block foundation at
  `47df53a`, WI-014-05 `assembleCandidate` (universalize → compile) at
  `2eaa9c1`, WI-015 demo at `4ded2c2`. Three v0.7 follow-up items did not
  land inside v0.7 and are explicitly lifted into v1 wave-1 rather than
  treated as v0.7 stragglers (DEC-V07-CLOSURE-001): WI-013-03 →
  WI-016 (property-test corpus), B-003 → WI-017 (parent-block lineage
  population), B-002 → WI-018 (`seedIntentCache` test-helper export).
  v1 wave-1 ships **L0 substantiation + F1 read-only-mirror federation
  only** (DEC-V1-WAVE-1-SCOPE-001): WI-016, WI-017, WI-018, WI-019
  (federation protocol design, plan-only), WI-020 (`@yakcc/federation`
  F1 read-only mirror), WI-021 (v1 demo). WASM, additional hooks, F2+
  attestation publishing, and large-scale differential execution against
  upstream sources are deferred to a follow-on v1 wave or sibling
  initiative. First implementer dispatch is WI-018
  (DEC-V1-FIRST-DISPATCH-WI018-001) — smallest unblocker, ungates
  WI-016's cache-seeded property-test path and three skipped
  `assemble-candidate` tests in one move. Critical path runs WI-018 →
  WI-016 → WI-021. Source: planner dispatch under workflow `yakcc-v1`
  on branch `plan/v1-scope`; this milestone records the planning
  landing, not the wave-1 implementation closure.

- **2026-04 — v0.7 atom-test substrate + license gate + shave CLI live.**
  Six substantive landings closed in one session take the v0.7 pipeline
  from "decomposition recursion exists in isolation" to "end-to-end
  `license gate → intent extraction → decompose → slice` callable from
  the CLI." Per-WI landing SHAs: WI-012-05 DFG slicer at `af15563`
  (bundled with governance backfill of 13 DECs covering the prior
  WI-010..WI-012-04 work that had landed without DEC entries);
  WI-012-06 universalize() wiring at `ee2d815` (the slicer plus the
  recursion plus the canonicalizer composed into a single
  `universalize(candidate, registry)` API closing WI-012); WI-013-01
  license detector + license gate at `4b8bda2` (accepts only Unlicense
  / MIT / BSD-2 / BSD-3 / Apache-2.0 / ISC / 0BSD / public-domain
  dedications, refuses every other license string with a typed error);
  WI-013-02 license gate wired into universalize at `5f41943` (the
  gate runs first, fail-fast, before any LLM call); WI-014-01
  `shave(sourcePath, registry)` file-ingestion adapter over
  `universalize()` at `1a9fcf7`; WI-014-02 `yakcc shave` CLI
  subcommand at `3bfa7ed` (the v0.7 demo anchor's surface is now
  exposed). What this unblocks: the remaining v0.7 closure work is
  decomposed into WI-014-03 (atom-to-triplet persistence),
  WI-014-04 (provenance manifest parent-block extension),
  WI-014-05 (universalize-into-compile-resolver wiring), WI-013-03
  (property-test corpus extraction, deferred), and WI-015 (the `mri`
  demo); each is a bounded sub-slice with its own Evaluation Contract
  enumerated under `Initiative: v0.7 → v0.7 remaining-work sub-slice
  ledger`. WI-014-03 is the next implementer dispatch.

- **2026-04 — v0.7 atom-test substrate underway.** WI-010 (`@yakcc/shave`
  skeleton + intent extraction) closed at `ea47fe8` across three sub-slices
  (`e1376d7`, `c36eef1`, `ea47fe8`). WI-011 (variance scoring) closed at
  `92f905a`. WI-012 (atomic decomposition + DFG slicer, load-bearing) is in
  progress: WI-012-01 AST canonicalizer landed at `3c63539`, WI-012-02
  registry schema_version=3 migration + `findByCanonicalAstHash` at
  `1fe62f4`, WI-012-03 `isAtom` predicate at `47410d2`, WI-012-04
  decomposition recursion + self-recognition guard at `1d7a312`. The
  triplet substrate now has a canonical-AST structural-equivalence index,
  an executable atom test, and a working recursion bottom-out — the
  slicer (WI-012-05) is the remaining piece before WI-013 property-test
  corpus + license gate can land.

- **2026-04 — v0/v0.6 substrate closed at `7825a39`.** WI-T01..WI-T06 all
  landed. The substrate now satisfies cornerstone #3 in its triplet form:
  every block in the registry is `(spec.yak, impl.ts, proof/)` identified
  by `BlockMerkleRoot`, with `spec_hash` as the selector index. The v0
  demo (`yakcc compile examples/parse-int-list` → runnable module +
  provenance manifest naming every block by `BlockMerkleRoot`) passes
  end-to-end under the triplet shape, satisfying both v0 and v0.6
  acceptance per DEC-WI009-SUBSUMED-021. Inline-`CONTRACT`-literal block
  authoring is fully removed (Sacred Practice #12). This unblocks v0.7
  (sub-function decomposition / universalizer pipeline) and v0.5 (live
  hook + AI synthesis), both of which now produce blocks that are
  triplets from day zero. Per-WI landing SHAs: WI-T01 → `9137bef`,
  WI-T02 → `c957ce9`, WI-T03 → `89823f6`, WI-T04 → `4e0e5a1`,
  WI-T05 → `ced7d8e`, WI-T06 → `7825a39`.

- **2026-04 — `suggestions.txt` and `MANIFESTO.md` integrated via planning
  pass.** User authored `suggestions.txt` (`cb7cff9`) and `MANIFESTO.md`
  (`3c0ef68`) on a separate machine and pushed to `origin/main` during
  v0/v0.6 work. With v0/v0.6 closed, the convergence pass folded
  suggestions.txt's three asks into the planning surface:
  (#1) Semantic AST Canonicalization → constitutional in `VERIFICATION.md`
  (DEC-VERIFY-009), amplified at F4 in `FEDERATION.md` (DEC-FED-007);
  (#2) Native Decomposition Engine → continuous-shave reframe across v0.7
  WI-010..015 (DEC-CONTINUOUS-SHAVE-022); (#3) Behavioral Embeddings →
  deferred to L1+ in `VERIFICATION.md` (DEC-VERIFY-010), gated on ocap
  discipline. MANIFESTO is preserved as-authored. Orthogonal-axes
  architecture unchanged. See DEC-SUGGESTIONS-INTEGRATED-023.

---

## Decision Log

| DEC-ID | Decision | Rationale |
|---|---|---|
| DEC-V0-SCOPE-001 | v0 is TS-only; WASM moves to v1 | TS backend is sufficient to prove the architecture and is the documented fallback codegen path; adding WASM doubles backend surface before the substrate is trustworthy. |
| DEC-V0-HOOK-002 | `@yakcc/hooks-claude-code` ships as facade in v0; intercept logic in v0.5 | Locks the install/command surface early so v0.5 is a behavioral change, not an interface change. |
| DEC-V0-SYNTH-003 | No AI synthesis in v0; unmatched proposals kick manual `block author` flow | Synthesis is coupled to a moving model surface; we want the substrate trusted before we trust the synthesizer. |
| DEC-V0-CLI-004 | Ship a thin `yakcc` CLI in v0 | Demoable artifact requires a single command surface; CLI is also the integration point the hook facade calls into. |
| DEC-IDENTITY-005 | Contract identity is the hash of the canonicalized contract spec; verification evidence is separate, mutable metadata | Identity must be immutable so references are stable; trust evidence must be mutable so monotonic improvement is possible. Conflating them breaks both. |
| DEC-STRICT-006 | Strictness ordering is contributor-declared with structural sanity checks | Full ordering inference is undecidable; declared ordering plus sanity checks is tractable in v0 and stays compatible with later inference. |
| DEC-PROPTEST-007 | `fast-check` for property tests | TS-native, no FFI, well-maintained. |
| DEC-IR-008 | Strict TS subset enforced by ts-morph + ESLint, no parser fork | Extending an existing toolchain is correct for v0; a parser fork is a v1+ conversation. |
| DEC-STORAGE-009 | SQLite + sqlite-vec for registry | Single-file local store, vector index in the same DB, embeds cleanly into a CLI. Federation in v1 layers on top, not under. |
| DEC-EMBED-010 | Local embeddings via `transformers.js`, behind a provider interface | Local-first matches v0's "no network" stance; provider interface keeps hosted swap-in cheap later. |
| DEC-NO-OWNERSHIP-011 | No author identity, no signatures, no reserved columns for either | Cornerstone. The registry is a public-domain commons; identity machinery is design pressure toward ownership and we are not opting in. |
| DEC-LICENSE-012 | **The Unlicense** (public-domain dedication) across the repo and every registered block | The user requested "MIT or even more permissive license for all (there is NO ownership allowed)." The Unlicense is the strongest available interpretation: an explicit dedication of the work to the public domain rather than a permissive copyright license. 0BSD and CC0 were the alternative finalists; the user chose the Unlicense. This decision is locked. |
| DEC-DEMO-013 | v0 demoable artifact is `yakcc compile examples/parse-int-list` producing runnable TS + provenance manifest | One concrete artifact ties every v0 work item to a single end-to-end check. |
| DEC-WI005-REGISTRY-PRIMITIVES-014 | WI-005 scope expanded to include bounded additions to the `@yakcc/registry` interface — `getContract(id)` and `getImplementation(id)` — restricted to `packages/registry/src/index.ts` and `packages/registry/src/storage.ts` (search/select/schema and all registry tests remain forbidden) | The compile engine fundamentally needs direct content-address lookup of contracts and their best implementation source to traverse the composition graph; this gap was flagged in the WI-005 dispatch and closing it inside WI-005 is more coherent than a separate work item. The expansion is bounded to two specific methods on two specific files with explicit forbidden_paths constraining every other registry surface, and a `forbidden_shortcuts` rule prevents unbounded interface drift. |
| DEC-DECOMPOSE-STAGE-015 | Add a dedicated **v0.7** stage between v0.5 and v1 introducing a seventh package focused on absorbing existing TS/JS libraries into the registry with full provenance. Differential execution against upstream is deferred to v1. **Correction (post-landing, see DEC-DECOMPOSE-STAGE-015-CORRECTION below):** the original entry framed the package as `@yakcc/decompose` doing AI-driven library absorption from scratch with `vercel/ms` as the first demo target. Three user corrections supersede that framing: (1) `librAIrian` (Python, `/Users/cris/src/librAIrian/`) is the *prototype* whose concepts are ported into yakcc natively in TS — it is not a runtime dependency; (2) librAIrian's contracts are function-shaped, but yakcc must recurse to **atomic** blocks (the Sub-function Granularity Principle); (3) the demo target swaps from `vercel/ms` (monolithic regex, no recursive structure) to `lukeed/mri` (compositional argv parser that exercises the atom recursion). The package is `@yakcc/shave` and the CLI verb is `yakcc shave`. | The user identified that without a path to absorb existing libraries, the registry only contains hand-authored or fresh AI-synthesized blocks and the supply-chain story remains theoretical. Folding into v0.5 conflates synthesize-the-missing with absorb-the-existing; pushing into v1 ties it to federation timing it does not need. The correction strengthens the original direction: porting librAIrian's concepts (intent extraction, star-topology variance, contract design rules) preserves the substantive insight while keeping the runtime self-contained, and recursing to atoms is what makes "minimum-viable code" mechanically enforceable rather than aspirational. |
| DEC-DECOMPOSE-STAGE-015-CORRECTION | Supersede the original v0.7 framing with three corrections: (a) librAIrian-as-prototype-not-dependency, (b) Sub-function Granularity Principle (recurse to atoms), (c) demo target `lukeed/mri`. Package renamed `@yakcc/shave`. Atom test is a hard reviewer gate at WI-012; "did not reach atoms" is a v0.7 failure. | User corrections, verbatim: *"You should treat librAIrian as a prototype for what you will need to do, and you should use those concepts and steal as much as you can to not build this from scratch but yakcc should be self contained."* *"I don't think the way librAIrian works will get us all the way down the tree to the most basic blocks. The contracts that it proposes tend to be function level reusable components, not all the way down to the basic block level."* *"Eventually we will want to decompose this project itself (yakcc) into the paradigm that we are building... that's the goal here, eventually the code that you are emitting right now will become just basic blocks in the repo. Turtles (or Yaks) all the way down."* The third quote drives DEC-SELF-HOSTING-016 separately. The first two drive this correction. The seed corpus (`packages/seeds/src/blocks/`) — `digit`, `bracket`, `comma`, `optionalWhitespace`, etc. — is the existence proof that atoms are the right granularity: the hand-authored `parseIntList` decomposes into 7 of them, and `shave` must reproduce that structure when it ingests an equivalent function. |
| DEC-AXIS-017 | Yakcc has three orthogonal axes: substrate maturity (v-axis, this document, v0..v2), verification rigor (L-axis, `VERIFICATION.md`, L0..L3), and trust/scale participation (F-axis, `FEDERATION.md`, F0..F4). A user sits at any `(v, F, L)` coordinate. The F0 single-machine deployment is first-class at every substrate level — federation features are imported, not inherited. This DEC owns the meta-architectural commitment to the axis decomposition; the load-bearing decisions on each axis live in the documents that own that axis. Forward-references: `VERIFICATION.md` owns DEC-VERIFY-001..DEC-VERIFY-008 (verification levels, triplet identity, ocap discipline, totality, SMT/BMC, Lean L3, TCB hardening, verifier-as-block); `FEDERATION.md` owns DEC-FED-001..DEC-FED-006 (orthogonal axes, package decomposition, DA layer, slashing-as-deprecation, F4 economic primitives, trust-list governance). | The v0..v2 ladder describes capability growth; the L0..L3 ladder describes verification growth; the F0..F4 ladder describes participation growth. Conflating them produces planning drift (e.g., "we need federation before we can do formal verification" — false; a single-machine F0 deployment can run L3 locally). The user's "optional sidecar" framing — *"This should all be an optional layer that can be super imposed for the public repository. The yakcc backend should be usable as a private set of recomposable blocks for anyone to use."* — formalizes here as: each axis is independent, and the F-axis is opt-in via package selection (`@yakcc/federation`, `@yakcc/incentives`) rather than a precondition for substrate maturity. |
| DEC-SELF-HOSTING-016 | Add a new **v2 — Self-Hosting** stage after v1. Exit criteria: `yakcc shave` runs across yakcc's own packages, `yakcc compile` reassembles each package from the registered atoms, and a "registry-assembled build" passes `pnpm test` byte-identically with the from-source build. Self-hosting is a property of the build pipeline; not a runtime hot-swap; not a federation prerequisite. | User framing, verbatim: *"It's like the idea of a compiler not being complete until it can compile itself from scratch... that's the goal here, eventually the code that you are emitting right now will become just basic blocks in the repo. Turtles (or Yaks) all the way down."* This is the standard compiler-bootstrap test applied to yakcc: if the substrate cannot express its own implementation, it has not proven what it claims. v2 isolates this property from v1 federation (orthogonal concerns, different complexity) and from runtime hot-swap (out of scope). Placed at v2 rather than folded into v0.7 because (a) it depends on shave being trustworthy at sub-function granularity first, and (b) v1's federation trust mechanisms inform how a registry-assembled build's atoms get verified at scale, even though v2 itself works on a single-machine registry. |
| DEC-TRIPLET-MIGRATION-018 | Insert a new **v0.6 — Triplet substrate** stage between v0 and v0.5/v0.7. The stage migrates every block from the v0 inline-`CONTRACT`-literal `.ts` shape to the v1 cryptographic-triplet shape `(spec.yak, impl.ts, proof/)` per `VERIFICATION.md` DEC-VERIFY-002 / DEC-VERIFY-003. The inline-`CONTRACT`-literal mechanism is **removed**, not preserved alongside the triplet form (Sacred Practice #12). v0.6 is L0-only; L1/L2/L3 enforcement is deferred to a later L-axis stage. | The verification ladder requires the triplet shape to be coherent (you cannot attest a block's behavior without an artifact bundle that includes the proof evidence under the same identity as the spec and the impl). v0.5 (live AI synthesis) and v0.7 (`yakcc shave`) both produce blocks; if either ships before the substrate is in triplet form, those blocks land in the v0 shape and have to be re-migrated later. Doing the substrate-shape change as its own discrete stage between v0 and v0.5/v0.7 honors single-source-of-truth and makes the dependency explicit. The cornerstone is preserved: cornerstone #3 still says "a contract's identity is the hash of its canonicalized spec" — that is now the `spec_hash` index; what changes is that *block* identity (no longer = contract identity) is the MerkleRoot of the triplet (DEC-TRIPLET-IDENTITY-020). |
| DEC-TRIPLET-L0-ONLY-019 | v0.6 ships **L0 only**. The `spec.yak` schema accepts the optional level-dependent fields (`theory`, `bounds`, `totality_witness`, `proof_kind`, `constant_time`) without enforcing them. The `proof/manifest.json` schema accepts `smt_cert` / `lean_proof` / `coq_proof` artifact kinds at the type level but the L0 manifest validator rejects any artifact kind other than `property_tests`. The v0 `@yakcc/ir` strict-subset banlist is preserved as-is; the expanded ocap banlist from `VERIFICATION.md` §"Static banishment list" (no `Math.random`, no `Date.now`, no module-level mutable bindings, etc.) is deferred. The L1 totality checker, the L2 SMT encoder, and the L3 Lean checker are all deferred. | Scope discipline: shipping the triplet shape is a substrate-foundation move that v0.5 and v0.7 are blocked on; layering L1+ checks on top of the same slice would balloon the work and entangle independent unknowns (totality-checker design, SMT theory selection, Lean toolchain pinning). The current substrate already satisfies L0: strict-TS subset + fast-check property tests. Repackaging that into the triplet form is the minimum viable change. L1+ becomes its own L-axis initiative, likely paired with v1 federation when attestation surfaces motivate the higher-level checkers. |
| DEC-TRIPLET-IDENTITY-020 | Block identity migrates from `ContractId = BLAKE3(canonicalize(spec))` to `BlockMerkleRoot = BLAKE3(spec_hash \|\| impl_hash \|\| proof_root)` per VERIFICATION.md DEC-VERIFY-002. The spec hash is retained as `SpecHash` and continues to derive from `canonicalize(spec.yak)`; it becomes the **index** used by `selectBlocks(specHash) → BlockMerkleRoot[]`, not the block's identity. The 20 hand-authored seed blocks have not been published anywhere external (only on `cneckar/yakcc`), so re-derivation under the new shape is acceptable — there are no external consumers whose references would break. DEC-IDENTITY-005 is read in this slice as: *spec identity remains the hash of the canonical spec; block identity is the MerkleRoot of the triplet, which strictly extends the v0 framing rather than contradicting it.* Concrete L0 encoding decided in this stage: `impl_hash = BLAKE3(impl.ts file bytes)` (no ts-morph normalization at L0; deferred to L1+ where the AST is normalized by the totality pass anyway); `proof_root = BLAKE3(canonicalize(manifest.json) \|\| concat(BLAKE3(artifact_bytes_in_manifest_order)))`; `block_merkle_root = BLAKE3(spec_hash \|\| impl_hash \|\| proof_root)`. Recorded as `@decision` in WI-T01's implementation. | Identity migration is the single highest-risk operation in v0.6 because every downstream system that referred to a block by `ContractId` now refers to it by `BlockMerkleRoot`, with `SpecHash` as the looser "find me an implementation of this contract" key. The 20-block seed corpus's not-yet-published-externally property is what makes a clean re-derivation acceptable rather than catastrophic; we do not have to honor any pinned `ContractId` references in external consumers. The L0-specific encoding choice (file bytes for `impl_hash`, no AST normalization) is bounded to L0: at L1+ the totality checker normalizes the AST to verify structural recursion, and ts-morph deterministic-print becomes the canonical impl encoding under that level. Picking a simpler L0 encoding now and a richer L1+ encoding later is consistent with the strict partial-order refinement in `VERIFICATION.md` §"What each level guarantees". |
| DEC-WI009-SUBSUMED-021 | WI-009 (v0 demo + acceptance) is **subsumed** by WI-T06 (v0.6 triplet-form demo + acceptance). The 7 v0 stage exit criteria are preserved verbatim as a strict subset of WI-T06's acceptance gate, which adds the triplet-shape requirements on top. WI-009's row in the v0 substrate initiative table is marked `superseded by WI-T06`. The v0 demo is **not** run under the inline-`CONTRACT`-literal shape and then re-run under the triplet shape — it is run once, under the triplet shape, after WI-T05 lands. | Running WI-009 under the inline-CONTRACT-literal shape and then immediately re-migrating the demo to the triplet shape duplicates work and creates a transient state where the demo passes under the deprecated shape. Sacred Practice #12 forbids parallel mechanisms; running the demo on the deprecated mechanism even once is mechanism-coexistence in time, which is its own form of dual-authority bug. WI-T06 closes both the v0 substrate and the v0.6 triplet substrate at the same gate. |
| DEC-CONTINUOUS-SHAVE-022 | `@yakcc/shave` is reframed from a one-shot ingestion tool into a **universalizer pipeline that runs at every proposal-time entry point**: `yakcc shave <path-or-url>` (one-shot library absorption, still the v0.7 demo anchor against `lukeed/mri`), `yakcc compile <target>` (the resolver runs the universalizer on every monolithic candidate before binding), and `yakcc propose <contract>` (every fresh proposal — human or AI — flows through the slicer + canonicalizer before reaching the registry). The pipeline composes with the constitutional canonicalizer in `@yakcc/contracts` (`VERIFICATION.md` DEC-VERIFY-009): `canonical_ast_hash` is the structural-equivalence index the data-flow slicer queries to identify existing primitives; the slicer replaces redundant code with pointers to existing `BlockMerkleRoot`s; only the **novel "glue"** is synthesized and stored. The reviewer atom-test gate at WI-012 is extended to also gate on "did not re-synthesize an existing primitive." | Source: `suggestions.txt` ask #2, verbatim — *"Yakcc should natively act as a code universalizer. ... If a user proposes a list-of-ints parser, the engine recursively slices the code, identifies that the logic for an integer-recognizer and a bracket-matcher already exist in the registry, and natively replaces the user's redundant code with pointers to the existing primitives. The network only synthesizes and stores the novel 'glue.'"* The original v0.7 framing already had decomposition recursion (DEC-DECOMPOSE-STAGE-015-CORRECTION); suggestions.txt's ask #2 sharpens it from "shave existing libraries one-shot" to "shave every proposal continuously." This DEC encodes the sharpened framing without re-architecting the v0.7 work-item shape; WI-010 / WI-012 / WI-014 descriptions are updated in place. |
| DEC-SUGGESTIONS-INTEGRATED-023 | The user-authored `suggestions.txt` (committed at `cb7cff9`) and `MANIFESTO.md` (committed at `3c0ef68`) are integrated into the planning surface as follows: ask #1 (Semantic AST Canonicalization) lands in `VERIFICATION.md` as a constitutional pre-ledger pass (DEC-VERIFY-009), with `FEDERATION.md` §"Canonicalization engine" amended to clarify the F4 role is amplification, not ownership (DEC-FED-007). Ask #2 (Native Decomposition Engine / Auto-Slicing) lands in `MASTER_PLAN.md` v0.7 work-items via the continuous-shave reframe (DEC-CONTINUOUS-SHAVE-022). Ask #3 (Behavioral Embeddings) lands in `VERIFICATION.md` as a deferred-to-L1+ design (DEC-VERIFY-010), explicitly gated on ocap discipline per DEC-TRIPLET-L0-ONLY-019. The MANIFESTO is the rallying voice for the existing architecture — same design, sharpened rhetoric — and is preserved as-authored at the repo root; architecture docs do not adopt manifesto-style rhetoric. The orthogonal-axes architecture (substrate × trust/scale × verification, F0..F4, L0..L3, v0..v2) is unchanged; the universalizer pipeline elements slot into existing axes (canonicalization → constitutional in core; behavioral embeddings → L1+; continuous shave → v0.7). | Source: user authorship of `suggestions.txt` and `MANIFESTO.md` on a separate machine pushed to origin during v0/v0.6 work; user's standing instruction *"we will converge on what's needed from suggestions and then move on"* given before v0/v0.6 closure; v0/v0.6 closure at `7825a39` makes this convergence pass timely. The integration is plan-only: no source code, no package configs, no examples are touched in this slice (per the workflow contract's `forbidden_paths`). |
| DEC-SHAVE-001 | `@yakcc/shave` decomposed into three sub-slices (skeleton+workspace, intent+cache+SDK, tests+coverage) rather than one mega-WI. | Each sub-slice is an independent bounded unit with its own Evaluation Contract; landing them sequentially kept reviewer rounds short and let WI-011 (variance) start in parallel once the package skeleton was on `main`. |
| DEC-SHAVE-002 | Anthropic SDK is lazy-imported via `await import("@anthropic-ai/sdk")` rather than top-level. | Keeps the `@yakcc/shave` module loadable in offline/no-network unit tests; only `extractIntent` actually requires the SDK, and integration tests are env-gated by `ANTHROPIC_API_KEY`. |
| DEC-SHAVE-003 | Intent-card cache key is `BLAKE3(sourceHash ‖ \x00 ‖ modelTag ‖ \x00 ‖ promptVersion ‖ \x00 ‖ schemaVersion)`. | Changing the model, the prompt, or the response schema must invalidate cache hits without needing a manual cache wipe. Source SHA alone is insufficient because the LLM behavior is itself a hidden input. Null-byte separator prevents prefix-collision pathology. |
| DEC-VAR-001 | `@yakcc/variance` is a pure-function module with property tests (no LLM, no IO). | Variance scoring is mechanical once the dimension weights are fixed; mixing LLM calls in would re-introduce the v0 air-gap regression on a pure scoring pass. |
| DEC-VAR-002 | Five-dimension weighting locked at `{security: 0.35, behavioral: 0.25, error_handling: 0.20, performance: 0.10, interface: 0.10}`. | Inherited verbatim from librAIrian's R-series (DEC-DECOMPOSE-STAGE-015). v0.7 ports the concepts, not the values. |
| DEC-VAR-003 | `CWE_474_FAMILY` is a fixed table of five entries (CWE-474 + four directly-related entries) consulted by the security dimension. | The family seed is what makes "security 0.35" mechanically apply; an open-ended CWE database lookup is a v1+ enrichment. |
| DEC-VAR-004 | Contract-design rules: `safety = intersection`, `behavioral = majority-vote`, `capability = union`. | Also inherited verbatim from librAIrian. The intersection rule for safety is the conservative direction — the registered contract claims only what every observed implementation actually upholds. |
| DEC-VAR-005 | 90-test suite covers each rule independently plus property tests for variance ordering invariants. | A registered contract that diverges from these rules silently mis-labels safety; property tests catch monotonicity regressions. |
| DEC-AST-CANON-001 | `canonicalAstHash(source, sourceRange?)` uses ts-morph canonical print with comments stripped and identifiers locally renamed to `__vN` in declaration order. | Matches DEC-VERIFY-009 (constitutional canonicalizer). Comments do not change behavior; identifier names do not change behavior; therefore neither participates in structural identity. Local rename (not global) preserves shadowing and inner/outer distinction. Hash is BLAKE3 over the canonical print. |
| DEC-REGISTRY-AST-HASH-002 | `schema_version` bumped 2→3 with a two-phase migration: phase A (`schema.ts`) issues the `ALTER TABLE blocks ADD COLUMN canonical_ast_hash`, the `CREATE INDEX idx_blocks_canonical_ast_hash`, and the backfill of existing rows; phase B (`storage.ts openRegistry`) bumps `schema_version` to 3 only after backfill completes successfully. ALTER TABLE is idempotent via try/catch on the SQLite duplicate-column error code. | A single-phase migration that bumps the version before backfill leaves the registry in a half-migrated state if the backfill crashes mid-flight; two-phase guarantees that schema_version=3 implies all rows have a canonical_ast_hash. |
| DEC-ATOM-TEST-003 | `isAtom(node, source, registry, options)` returns an `AtomTestResult` discriminated by a `reason` field. | `true`/`false` is too thin for the reviewer gate at WI-012; the reviewer needs to see *why* a candidate is or is not an atom (single CF boundary, body trivial, registry match collapse, etc.). The result type makes "did not reach atoms" debuggable and lets the recursion driver decide between bottom-out vs. recurse-deeper based on the reason. |
| DEC-RECURSION-005 | `decompose(source, registry, options): RecursionTree` throws `DidNotReachAtomError` and `RecursionDepthExceededError` rather than returning a partial tree. **Supplement (DEC-RECURSION-005-SUPPLEMENT):** the recursion driver invokes a supplemental `childMatchesRegistry()` check before declaring a child atomic, to catch the self-recognition guard misfire where `isAtom` declares a `SourceFile` containing a single statement atomic even though the registry would have matched the inner statement. Implemented in `recursion.ts` rather than modifying the frozen `atom-test.ts` to keep the atom test's contract narrow. | The v0.7 reviewer gate requires every leaf to be an atom; a partial tree is a silent acceptance of "did not reach atoms," which DEC-DECOMPOSE-STAGE-015-CORRECTION explicitly forbids. Throwing forces the caller (slicer, CLI, hook) to confront the failure rather than emit a mis-shaped block. The supplement closes the self-recognition guard misfire without widening the frozen `atom-test.ts` contract. |
| DEC-SLICER-NOVEL-GLUE-004 | The DFG slicer (WI-012-05) emits a `SlicePlan` whose entries are tagged-union `PointerEntry \| NovelGlueEntry`. Pointer entries record `merkleRoot` + `canonicalAstHash` + `matchedBy: "canonical_ast_hash"`; novel-glue entries record `source` + `canonicalAstHash` + optional `intentCard`. The plan also exposes `matchedPrimitives` (for provenance) and `sourceBytesByKind` (for the reviewer's "novel glue ≪ original source" check). | This is the suggestions.txt ask #2 mechanism made concrete — the network synthesizes only the novel glue, never re-ingests an existing primitive. Reviewer gate per DEC-CONTINUOUS-SHAVE-022: "re-synthesized an existing primitive" is a hard failure; the slicer's job is to make that impossible by construction. |
| DEC-UNIVERSALIZE-WIRING-001 | `universalize(candidate, registry)` runs its sub-engines in fixed order: **license gate → intent extraction → decompose → slice**. The license gate runs first; on a refusal no LLM call is made and no source bytes leave the process. Intent extraction runs second, producing the `IntentCard` that the recursion driver consumes. Decomposition recursion runs third, bottoming out at atoms or throwing `DidNotReachAtomError` per DEC-RECURSION-005. The DFG slicer runs fourth, returning a `SlicePlan` per DEC-SLICER-NOVEL-GLUE-004. **Why:** the order is "fail-fast cheapest first" — the license gate is a regex pass (microseconds), intent extraction is a single Haiku call (cheap), decomposition is a multi-call recursion (expensive), and slicing is a registry-bound pure pass (cheap-but-AST-heavy). Putting the license gate last would leak third-party source bytes to Anthropic before refusing them; putting decomposition before slicing is the only ordering where the slicer has atoms to query the registry against. **How to apply:** any future entry point added to `@yakcc/shave` (e.g. a streaming variant for very large files) must preserve this gate ordering; the gate-first invariant is part of the package's public contract, not an implementation detail. |
| DEC-LICENSE-GATE-001 | The accepted-license set is **locked** to the v0.7 stage spec: Unlicense, MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, ISC, 0BSD, and explicit public-domain dedications (CC0, "this code is in the public domain" prose with a typed signal). Detection is signal-based: SPDX identifiers in headers, `package.json` `license` field, `LICENSE` / `LICENSE.md` / `COPYING` file fingerprints, and a small set of well-known prose tells. The gate refuses everything else — including weak-copyleft (LGPL, MPL), strong-copyleft (GPL family, AGPL), and unlicensed-but-public source — with a typed error citing the detected license string. **Why:** the cornerstone is "no ownership" applied at registry ingest; permissive-only is the only license posture that is structurally compatible with redistributing arbitrary atoms into a public-domain commons. The gate is a **second-line defense**, not a first line — first line is the user not pointing `yakcc shave` at a GPL repo. The gate's job is to catch the case where a user mis-identifies a license. **How to apply:** when an unfamiliar license appears in a candidate ingest, the gate must default to refusal and surface the unrecognized string to the user; do not silently accept-or-reject on partial matches. Adding a new accepted license requires a new DEC entry; the table is intentionally not extensible at runtime. |
| DEC-LICENSE-WIRING-002 | The license gate is **structural**, not a flag: there is no `--ignore-license` / `--force` / `--unsafe-licenses` opt-out on `yakcc shave`, and `universalize()` does not accept a `skipLicenseGate: true` parameter. A user who wants to ingest non-permissive code must do so outside `yakcc shave` (e.g. by reauthoring a clean-room TS implementation and feeding that through `yakcc block author`). **Why:** the cornerstone permissive-only commitment is load-bearing for the federation story — once the registry is shared (F1+), a single GPL atom poisons the commons because consumers cannot tell which atoms are safe to redistribute. A bypass flag, even one defaulted off, is a vector for that contamination by accident or social pressure. Aligns with Sacred Practice #12: "no parallel mechanisms" — there cannot be a "permissive-only path" and a "permissive-or-not path" coexisting in the codebase. **How to apply:** any future PR that adds a license-bypass surface (CLI flag, env var, config knob, package option) must be rejected at reviewer; the only legitimate way to expand the accepted-license set is a new DEC entry that updates DEC-LICENSE-GATE-001's table. |
| DEC-SHAVE-PIPELINE-001 | `shave(sourcePath, registry, options): Promise<ShaveResult>` is implemented as a **thin file-ingestion adapter over `universalize()`**, not as a parallel pipeline. The adapter (a) reads the source file, (b) invokes `universalize(source, registry)`, (c) maps the resulting `SlicePlan` entries to a `ShaveResult` shape that surfaces both pointer entries (resolved primitives) and novel-glue entries (atoms to be persisted). Each `NovelGlueEntry` is given a **deterministic placeholder ID** of the form `"shave-atom-" + canonicalAstHash.slice(0, 8)` — content-addressable and stable across re-runs on the same source. **Why:** a parallel pipeline would duplicate the license gate / intent / decompose / slice machinery and immediately drift from `universalize()`'s invariants (Sacred Practice #12). Making `shave` an adapter means the v0.7 demo's correctness is the same as `universalize()`'s correctness; the only `shave`-specific code is the file-IO and the placeholder-ID scheme. The deterministic placeholder ID matters for WI-014-03 (persistence) and WI-014-05 (resolver wiring): both need to map placeholders back to `BlockMerkleRoot`s, and a non-deterministic placeholder would force a stateful side-channel. **How to apply:** any future ingestion entry point (URL fetch, multi-file directory ingest, streaming) is also implemented as an adapter over `universalize()`; do not duplicate the pipeline. The placeholder-ID scheme is part of the `@yakcc/shave` public contract — changes require a DEC. |
| DEC-SHAVE-CLI-001 | The `yakcc shave` CLI subcommand bridges `@yakcc/registry`'s `Registry` interface to `@yakcc/shave`'s `ShaveRegistryView` interface via a **local adapter inside the CLI command**, not by changing either upstream API. The adapter's only substantive translation is the `getBlock(merkleRoot)` return type: registry returns `BlockTripletRow \| null`, but `ShaveRegistryView` expects `BlockTripletRow \| undefined`; the adapter does the `null → undefined` bridge inline. **Why:** changing `@yakcc/registry`'s return type to match would ripple into `@yakcc/compile`, `@yakcc/seeds`, and the test corpus — a wide blast radius for a CLI-only ergonomic preference. Changing `@yakcc/shave`'s view interface to match would couple the shave package to the registry's nullability convention, which is itself an implementation choice not a load-bearing invariant. The CLI is the right place to do the translation because the CLI is where `Registry` and `ShaveRegistryView` first meet at runtime. **How to apply:** when a future CLI subcommand needs to bridge the same two interfaces, reuse this adapter (lift it into a shared CLI helper if it gains a second caller); do not push the bridge into the registry or shave packages. |
| DEC-V07-CLOSURE-001 | v0.7 closes at `4ded2c2` (WI-015 demo + offline-tolerant acceptance harness) plus `e7b2c64` (vitest timeout bump for the integration-test path). The v0.7 demo against `lukeed/mri` passes under the offline-tolerant harness path. **Three follow-up items did not land inside v0.7 and are explicitly lifted into v1 rather than treated as v0.7 stragglers:** WI-013-03 (property-test corpus extraction, was deferred per its own row in the v0.7 ledger) becomes WI-016; B-003 (parent-block lineage population in `atom-persist`, partial WI-015 acceptance criterion (e)) becomes WI-017; B-002 (public `seedIntentCache` test-helper export from `@yakcc/shave`, which left three `assemble-candidate.test.ts` tests skipped) becomes WI-018. **Why lift rather than backfill v0.7:** all three are prerequisites for external-facing federation work (substantive L0 verification, full provenance lineage, unblocked test coverage) and they sequence naturally with v1 wave-1, so re-opening v0.7 to backfill them would re-cut the closed substrate boundary for no operational gain. Sacred Practice #12 is preserved: there is no parallel "v0.7 with backfilled property tests" path coexisting with the closed v0.7 substrate; the property-test work simply happens at the next stage. The v0.7 Plan history milestone above is the durable record of v0.7's actual landed state at closure. |
| DEC-V1-WAVE-1-SCOPE-001 | v1 wave-1 ships **L0 substantiation + F1 read-only-mirror federation only**. Concrete in-scope: WI-016 (property-test corpus), WI-017 (parent-block lineage), WI-018 (`seedIntentCache` helper), WI-019 (federation protocol design), WI-020 (`@yakcc/federation` F1 read-only mirror), WI-021 (v1 demo). **Out of v1 wave-1 (deferred to a follow-on v1 wave):** the WASM backend in `@yakcc/compile`; `@yakcc/hooks-cursor` and `@yakcc/hooks-codex`; F2+ attestation publishing; large-scale differential execution against upstream library sources beyond the per-target corpus that already gates WI-021. **Why this cut:** the v1 thesis (federation, additional codegen targets, additional hooks, differential validation) is four independent risk surfaces. Shipping all four at once entangles them: a federation-protocol bug looks like a WASM-codegen bug; a Cursor-hook regression looks like an attestation-publishing regression. Wave-1 isolates federation against a substrate that already has substantive L0 (WI-016 + WI-017) so the cross-machine round-trip in WI-021 is the only new variable. The deferred surfaces become independent v1-wave-2 / v1-wave-3 initiatives, each with their own first-implementer slice and Evaluation Contract, planned at the start of that wave rather than pre-committed here. **How to apply:** any PR or DEC that adds WASM/hook/F2-publishing/large-scale-fuzz scope to v1 wave-1 must be rejected at reviewer; the only legitimate way to add scope to wave-1 is a new DEC that supersedes this one with an explicit re-justification. |
| DEC-V1-WAVE-2-SCOPE-001 | v1 wave-2 ships **WASM backend (WI-V1W2-WASM-01..04) + 3 IDE hooks (WI-V1W2-HOOKS-01..03)**. Concrete in-scope: the WASM emitter scaffold in `@yakcc/compile` (WI-V1W2-WASM-01), type-lowering for primitives + structural types (WI-V1W2-WASM-02), the host-contract surface and `WASM_HOST_CONTRACT.md` repo-root doc (WI-V1W2-WASM-03), and the parity-harness demo at `examples/v1-wave-2-wasm-demo/` (WI-V1W2-WASM-04); production-hardening of `@yakcc/hooks-claude-code` against the WI-025 vector-search surface (WI-V1W2-HOOKS-01); scaffolding of `@yakcc/hooks-cursor` (WI-V1W2-HOOKS-02) and `@yakcc/hooks-codex` (WI-V1W2-HOOKS-03) sharing a single `IdeHook` interface (Sacred Practice #12). **Out of v1 wave-2 (deferred to v1 wave-3 / future):** F2+ federation publishing surface (signed manifests, peer keypairs, attestation signatures, per-caller trust filtering — all already deferred in `DEC-V1-FEDERATION-PROTOCOL-001` and not lifted here); large-scale differential execution against upstream library sources beyond the per-target corpus that already gates the parity harness in WI-V1W2-WASM-04; persistent attestation publishing as a network-visible surface; deeper IDE-hook surfaces beyond the registry-hit / synthesis-required / passthrough triad (e.g. multi-block recomposition prompts, federation-aware suggestion ranking — these become v1-wave-3 candidates once the wave-2 hooks have soaked). **Why this cut:** the v1 wave-2 thesis is **two** independent risk surfaces, not three. WASM is one risk surface (codegen — emitter correctness, type-lowering correctness, host-runtime contract correctness); IDE hooks are an independent risk surface (extension wiring, intent-extraction quality, registry-call path, threshold tuning); F2+ publishing is a third independent surface that benefits from waiting until both wave-2 surfaces are proven. Shipping all three at once entangles them: a hook-extension regression looks like a WASM-codegen regression looks like an attestation bug, and the bisect cost across three new surfaces is multiplicative, not additive. Wave-2 isolates the WASM and IDE-hook surfaces against a federation substrate that has already proven the cross-machine byte-identity invariant (WI-021 at `d9cb449`); F2+ publishing becomes its own wave when the wave-2 surfaces have shipped and the publishing surface can be evaluated against a populated registry rather than a hypothetical one. The two wave-2 surfaces are themselves chosen to be disjoint (WASM in `@yakcc/compile`; hooks in `@yakcc/hooks-*`) so the W1 dispatches `{WI-V1W2-WASM-01, WI-V1W2-HOOKS-01}` may run concurrently in sister sessions without merge conflict. **How to apply:** any PR or DEC that adds F2+ publishing, large-scale differential-execution scope (beyond the wave-2 parity harness's per-target corpus), or a new IDE hook surface beyond the WI-V1W2-HOOKS-01..03 trio to v1 wave-2 must be rejected at reviewer; the only legitimate way to add scope is a new DEC that supersedes this one with an explicit re-justification. The wave's close criterion is the simultaneous landed-state of `{WI-V1W2-WASM-04, WI-V1W2-HOOKS-02, WI-V1W2-HOOKS-03}` — when those three terminal WIs are merged to main, v1 wave-2 closes and v1 wave-3 (or v2 acceleration) becomes the next planning target. |
| DEC-V1-FIRST-DISPATCH-WI018-001 | The v1 wave-1 first implementer dispatch is **WI-018** (`seedIntentCache` test-helper export), not WI-016 or WI-017. **Why:** all three of WI-016, WI-017, WI-018 are technically unblocked at the start of v1 wave-1, but WI-018 is the smallest (single helper export plus three test re-enables), is fully self-contained inside `@yakcc/shave`'s test-helper surface, and ungates downstream test coverage that WI-016 (corpus extraction) will lean on for stable cache-seeded property-test runs. Picking WI-019 (federation design) first would block on a longer plan-pass; picking WI-016 or WI-017 first would land code that the WI-018-style cache-seeding tests would then have to retroactively validate. WI-018 → WI-016 → (WI-017, WI-019 in parallel) → WI-020 → WI-021 is the critical-path-shortest sequencing. **How to apply:** if WI-018 is blocked at provision time (e.g. the cache-key surface of `@yakcc/shave` has changed in a way that makes the helper export ill-shaped), the fallback first dispatch is WI-019 (plan-only, also fully unblocked). WI-016 and WI-017 do not become first-dispatch candidates until WI-018 lands; both have transitive dependencies on the cache-seeded test path. |
| DEC-V1-FEDERATION-WIRE-ARTIFACTS-002 | The v1 wave-1 wire `blockMerkleRoot` recomputation MUST equal the `@yakcc/contracts` `blockMerkleRoot()` formula (DEC-TRIPLET-IDENTITY-020) byte-for-byte. The contracts formula folds artifact bytes into the proof root: `proof_root = BLAKE3(canonicalize(manifest.json) || BLAKE3(artifact_0_bytes) || BLAKE3(artifact_1_bytes) || ...)`. The WI-019 protocol design and the WI-020 first-cut wire implementation both used a JSON-only formula that omitted artifact bytes; the WI-020 reviewer pass identified this as a load-bearing divergence: shave-produced rows would systematically fail the wire integrity gate (criterion: shave's persisted merkle root is content-addressed over the artifacts; the wire's recomputation would produce a different value and reject the block). **Resolution: Option A1** — artifact bytes travel inline on the wire as a `Record<string, base64>` field on `WireBlockTriplet`; the receiver decodes them, reconstructs an `artifacts: Map<string, Uint8Array>`, and feeds the contracts `blockMerkleRoot({ spec, implSource, manifest, artifacts })` for integrity. Option B (strip artifacts from the contracts formula) was rejected because it retroactively invalidates every block landed since v0.6 (DEC-TRIPLET-IDENTITY-020 established artifact-byte-inclusion at v0.6 substrate landing) and violates the content-addressed invariant. Option C (two formulas — "registry identity" vs "wire identity") was rejected for violating Sacred Practice #12 (no parallel mechanisms / single source of truth). Option A2 (separate `/v1/artifacts/<path>` endpoint) was rejected for v1 wave-1 because the inline path is simpler, the size penalty is bounded by the manifest's `property_tests` corpus (KB-scale, not MB-scale), and a separate endpoint requires the same registry-side schema migration plus a new wire surface — strictly more work for no v1 wave-1 correctness benefit. **Why A1 needs WI-022 first:** the registry today does NOT store artifact bytes — `BlockTripletRow` has no `artifacts` field, the SQLite `blocks` table has no artifact column, and `shave/persist/triplet.ts` consumes artifact bytes for the merkle computation and then drops them. A wire that emits artifact bytes must source them from the registry, which means the registry must persist them, which is WI-022 (`BlockTripletRow.artifacts` + `block_artifacts` table + storeBlock/getBlock plumbing). WI-020 remediation cannot satisfy the contracts formula on the wire until WI-022 lands. **Migration note:** any block persisted before WI-022 lands had its merkle root computed against whatever artifact bytes the persister had at write time; on the WI-022 migration, those rows are backfilled with the empty placeholder bytes (the bootstrap path used `makeBootstrapArtifacts()` which is reproducible) for the bootstrap-path manifests, and with the corpus bytes re-extracted from the cache for the corpus-path manifests. If the cache is missing for a row, that row is migrated with empty bytes and its merkle root is recorded as "pre-WI-022 lossy" in a schema-level marker column; such rows are not federation-eligible (they fail the wire integrity gate by construction). The fresh canonical run starting from WI-022 produces rows that round-trip cleanly. **Forbidden shortcuts (WI-020 remediation Evaluation Contract):** (1) the wire MUST NOT compute `blockMerkleRoot` from `proofManifestJson` only; (2) the wire MUST call into `@yakcc/contracts` `blockMerkleRoot()` directly (no parallel reimplementation of the contracts formula inside `@yakcc/federation`); (3) the round-trip test MUST seed with real shave-produced rows (via the `buildTriplet` path), not test-fabricated rows that compute their merkle root via a wire-only helper. **No-ownership preservation:** `artifactBytes` is a `Record<string, base64>` keyed by manifest-declared paths; paths come from the manifest, which itself contains no ownership data, so this addition does not introduce any author/email/signer field. **DEC-NO-OWNERSHIP-011 holds.** **How to apply:** any future PR that adds a wire-only merkle helper, a "fast path" that bypasses the artifact-bytes integrity check, or a `Record<string, base64>` reshape that lets paths carry author metadata is rejected at reviewer. The only legitimate way to change the wire formula is a new DEC that supersedes this one. |
| DEC-V1-FEDERATION-PROTOCOL-001 | The v1 wave-1 federation protocol is locked at four load-bearing choices, formalized in `FEDERATION_PROTOCOL.md`. (1) **Transport: HTTP+JSON over HTTPS** with an abstract `Transport` interface in `@yakcc/federation` so future libp2p/IPFS transports slot in without rewriting the merge logic; HTTP+JSON is chosen for minimal new infrastructure (any static-file HTTPS host can serve a registry), clean URL-as-content-address mapping (`/v1/block/<merkleRoot>` is the block, full stop, with HTTP caching working correctly by construction), and developer ergonomics (every yakcc developer has a working HTTP client/server today). (2) **Identity: content-addressed.** Blocks are identified by `BlockMerkleRoot`, specs by `SpecHash`, peers by mirror URL only — **v1 has no peer keypair, no peer name registry, no peer reputation.** Peer-keyed identity is a v2 surface introduced under F2 attestation publishing. (3) **Trust: nominal.** v1 trusts whatever bytes the operator-named URL serves; every fetched triplet is integrity-checked against its own `BlockMerkleRoot` and `SpecHash` (so transit corruption and active MITM are caught even though the peer itself is taken at its word). Signed manifests, peer keypairs, F2 attestation signatures, and per-caller trust filtering at selection time are all v2 surfaces; v1 wave-1 stores everything that arrives and defers selection-time trust filtering to a follow-on. (4) **Sync direction: pull-only, read-only.** B pulls from A; B never pushes. Publishing is F2 and is explicitly deferred per `DEC-V1-WAVE-1-SCOPE-001`. **Why this cut and not a richer one:** v1 wave-1's job is to prove the cross-machine round-trip invariant (WI-021 acceptance criterion (c): byte-identical `yakcc compile` output on both peers after a mirror), and adding signatures, trust lists, or publishing before that invariant is proven would entangle independent risk surfaces. The four choices above are the minimum that make cross-machine federation correctness verifiable. **How to apply:** the wire shape, endpoint set, failure semantics, public API surface, and acceptance for WI-020 are all derivable from these four choices plus the existing `@yakcc/contracts` / `@yakcc/registry` shapes; `FEDERATION_PROTOCOL.md` is the load-bearing companion document and is the contract WI-020 builds against. Any change to transport, identity model, trust posture, or sync direction after WI-020 lands requires a new DEC entry that explicitly supersedes this one. The no-ownership invariant (`DEC-NO-OWNERSHIP-011`) is preserved on the wire by construction: the wire shape is a direct JSON projection of `BlockTripletRow`, which has no ownership-shaped columns by schema design, so there is no field that could leak author identity across federation. The license gate (`DEC-LICENSE-WIRING-002`) remains structurally upstream — license enforcement is local to the publishing peer's `yakcc shave` invocation; downstream mirrors never see refused sources because no triplet is ever produced for them, and there is no federation-level license filter (one cannot exist that respects content-addressed integrity). |
| DEC-WI021-EVAL-REVISION-001 | WI-021's Evaluation Contract was revised on 2026-05-01 after the reviewer flagged a structural blocker (`REVIEW_VERDICT: blocked_by_plan`): the original contract required WI-017 parent_block_root lineage to be exercised "non-trivially" (multi-atom decomposition with populated `parent_block_root` on every non-root atom), but `@yakcc/shave`'s offline-tolerant universalize path produces a SINGLE block under DEC-UNIVERSALIZE-WIRING-001 (`maybePersistNovelGlueAtom` returns `undefined` for multi-leaf plans without an attached intentCard, and the offline `seedIntentCache` pattern does not produce one). Multi-atom output therefore requires either (i) modifying `packages/shave` (forbidden in WI-021's example-only scope) or (ii) a live `ANTHROPIC_API_KEY` call (impractical for offline-tolerant CI). **Revision:** removed the multi-atom / non-trivial-WI-017 requirement; replaced with a "WI-017 lineage PRESERVATION" invariant that the byte-identical row-equality test already covers (every column including `parentBlockRoot` round-trips A→B); restated WI-021's load-bearing job as proving the NEW federation byte-identity invariant (cross-machine compile-output equality), since prior WIs' invariants were already substantiated when those WIs landed. **Why this cut over the alternatives:** Option B (insert a prerequisite WI to fix DEC-UNIVERSALIZE-WIRING-001 in `packages/shave`) defers v1 wave-1 closure by an unspecified amount and re-opens scope on a settled package; Option C (use a substrate that triggers multi-atom output via live LLM intent extraction) is impractical for CI-runnable demos. Option A (relax WI-021's WI-017 requirement, track multi-atom-exercise as backlog) accepts the reviewer's analysis, closes v1 wave-1 on the load-bearing federation byte-identity invariant, and tracks the deferred work as **B-010**. The v1 wave-1 closer demonstrates the NEW invariant; prior WIs' invariants are preserved by the round-trip's byte-equal assertion. **How to apply:** any future eval-contract revision that re-tightens WI-021's WI-017 requirement is gated on B-010 landing first. Reviewers must check that B-010 is closed before re-imposing multi-atom acceptance criteria on this or any successor demo. |
| DEC-SERVE-SPECS-ENUMERATION-020 | `serveRegistry(registry, options?)` accepts an optional `enumerateSpecs?: () => Iterable<SpecHash>` callback that the `/v1/specs` endpoint walks to enumerate distinct spec hashes for cursor-paginated catalog responses. **Why a callback rather than a Registry method:** `@yakcc/registry`'s public surface today exposes `selectBlocks(specHash)` (one-spec → many-roots) and `getBlock(merkleRoot)` (one-root → row), but no `enumerateSpecs(): Iterable<SpecHash>` primitive. WI-020 v2 needed a way for `serveRegistry` to walk the spec set so `mirrorRegistry` clients can index by spec on the receiver, and the implementer's choice was: (a) add a callback hook to `serveRegistry` that the caller wires from their SQLite layer (one-line `SELECT DISTINCT spec_hash FROM block_triplets ORDER BY spec_hash`); or (b) extend `@yakcc/registry`'s public surface with a `Registry.enumerateSpecs()` method. Choice (a) shipped in WI-020 v2 because it kept the federation slice narrowly scoped to `packages/federation/**` and `packages/cli/**` — modifying `@yakcc/registry`'s public surface was explicitly forbidden by WI-020 v2's Scope Manifest, and a wider scope would have re-cut a slice that had already been re-provisioned once. **The callback is a workaround, not a destination:** production callers must supply it from their own SQLite handle or `/v1/specs` returns `[]` and federation receivers cannot index by spec. The proper fix is a `Registry.enumerateSpecs(): Iterable<SpecHash>` method (one-line SQL on the `block_triplets` table); once that lands, `serveRegistry` removes the callback option and walks the registry directly. **How to apply:** WI-021 (v1 demo) is allowed to wire the callback inline against registryA's SQLite layer because that is the documented v0.7-style escape hatch; any new federation-side caller must either (i) supply the callback, or (ii) wait for the `Registry.enumerateSpecs()` primitive. Tracked as backlog item B-008. |
| DEC-V2-IR-PROJECT-MODE-001 | **Pre-assigned to WI-V2-01.** Whole-project IR validator mode: `validateStrictSubsetProject(tsconfigPath)` resolves imports via a real `tsconfig.json` before running IR rules. Decision choice at WI dispatch: whether to implement as (a) a new top-level API function that opens a full ts-morph Project with the tsconfig, or (b) a `mode: "project" \| "isolated"` option on the existing `validateStrictSubset`. Rationale for pre-assignment: the choice affects the public API surface of `@yakcc/ir` that v2 WIs W2-W7 build against; it must be made explicitly, not accidentally. |
| DEC-IR-CLI-ENTRY-EXEMPTION-001 | **Pre-assigned to WI-V2-02.** CLI-entry-point exemption from `no-top-level-side-effects`. Two options at WI dispatch: (1) `if (import.meta.url === \`file://\${process.argv[1]}\`) main()` guard — still technically triggers the rule on the `if` clause; (2) relax the rule to allow a single `main()` call when a `// @cli-entry` annotation is present at the module top. Recommended option 2 per IR conformance audit 2026-05-01 — CLI binaries are a legitimate construct that must execute on import, and the rule as written is too strict for them. Any future PR that re-triggers this violation without the annotation must be rejected at reviewer. |
| DEC-V2-PROPTEST-FALLBACK-001 | **Pre-assigned to WI-V2-06.** Property-test fallback policy for yakcc atoms that are hard to express as property tests (e.g. `formatErrorPath(node)`, deep AST traversal helpers). Decision at WI dispatch: (a) relax L0 requirement to "explicit-examples-documented" for structurally-hard atoms, or (b) synthesize via LLM (the WI-016 AI-derived path) and accept the LLM-dependency cost. Either choice must be explicit — silent placeholder `property_tests` artifacts are rejected per WI-016 exit criteria. |
| DEC-V2-FOREIGN-BLOCK-SCHEMA-001 | **Pre-assigned to WI-V2-04.** Foreign-block triplet variant schema: `kind: "foreign"` blocks are opaque leaves whose impl is a bare `import { X } from 'foreign-pkg'`. Decision at WI dispatch: whether the foreign-block variant is a new `BlockTripletRow` discriminant (schema change) or a first-class new table row type (schema addition). The `kind` field must not break existing row consumers that only handle `kind: "standard"`. |
| DEC-V2-BOOTSTRAP-EQUIV-001 | **Pre-assigned to WI-V2-09.** Two-pass bootstrap equivalence as v2 acceptance gate: compiled yakcc-N shaves original yakcc source; resulting `BlockMerkleRoot`s must be byte-identical to first-pass blocks produced by the from-source yakcc. Any divergence is a non-determinism bug, not a "close enough." Decision at WI dispatch: whether to gate the CI check on strict byte-equality of every `BlockMerkleRoot` in the shave registry, or on equality of the top-level `WholeProgramProvenanceManifest` root hash (which is derived from all `BlockMerkleRoot`s by construction and is a superset check). |

---

## Riskiest Assumptions

These are the calls most likely to be wrong. Push back on the ones you
disagree with before the orchestrator builds against them.

1. **`transformers.js` embedding model size is unspecified.** The provider
   interface is locked, but the *specific* model used as the local default in
   v0 is not pinned in the plan. Common sentence-embedding models distributed
   for `transformers.js` range from ~25MB (e.g. `all-MiniLM-L6-v2` quantized)
   to several hundred MB. The "new contributor reaches `yakcc compile
   examples/parse-int-list` in under 15 minutes on a clean machine" exit
   criterion silently bakes in the download time of whatever model we pick.
   If the chosen model exceeds ~50MB once `pnpm install` and sqlite-vec
   native-binding compilation are also accounted for, the 15-minute target
   regresses. The pin happens during WI-002; flagging now so it surfaces as a
   conscious choice rather than an emergent constraint.
2. **No author identity *at all*, not even a nullable column.** The strong
   reading of "no ownership" is structural: the schema cannot represent it.
   The weaker reading would reserve a nullable `author` column for an
   eventual trust layer. We chose the strong reading. If a future trust
   mechanism wants identity, it adds a sidecar table then; it does not
   pre-bake a column today.
3. **cognitive-stack conventions guess.** We are defaulting to mainstream
   pnpm+Turbo idioms because the cognitive-stack convention document was not
   provided. WI-001 will be re-aligned once the document is shared, but if
   the conventions are deeply nonstandard, redoing scaffolding has a real
   cost.
4. **`transformers.js` for local embeddings.** It works on Node and is
   actively maintained, but model load time on first use is real (hundreds
   of MB). If first-run latency matters more than offline-by-default, a
   lighter embedding provider belongs behind the same interface.
5. **SQLite + sqlite-vec rather than LanceDB or a Postgres+pgvector path.**
   sqlite-vec is younger and the ecosystem is thinner. It is the right call
   for a single-file, embeddable, no-server store, but if v1 federation
   leans on Postgres, the migration cost is non-trivial.
6. **Seed corpus size of ~20 contracts.** Big enough to demonstrate non-trivial
   composition (the JSON list-of-ints chain plus adjacent primitives), small
   enough to hand-author and review. If you want fewer (10) to ship faster
   or more (50) to stress selection logic earlier, this is the moment.
7. **Facade-only Claude Code hook in v0.** We are paying the cost of building
   the install/command surface twice: once stubbed, once live. The bet is
   that locking the surface early de-risks v0.5. If you'd rather ship the
   hook *only* in v0.5 and not at all in v0, we cut WI-008.
8. **Strictness is contributor-declared.** Inferred strictness is undecidable
   in general; declared strictness is gameable. We accept the gameability for
   v0 because there is no shared registry yet to game. v1's trust layer is
   where this assumption is re-examined.
9. **TS as the IR for v0.** Training-data density and structural typing make
   this the right call, but it ties IR validation to the TS toolchain's
   evolution. If TypeScript adds a feature that breaks our subset, we eat
   the cost.
10. **The "15 minutes to first compile on a clean machine" exit criterion.**
    Aggressive. It bakes in pnpm install time, sqlite-vec native binding
    builds, and `transformers.js` model download. If any one of those
    regresses, the criterion regresses with it. We ship the criterion
    anyway because vague exit criteria rot.
11. **Decomposing an existing library is genuinely harder than decomposing
    fresh code.** Subtle invariants in the original — security-critical
    timing, side-channel resistance, undocumented call patterns maintainers
    relied on, idiosyncratic error semantics callers built around — may not
    survive contract extraction. Property tests in v0.7 will catch obvious
    behavioral mismatches; large-scale differential execution in v1 will
    catch sophisticated drift. Until v1, callers depending on shaved blocks
    for security-critical code should treat them as candidate replacements
    pending manual audit, not drop-in substitutes. The first target
    (`mri`) was chosen specifically because its semantics are simple,
    its source is naturally compositional, and its published test corpus
    is small enough to use as a v0.7 differential-test gate.
12. **AI proof synthesis becomes good enough at scale.** The verification
    ladder in `VERIFICATION.md` describes L3 (Lean-paired refinement
    proofs) and an actor-critic fuzzing fallback that aspires to populate
    the L3 tier as proof-synthesis tooling improves. The F4 economic
    premium (`FEDERATION.md`) prices L3 attestations ~10x L2 to
    incentivize proof writing. **Both rely on AI proof synthesis being on
    a trajectory that makes L3 cost-of-production drop into the same
    order of magnitude as fuzz-driven verification within the v0.7 → v1
    → v2 horizon.** If the trajectory flattens — if proof synthesis
    remains 100x more expensive than fuzzing rather than 10x — the L3
    tier stays sparse and the verification spine's strongest pitch
    weakens. The substrate stays useful (L0/L1/L2 still work) but the
    "machine-checked supply-chain confidence" claim degrades to "BMC-
    bounded confidence." This is a research bet, not a settled outcome.

13. **Totality discipline (L1) is acceptable to authors.** L1 in
    `VERIFICATION.md` requires structural recursion or explicit fuel
    parameters — `while (true)` with internal `break` on a runtime
    condition is rejected by the syntactic checker. **This is a real
    ergonomic cost.** Authors of code that naturally expresses as
    unbounded iteration (event loops, generators with external
    termination, work queues that drain dynamically) have to refactor or
    stay at L0. The bet is that the cost is paid once per author and the
    discipline becomes habitual; the alternative bet is that the
    discipline is too painful and L1 stays sparsely populated, reducing
    the verification spine to "L0 plus a long tail of partially-attested
    L2/L3 niche blocks." The seed corpus is naturally L1 (every block is
    a single-pass primitive over bounded input), which is encouraging —
    but the seed corpus is the easy case.

14. **Verifier governance is solvable under the no-ownership cornerstone.**
    `FEDERATION.md` documents the default-trust-list governance question
    as a user-decision boundary deferred to F3/F4 deployment. **The
    substrate's coherence depends on the question being answerable in a
    way that does not violate the cornerstone.** Three candidate models
    (multi-sig of named maintainers, on-chain vote weighted by attestation
    history, federation-of-attesters with rotation) each have failure
    modes — capture, Sybil, factional drift — and none of them is
    obviously safe. The bet is that *one of these models* is good enough
    when augmented with per-caller trust lists (which mechanically
    foreclose on absolutist failure). The risk is that none of them is
    good enough at public-network scale and the F3+ deployment never
    achieves credible neutrality. F0/F1/F2 work without resolving this;
    the bet only matters at F3+.

15. **LLM dependency in v0.7 is a property regression from v0.** v0 is
    air-gappable: `transformers.js` runs locally, the registry is SQLite
    on disk, the IR validator is ts-morph in-process, no network is
    touched after `pnpm install`. v0.7 introduces a hard dependency on
    Anthropic's API (Haiku for intent extraction, Sonnet for
    decomposition proposals). For security-conscious callers who chose
    v0 *because* it was air-gappable, this is a real regression — the
    `shave` step now requires network egress and exposes source content
    (third-party permissive code, but still source content) to a remote
    model. **Mitigation, baked into the v0.7 plan:** intent cards are
    cached on disk keyed by source SHA, so a second `yakcc shave` on
    the same input is deterministic and offline (WI-010 + WI-015 exit
    criterion 8). A future stage — likely a v0.8 or a mode flag in
    v0.7's late iterations — will add a local-LLM provider behind the
    same interface (Llama-class models via Ollama, or transformers.js
    text-generation pipelines) so air-gappable shaving becomes a
    supported configuration. Intent-card caches survive provider
    swaps because they are keyed by source SHA, not by model.
    Compiling and running shaved blocks is local even today — only
    the *initial decomposition* requires the API, and only on
    cold-cache inputs.

---

PLAN_VERDICT placeholder — see trailer at end of orchestrator response.
