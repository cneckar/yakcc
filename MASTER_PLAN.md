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

**Exit criteria.**

1. Running `yakcc shave` across every yakcc package leaves the
   registry in a state where every published function in every yakcc
   package has a content-address in the registry, with the recursion
   bottoming out at atoms (per the v0.7 atom test).
2. `yakcc compile` against each package id produces a runnable artifact.
3. **Differential test.** `pnpm test` passes both on the from-source
   build (today's pnpm + Turbo pipeline) and on the registry-assembled
   build, with byte-identical test output on every case. Any divergence
   is a v2 failure.
4. The yakcc CLI binary built from the registry-assembled artifacts
   behaves identically to the binary built from source on the v0
   demoable artifact (`yakcc compile examples/parse-int-list`) and on
   the v0.7 demoable artifact (`yakcc shave ./vendor/mri`). The
   substrate compiles itself.
5. The whole-repo provenance manifest names every atom in the build
   graph by content-address, with parent-block links back to the
   shave recursion tree.

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

Status: in progress.

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
| WI-010 | `@yakcc/shave` package skeleton + intent extraction + universalizer entry points | Stand up `packages/shave/` as a real typed-interface facade exposing the universalizer pipeline at three entry points: one-shot `shave(sourcePath, registry, options): Promise<ShaveResult>` (existing); a `universalize(candidateBlock, registry): Promise<UniversalizeResult>` API that the compile resolver and proposal flow call into; and a hookable extension surface for `@yakcc/hooks-claude-code` to invoke at intercept time once v0.5 is live. Live capability in this WI: intent extraction. Public API returns a stubbed decomposition tree; private `extractIntent(unitSource, context)` calls Anthropic Haiku (`claude-haiku-4-5-20251001`) directly via the SDK and returns a structured intent card. The intent card is the upstream input to `spec.yak` generation in WI-012. On-disk cache keyed by source SHA so re-runs are local and deterministic. No decomposition recursion yet. | WI-T06 | review | not started |
| WI-011 | Variance scoring + contract design rules | Port librAIrian's star-topology variance comparison and contract-design rules (safety = intersection, behavioral = majority-vote, capability = union) into TS. 7-dimension weights inherited verbatim: security 0.35, behavioral 0.25, error_handling 0.20, performance 0.10, interface 0.10. CWE-474 family mapping for the security dimension. Pure-function module with property tests; no LLM calls in this work item. Used by both the one-shot `shave` path and the continuous `universalize` path when comparing candidate-cluster variance against canonical contracts. | WI-010 | review | not started |
| WI-012 | Atomic decomposition recursion + data-flow-graph slicing (load-bearing) | The Sub-function Granularity Principle made executable, **and the data-flow-graph slicer that suggestions.txt ask #2 specifies**. Two coupled sub-engines: (a) **Decomposition recursion.** Decomposes each candidate block until it bottoms out at atoms. AST-based atom test: at most one control-flow boundary, no further non-trivial sub-block in the registry. Each emitted atom is a triplet (generated `spec.yak` derived from the intent card and inferred input/output types, an `impl.ts` extracted from the source AST sub-range, a `proof/manifest.json` declaring the synthesized property-test artifact from WI-013). (b) **Data-flow-graph slicer.** When the recursion encounters a non-trivial sub-graph, it queries `selectBlocks(spec_hash)` and `findByCanonicalAstHash(canonical_ast_hash)` against the registry; matching primitives are replaced with pointers to their existing `BlockMerkleRoot`s. The network synthesizes only the **novel "glue."** This is the suggestions.txt ask #2 mechanism made concrete: every monolithic proposal is sliced into a graph of pointers + glue, never re-ingested as a new monolithic block. LLM-proposed decompositions that would create cycles or near-duplicate atoms are collapsed by the canonicalizer (DEC-VERIFY-009) returning the existing `BlockMerkleRoot` rather than ingesting a duplicate. **Reviewer must gate on the atom test for every leaf in the recursion tree and on the slicer's "novel glue" output.** "Did not reach atoms" is a hard failure. "Re-synthesized an existing primitive" is a hard failure. | WI-010, WI-011 | approve | not started |
| WI-013 | Property-test corpus per recursion level + license gate | Property-test corpus extraction (upstream tests where adaptable, documented usage where absent, AI-derived as last resort). License detector that accepts only Unlicense / MIT / BSD-2 / BSD-3 / Apache-2.0 / ISC / 0BSD / public-domain dedications and refuses everything else with a clear error citing the detected license string. Differential test runner across implementations satisfying the same contract. Activates for both the one-shot `shave` path (license gate gates the entire library ingest) and the continuous `universalize` path (license gate gates third-party-source candidate blocks; fresh AI-synthesized proposals from v0.5 are Unlicense by construction). | WI-012 | review | not started |
| WI-014 | Shave CLI surface + universalize wiring + provenance manifest | `yakcc shave <path-or-url>` wired into `@yakcc/cli` (the one-shot ingestion command, still valuable for absorbing existing libraries). **Plus** wire the `universalize(candidateBlock, registry)` entry point into `@yakcc/compile`'s resolver path so every block proposal that hits compile-time (whether from a hand-authored example, an AI-synthesized hook intercept, or a `yakcc propose` invocation) flows through the universalizer pipeline before binding. Provenance manifest entries are keyed by `BlockMerkleRoot` (per WI-T04) and extended with parent-block links forming the recursion tree (each non-root entry names its parent's `BlockMerkleRoot`); for blocks that survived `universalize` because they were the "novel glue" of a sliced proposal, the manifest also records the `BlockMerkleRoot`s of every primitive the glue references. `yakcc search` returns shaved atoms indistinguishable in interface from hand-authored ones — both are triplets in the `blocks` table; selection-signal augmentation per stage spec. | WI-012, WI-013 | review | not started |
| WI-015 | v0.7 demo + acceptance against `mri` + continuous-shave acceptance | Vendor `lukeed/mri` at a pinned commit under `vendor/mri/`. Run `yakcc shave` end-to-end (one-shot ingestion). Each ingested atom is a triplet under `packages/seeds/src/blocks/<shaved-name>/` (or wherever the shaved-corpus root is configured) with `spec.yak`, `impl.ts`, `proof/manifest.json`. **Plus** an additional acceptance check: a synthetic monolithic block proposal that re-implements `digit + bracket + comma + listOfInts` as a single 200-line function is fed through `yakcc compile` (or `yakcc propose`); the universalizer pipeline must slice it, identify the four existing seed atoms by `canonical_ast_hash` (DEC-VERIFY-009) plus structural matching, and reduce the registry impact to whatever non-trivial "glue" the proposal genuinely added (in the synthetic case: nothing, so the proposal is rejected as fully-redundant per DEC-VERIFY-009; in a near-duplicate case: only the genuinely-novel sub-graph is registered). Verify all v0.7 exit criteria, including (a) atom test on every leaf, (b) `yakcc compile` output matches `mri`'s published test corpus byte-identically, (c) intent-card cache hit on a repeated run requires zero Anthropic API calls (network-sandboxed), (d) GPL-prepared input refused with a clear error, (e) the provenance manifest names every atom by `BlockMerkleRoot` with parent-block links, (f) the synthetic-monolithic-proposal acceptance check above passes. | WI-010, WI-011, WI-012, WI-013, WI-014 | approve | not started |

v0.7 dependency waves: `{WI-010} → {WI-011} → {WI-012} → {WI-013} → {WI-014} → {WI-015}` with WI-011 and WI-013 each running independent of the wave above them once their inputs are ready. Critical path runs WI-T06 → WI-010 → WI-012 → WI-015 (the atom-test gate plus the data-flow-graph slicer at WI-012 is the load-bearing review). v0.7 is unblocked: WI-T06 closed the v0.6 triplet substrate at `7825a39`, every block `shave` and `universalize` ingest will be a triplet from day zero, and the canonicalizer scaffolding (DEC-VERIFY-009) provides the structural-equivalence index the slicer queries.

### Initiative: v2 self-hosting

Status: planned, gated on v0.7 closure (WI-015 done) and v1 federation deferred.

Concrete work items will be enumerated when v0.7 lands. The v2 stage section above defines the exit criteria; the work-item decomposition is itself a planning artifact at the start of v2 rather than a v0 deliverable.

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
