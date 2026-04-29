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

Six packages. `@yakcc/contracts` defines what a contract *is* and how it
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
emission and reroutes through the registry.

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

**Non-goals.** Federation. Cursor/Codex hooks. Trust metadata.

### v1 — Federation, additional targets, additional hooks

**Thesis.** Make the commons real: a federated registry, additional codegen
targets starting with WASM, hooks beyond Claude Code, and the first concrete
trust mechanisms.

**In scope.**

- Federated registry protocol with content-address-based replication and
  conflict-free monotonic merging.
- WASM backend in `@yakcc/compile`.
- `@yakcc/hooks-cursor` and `@yakcc/hooks-codex`.
- A trust-metadata layer that stays compatible with the cornerstone (the layer
  attaches to the immutable contract id; identity is still hash, not signer).

**Exit criteria.** TBD at end of v0.5; the v1 design pass is itself the next
planning artifact, not a v0 deliverable.

**Non-goals.** Native (LLVM/JVM) backends — those are v1+ at the earliest.

---

## Hard problems we are deferring

These are *known* unsolved problems. v0 is engineered to be compatible with
better answers later, not to pretend they don't exist.

| Problem | v0 stance | Future work |
|---|---|---|
| Contract equivalence is undecidable in general | Declared strictness ordering + structural sanity checks + shared property-test corpora. Near-duplicates are tolerated; selection picks deterministically. | Differential execution at scale (v0.5); formal-property declarations and proof-carrying entries (v1+). |
| Composition is not free (errors, resources, perf don't decompose cleanly) | IR makes composition explicit; v0 limits itself to pure, total, side-effect-free seed blocks where composition is well-behaved. | First-class effect/resource/perf composition rules in the IR (v0.5+). |
| Provenance and trust | None. Public-domain commons, no author identity, no signatures, no trust metadata. The cornerstone forbids it. | A trust-metadata layer attached to immutable contract ids (v1). Reproducible builds, signed contributions, and formal proofs are all candidates — none are committed to today. |
| Adversarial contributions (passes tests, contains backdoor) | Out of scope. v0 has no shared registry, so this is not yet a live attack surface. | Addressed alongside the v1 trust-metadata layer. |
| Embedding-similarity drift (semantically distinct contracts close in vector space) | Embedding only surfaces candidates; structural matching is the gate. Selection never reads cosine distance. | Better encoders, contract-aware embedding training (v0.5+). |
| Seed-corpus bias | We pick the ~20 seeds. Whatever we pick, future composition shape inherits our taste. | Once the hook is live (v0.5), real authoring loops add corpus mass we didn't bias. |

---

## Active Initiatives

### Initiative: v0 substrate

Status: in progress.

| ID | Title | Description | Deps | Gate | State |
|---|---|---|---|---|---|
| WI-001 | Repo skeleton + facades | pnpm + Turbo monorepo, six package skeletons with real typed interfaces and plausible stub responses, strict-TS toolchain config, ESLint + ts-morph wiring, license + AGENTS.md + DESIGN.md placement. | — | review | in flight (this commit lands governance only; orchestrator will land scaffolding next) |
| WI-002 | Contract schema + canonicalization | Lock the `ContractSpec` shape, canonicalization rules, content-address derivation, and the embedding-pipeline provider interface (with `transformers.js` as the local default). Property tests for canonicalization stability. | WI-001 | review | not started |
| WI-003 | Registry storage | SQLite + sqlite-vec schema. Implement `store / search / match / select / provenance`. Strictness-aware selection. Provenance manifest emitter. | WI-002 | review | not started |
| WI-004 | Strict TS subset + IR | ts-morph validator banning `any`, `eval`, untyped imports, runtime reflection, and the rest of the escape-hatch list. ESLint rules. Wire into Turbo so non-IR-conformant code fails the build. | WI-001 | review | not started |
| WI-005 | TS backend + whole-program assembly | `@yakcc/compile` TS backend. Walk sub-contracts, bind via registry, emit single artifact + provenance manifest. Byte-identical re-emit on unchanged registry. | WI-003, WI-004 | review | not started |
| WI-006 | Seed corpus | ~20 hand-authored, IR-conformant contracts demonstrating composition. Includes full chain for `examples/parse-int-list`. fast-check property tests for each. | WI-002, WI-004 | review | not started |
| WI-007 | CLI | `yakcc propose | search | compile | registry init | block author`. Thin; defers all real logic to packages. | WI-003, WI-005 | review | not started |
| WI-008 | Claude Code hook facade | Real slash-command surface, project config, install command. Proposal flow stubbed with a clear "v0.5" message. No interception logic yet. | WI-007 | review | not started |
| WI-009 | Demo + acceptance | `examples/parse-int-list` end-to-end. Verifies all v0 exit criteria. Documents the 15-minute new-contributor path. | WI-005, WI-006, WI-007, WI-008 | approve | not started |

Dependency waves: `{WI-001} → {WI-002, WI-004} → {WI-003, WI-006} → {WI-005, WI-007} → {WI-008} → {WI-009}`. Critical path runs through WI-001 → WI-002 → WI-003 → WI-005 → WI-009.

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

---

PLAN_VERDICT placeholder — see trailer at end of orchestrator response.
