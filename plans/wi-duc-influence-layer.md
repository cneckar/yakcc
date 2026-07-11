# WI-DUC — DUC Influence & Provability Layer (Architecture)

**Workflow:** wi-duc-influence-layer
**Goal:** g-duc-give-shave-a-semantics-free-provability-floor
**Status:** Planner pass — architecture + slice plan; ready for ticketing. No code yet.
**Authority domain:** influence-analysis / def-use provability (this WI is the first writer; no prior authority exists — greenfield)
**Author:** planner
**Date:** 2026-07-11
**Source paper:** *Sound Influence under Opacity: A Def–Use Calculus for Computation whose Semantics Were Never Given* (the "DUC" paper), read in full.
**Parent docs (on `main`, read in full):** `docs/archive/developer/DESIGN.md`, `docs/archive/developer/VERIFICATION.md`, `packages/shave/**`, `packages/ir/**`, `packages/contracts/**`, `packages/registry/**`.
**Issue mapping:** Epic + 7 slices below are pre-issue WI ids (`WI-DUC-01..07`, precedent: `WI-T01`, `WI-V2-01`). Each becomes a GitHub issue at ticketing; the `wi-duc-*` plan prefix stays, the issue/commit uses `#<n>`.

---

## 0. TL;DR

The DUC paper describes exactly the object yakcc is missing: a **semantics-free def–use graph** over a computation, from which you can derive — as *theorems of the graph, quantified over every interpretation of the parts you cannot see* — a canonical order, a sound-and-least **may-influence** relation with inspectable witnesses, **non-interference as linear-time reachability**, and **monotone composition** (refining an opaque node only removes influence). It ships an admit-free, axiom-free Rocq mechanization of its core.

yakcc has **none** of this today. Confirmed by survey: there is no def-use, dataflow, taint, information-flow, or value-dependency analysis anywhere in `packages/`. The only graph that exists is the block-composition DAG (whole atoms as nodes, imports as edges). Inside an atom body, value flow is untracked; free identifiers are "just source bytes."

This layer adds a new leaf package `@yakcc/duc` and wires it into three places: **shave-time** (a conservation gate that turns "unresolved reference" from an untracked hazard into a declared `♦`-source), **contracts/registry** (a sidecar *influence facet* — a new orthogonal verification axis, cheap and mechanically checkable), and **compile-time** (interprocedural influence + non-interference over an assembled program). It directly hardens six weaknesses yakcc's own docs already confess.

**RECOMMENDED_OPTION:** Ship the conservation gate (S1–S2) first — it is the highest-leverage, lowest-cost win and closes the shave-from-opaque hand-wave. Influence/NI/composition (S3–S5) follow. Rocq mechanization (S6) is the heaviest and can run in parallel or land last.

---

## 1. Problem statement — the weaknesses DUC closes

Each item cites yakcc's own admission of the gap.

**W1 — "Shave from opaque upstream" is a hand-wave.** `DESIGN.md:248`: shaved blocks "should be treated as candidate replacements pending manual audit … not drop-in substitutes." There is no *formal object* for "what this atom depends on that it could not see." Inside an atom, free-identifier references "are simply part of the atom's source bytes and are not resolved or validated at shave time." This is precisely DUC's founding predicament — a computation whose semantics were never given — and DUC's answer is the `♦`-source + conservation law.

**W2 — Unresolved / foreign references are handled three incompatible ways, none downstream-visible.** Static imports → `ForeignLeafEntry` (tagged/rejected/allowed, `slicer.ts:169` `classifyForeign`); in-source free identifiers → untracked; cross-module edges that don't resolve → `UNRESOLVABLE` sentinel, best-effort degrade (`module-resolver.ts:45`). None produces a fact a consumer can read as "this output depends on these unknowns." DUC unifies all three into one discipline: every unresolved use is a declared `♦`-source, and `usupp(output)` (unknown-support) is a computed, first-class provenance fact.

**W3 — The L0→L2 chasm.** `VERIFICATION.md`: L0 (property tests) is "a floor, not a ceiling … does not establish absence of counterexamples." L1 (totality) is unimplemented. L2 (SMT) is unimplemented and expensive. There is nothing between "we fuzzed it N times" and "we ran Z3." DUC's may-influence + graph-NI is **linear-time, semantics-free, mechanically checkable, and Rocq-backed** — cheap like L0, but *sound over every interpretation* rather than sampled. It is a genuinely new rung.

**W4 — Composition soundness is explicitly unsolved.** `DESIGN.md` hard problems: "Composition is not free. Errors, resources, and performance don't decompose cleanly." `compile/resolve.ts` builds a block DAG but proves nothing about how influence flows through it. DUC Theorem 6.2 is a formal account: an opaque node is the coarsest sound summary of any subgraph that replaces it, and substitution can only *shrink* influence (monotone refinement). A shave decomposition (opaque node → subgraph of atoms) is influence-sound *by construction*.

**W5 — "A stricter contract wins" is declared, never verified.** `DESIGN.md:84`: "contributors declare ordering, and the substrate runs structural sanity checks." The `strictness_edges` table is contributor-asserted. DUC's monotonicity gives a mechanical *falsifier*: since refinement can only remove influence, a claimed-stricter block whose influence graph *adds* an edge is provably not a refinement — a cheap check that catches a class of bogus strictness claims for free.

**W6 — No information-flow analysis at all, despite security-minimality being the headline pitch.** `VERIFICATION.md` names adversarial backdoors (a path "triggered only by inputs the corpus does not generate") as the failure mode the cornerstone's no-identity rule forces us to answer mechanically. That backdoor shape *is* DUC's key-dependent branch. DUC gives (a) **graph-NI as linear-time reachability** over an atom or a whole assembled program, and (b) a **term-model witness** — "the secret occurs at this position in the witness at the observation" — an inspectable, semantics-free backdoor-surfacing object.

(Stretch — **W7:** `canonical_ast_hash` is sound-but-incomplete by its own `VERIFICATION.md` admission. A def-use-graph isomorphism is a strictly stronger structural-equivalence than the current De-Bruijn / commutative-normalized AST print. Noted as deferred, not scoped here.)

---

## 2. Non-goals

- **Not a new operational semantics.** DUC derives a *witnessed influence* semantics, not an evaluator. We do not execute or interpret opaque nodes. (DUC's own framing.)
- **Not a replacement for L0–L3.** The influence facet is *orthogonal* (see §5). Behavioral refinement (impl refines contract) stays the L-axis. Influence-soundness is a different property.
- **Not lifter verification.** Like DUC, we prove properties of the *emitted graph*, not that shave faithfully captured every operand of the source. "Faithfulness of the lift" (did shave emit every control decision as data?) is a separate obligation; the norms are documented, not proven, in this WI.
- **Not path-sensitivity in the base.** The base graph is path-insensitive (DUC §2). Guards / path conditions arrive later as conservative *refinement layers* (DUC §7) — deferred (§9).
- **Not timing/side-channel discovery.** DUC's side-channel edge discipline (emit elapsed time as a value) is representable but choosing *what* to observe is out of scope (§9).
- **Not loops-as-fixpoint.** Base graphs are finite and acyclic (DUC §2.8). yakcc already bottoms out loops as atoms (`recursion.ts:1425`, "loop-with-escaping-cf") or bounds them; we inherit that scope. Recursive-definition least-fixpoint semantics are explicitly out of scope.

---

## 3. The DUC model, mapped onto a yakcc atom

The whole layer rests on one lift: `impl.ts` body → **DUC graph**. The mapping is direct because a strict-TS-subset atom body is already close to finite single-assignment dataflow.

| DUC primitive | yakcc realization | Existing machinery to reuse |
|---|---|---|
| **Value** (immutable single-assignment name) | An SSA name for each param, `const`/`let` binding, and intermediate expression result in the atom body | `contracts/canonical-ast.ts` `collectLocalRenames` (:225), `isLocalBinding` (:149) already enumerate local bindings and scopes |
| **Opaque operation node** | Each value-producing construct: call, operator, property access, `sel` (ternary / if-gate). We record only its input/output ports — **never what it computes** | ts-morph AST walk, sibling to `ir/strict-subset.ts` `runAllRules` (:496) |
| **def–use edge** | value flows into a node's input; node output defines a value | new |
| **`♦`-source** (declared unknown, 0-ary node) | any free identifier with no in-body def: foreign import, referenced registry atom (by `BlockMerkleRoot`), capability token, ambient read | unifies `slicer.ts` `classifyForeign` (:169) + `module-resolver` `UNRESOLVABLE` (:45) + free-identifier tracking |
| **Obs (observation)** | the atom's `return` value(s) / exported outputs; for effectful blocks, capability writes | `spec.yak` `outputs` / `effects` |
| **Conservation (WF-C)** | every use resolves to a def or a declared `♦`-source, else the atom is rejected | *new gate* — see S2 |
| **Acyclicity (WF-A)** | SSA + no cyclic value dependency; a finite ranking exists | topological sort over the edge relation |
| **Control-as-data (Norm 2)** | a branch condition flows as an ordinary input into its `sel` node, so implicit flows are influence edges by construction | shave already treats a branch as an operation (`Example 2.6` analogue) — we make its condition an explicit port |

**Derived, not stored (DUC's subtractive discipline):** happens-before order, the descent measure, `may-influence`, `usupp`, and graph-NI are all *computed from the graph*, never persisted as separate structure. This matches yakcc's existing instinct (`canonical_ast_hash` derives, doesn't store).

**Shave is the lifter.** DUC's "lifter" (binary/FFI/netlist → graph) is yakcc's shave engine (source → atoms). DUC's three edge disciplines map cleanly: (1) *def/use* = normal shave; (2) *hypothesized-influence* = opaque foreign/probe edges for upstream calls shave cannot see into; (3) *side-channel* = a future timing facet. DUC's conservative builder `push_op` — **resolve the use, or declare a `♦`-source, never drop** — is exactly the discipline S2 imposes on shave's persist path.

---

## 4. Where it slots — state-authority map

| Domain | New authority | Wires into (file:line) |
|---|---|---|
| DUC graph model + lift + WF check | `@yakcc/duc` (new leaf pkg): `types.ts`, `lift.ts`, `wellformed.ts` | consumed by `ir`, `shave`, `compile`, `contracts` |
| Conservation gate (`♦`-source discipline) | `@yakcc/duc` `wellformed.ts` + shave wiring | `shave/persist/atom-persist.ts:234-266` (beside the mutation gate, before `storeBlock`); alt seam: `shave/universalize/slicer.ts:539` (`walkNodeGlueAware` per-subgraph validate) |
| `usupp` provenance | `@yakcc/duc` `influence.ts`; registry column | `registry/src/schema.ts` new `MIGRATION_15_DDL` (bump `SCHEMA_VERSION` 14→15); sidecar column on `blocks`, **not** in `BlockMerkleRoot` (precedent: source-provenance columns excluded from root) |
| may-influence + witness | `@yakcc/duc` `influence.ts` | new `ArtifactKind` in `contracts/proof-manifest.ts:28`; validator beside `validateProofManifestL0` (:133) / `L3` (:316) |
| graph-NI + labeling | `@yakcc/duc` `ni.ts` | atom-level at shave gate; program-level in `compile` |
| composition / refinement | `@yakcc/duc` `compose.ts` | `compile/src/resolve.ts:213` `resolveComposition` (build program influence from atom summaries) |
| Rocq mechanization | `packages/duc/coq/` (mirror the paper's `DUC_Core.v` / `DUC_Transfer.v`), nix-pinned | verifier-as-block (`DEC-VERIFY-008`) issuing `duc_influence` / `duc_ni` attestations |

**Adjacent seams noted (not claimed):** `registry` `findCandidatesByQuery` Stage 4 is a reserved no-op tagged for `DEC-VERIFY-010` (behavioral embeddings), *not* this facet — do not co-opt it. The `strictness_edges` table (`schema.ts:380`) is where S5's strictness-falsifier reads.

`@yakcc/duc` is a **leaf** (like `@yakcc/variance`): pure, offline, no registry write, no LLM. The DAG stays `incentives → federation → core`; `duc` sits in core with `contracts`.

---

## 5. Axis placement — the "I-axis"

yakcc has three orthogonal axes: **v** (substrate maturity), **F** (trust/scale), **L** (verification rigor, L0–L3 = *impl refines contract*). DUC's may-influence / graph-NI is **not** behavioral refinement — it is influence-soundness quantified over all interpretations, provable *without any node semantics*. It does not belong on the L-axis.

**Decision (proposed): a fourth, orthogonal facet — the I-axis (Influence).** It parallels how `constant_time` already lives *separate* from `level` (a side-channel property, not a behavioral one). Two rungs:

- **I0 — conservation-well-formed.** The atom lifts to a well-formed DUC graph; every use resolves or is a declared `♦`-source; `usupp` computed. **Cheap enough to be mandatory** at shave time (a gate, not opt-in) — unlike L2/L3.
- **I1 — mechanized influence.** may-influence soundness + graph-NI verdict carry a Rocq-checked attestation (S6), admit-free/axiom-free, issued by a verifier-as-block.

An atom is thus `(v, F, L, I)`. A shaved atom is `L0` behaviorally and `I0` structurally the moment it lands; `I1` is earned. This preserves the cornerstone (F0 first-class, opt-in rigor) and the existing L-axis untouched.

---

## 6. Slice plan

Small, independently landable, reviewer-friendly, each revertible in one commit. Dependency waves:
`{S1} → {S2, S3} → {S4, S5} → {S6} → {S7}`.

### WI-DUC-01 / S1 — `@yakcc/duc` graph model + lifter *(foundation)*
- **Delivers:** new leaf package. `DucGraph` type (values, opaque nodes, def/use edges, `♦`-sources, Obs), `liftAtom(source, sourceRange?) → DucGraph` (edge discipline 1), `isWellFormed(graph)` (conservation + acyclicity, with the WF-C counterexample and WF-A ranking). Pure, offline. Reuses `canonical-ast.ts` scope machinery.
- **Files created:** `packages/duc/src/{types,lift,wellformed,index}.ts` + `.props.test.ts`; `packages/duc/{package.json,README.md,tsconfig.json}`.
- **Evaluation Contract:** property tests for WF invariants (every well-formed lift round-trips; every conservation violation is caught; acyclicity ranking exists iff acyclic); the three worked examples from the paper reproduced as fixtures (unresolved read → `♦`-source; branch-is-an-operation with condition-as-data; a two-atom cyclic-use graph rejected). Forbidden shortcut: modeling node *semantics* (opacity is the point).

### WI-DUC-02 / S2 — Conservation gate at shave time *(closes W1, W2)*
- **Delivers:** wire `liftAtom` + `isWellFormed` into `atom-persist.ts` before `storeBlock`. Every novel-glue atom must lift well-formed: unresolved uses become declared `♦`-sources (unifying `classifyForeign`, free-identifier tracking, and `UNRESOLVABLE` module edges); a genuinely dangling use (no source, no `♦`) rejects the atom loud. Emit `usupp` set. Registry `MIGRATION_15` adds the sidecar column.
- **Files modified:** `shave/src/persist/atom-persist.ts`, `shave/src/universalize/slicer.ts` (feed foreign classification into `♦`-sources), `registry/src/schema.ts` (+`MIGRATION_15_DDL`), `registry/src/index.ts` (`BlockTripletRow` gains `ducUsupp`).
- **Evaluation Contract:** a shaved atom with an unresolved foreign call registers with a non-empty `usupp` naming the `♦`-source; a fabricated dangling reference is rejected (no silent drop — the DUC trichotomy: closed / open-with-`usupp` / ill-formed); existing seed corpus re-shaves unchanged (pure-local atoms → empty `usupp`). Authority invariant: `♦`-source discipline is the **single** unresolved-reference mechanism (Sacred Practice #12 — retires the three ad-hoc paths).

### WI-DUC-03 / S3 — may-influence + `usupp` + term-model witness *(new verification rung, W3)*
- **Delivers:** `mayInfluence(graph)` (closure of flows-to through opaque nodes), `usupp(obs)`, and `witness(obs)` (symbolic provenance term; occurrence = influence). New `ArtifactKind: "duc_influence"` + manifest validator. Analysis result attachable to the atom's `proof/`.
- **Evaluation Contract:** may-influence equals graph reachability on fixtures; witness term contains exactly the reaching `♦`-sources; least-relation check (no pair outside the realized set). Linear-time assertion benchmarked on seed corpus.

### WI-DUC-04 / S4 — graph-NI + security/info-flow facet *(closes W6)*
- **Delivers:** labeling API (high/low sources, low observations), `graphNI(graph, labeling) → { holds, witness? }` in linear time, with control-as-data implicit flows. New `ArtifactKind: "duc_ni"`. Atom-level gate hook + a CLI/compile surface to check an assembled program.
- **Evaluation Contract:** the paper's key-dependent-branch example, both verdicts — leak caught with witness at the condition position; isolated variant passes for all interpretations. A synthetic backdoor atom (secret reaches a low observation only via an implicit flow) is flagged.

### WI-DUC-05 / S5 — composition / monotone refinement *(closes W4, W5)*
- **Delivers:** `summary(subgraph)` (boundary type, coarsest summary = complete input→output relation), `refine(graph, node ↦ subgraph)`, monotonicity check (refinement only shrinks influence). Wire into `compile/resolve.ts` so a program's influence graph is assembled interprocedurally from atom summaries. Strictness-falsifier: a claimed-stricter block that *adds* an influence edge over the incumbent is rejected against `strictness_edges`.
- **Evaluation Contract:** substituting an atom's `♦`-summary with its real subgraph never grows influence on fixtures; a program assembled from N atoms has an influence graph equal to closure-over-summaries (no re-traversal of sub-bodies); a fabricated "stricter" block with an added edge is rejected.

### WI-DUC-06 / S6 — Rocq mechanization anchor (I1) *(heaviest; parallelizable)*
- **Delivers:** port DUC's admit-free / axiom-free builder-run core: `push_op` kernel, conservation & single-assignment invariants, WF-preservation across an arbitrary builder run, influence-soundness (builder source form + transfer to every well-formed graph). Nix-pinned; `make verify` rejects any `admit`/`Admitted`; `Print Assumptions` closed. Wire as a verifier-as-block issuing `duc_influence`/`duc_ni` attestations (I1). Ship a `Table 2`-style mechanized-vs-paper boundary doc.
- **Evaluation Contract:** `make verify` green, admit-free & axiom-free; the mechanized `influence_soundness_WF` transfer discharged; attestation round-trips through `proof-verifier` signing.

### WI-DUC-07 / S7 — closer
- **Delivers:** DEC-ID roll-up; `DESIGN.md` + `VERIFICATION.md` sections for the I-axis; deferred-work register (side-channel/timing = discipline 3, path-sensitive guard layer = DUC §7, def-use-graph isomorphism strengthening `canonical_ast_hash` = W7, behavioral-embedding cross-wire); acceptance sign-off.

---

## 7. Decision Log (proposed — recorded in source at implementation, per Code-is-Truth)

| DEC-ID | Subject | Rationale (1-line) |
|---|---|---|
| `DEC-DUC-GRAPH-MODEL-001` | atom lifts to a DUC graph (SSA values, opaque op nodes, def/use edges, `♦`-sources, Obs; WF = conservation + acyclicity; control-as-data) | the semantics-free substrate; everything downstream is a theorem of it |
| `DEC-DUC-CONSERVATION-GATE-001` | conservation is a pre-ledger structural gate at shave persist time; every use resolves or becomes a declared `♦`-source or the atom is rejected | no silent drop; the DUC trichotomy is the admission rule |
| `DEC-DUC-DIAMOND-SOURCE-UNIFY-001` | the `♦`-source is the single mechanism for unresolved references, retiring `classifyForeign` / free-id / `UNRESOLVABLE` as separate paths | Sacred Practice #12 (one canonical authority) |
| `DEC-DUC-USUPP-PROVENANCE-001` | `usupp(obs)` is first-class per-atom provenance, sidecar to `BlockMerkleRoot` (not in the root) | replaces the informal "candidate pending audit" status with a computed fact |
| `DEC-DUC-INFLUENCE-FACET-I-AXIS-001` | may-influence / graph-NI form an orthogonal semantics-free facet (I-axis: I0 gate, I1 mechanized), parallel to `constant_time`, not conflated with L-level | different property (influence, not behavioral refinement) |
| `DEC-DUC-NI-REACHABILITY-001` | graph-NI is decided as linear-time reachability with control-as-data; the witness term surfaces implicit flows | non-interference becomes an iff, not a one-way sufficient criterion |
| `DEC-DUC-COMPOSITION-MONOTONE-001` | an opaque node is the coarsest sound summary; refinement only shrinks influence; used for interprocedural program influence and as a strictness-claim falsifier | composition-as-opacity; mechanizes one direction of "stricter contract wins" |
| `DEC-DUC-ARTIFACT-KINDS-001` | new `ArtifactKind`s `duc_influence`, `duc_ni` + parallel manifest validators; sidecar registry column via `MIGRATION_15` | mirrors the L0/L3 parallel-validator pattern; not forked into the Merkle root |
| `DEC-DUC-MECHANIZATION-001` | Rocq admit-free/axiom-free builder-run core is the I1 trust anchor; verifier-as-block issues influence/NI attestations | the top rung earned mechanically, TCB-honest (`Table 2` boundary) |
| `DEC-DUC-SCOPE-001` | scope: finite acyclic per-atom graphs; loops as opaque node / bounded unroll; path-insensitive base; side-channel + path-sensitive refinement layers deferred | inherits shave's existing loop-as-atom bottoming-out; matches DUC §2 |
| `DEC-DUC-PKG-NAME-001` | engine package is `@yakcc/duc` (alt considered: `@yakcc/influence`) | terse-compiler-name aesthetic; tracks the source paper |

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Lift infidelity — shave doesn't emit every operand/control decision as data, so the graph is incomplete and NI reasons about the wrong object | Scope it out explicitly (§2, Norm 3): we prove properties of the *emitted* graph. Document the lift norms; make "use the front-end never emitted" visibly outside `usupp`. A verifying-lifter check is future work, not this WI. |
| `♦`-source blowup — real atoms reference many foreign/registry symbols, `usupp` is large and noisy | `usupp` is exactly the honest surface; large `usupp` = correctly-flagged high-unknown atom (that is the *point* for W1). Registry stores it; consumers filter on it. |
| Opacity over-approximates — path-insensitive base flags flows a path-sensitive analysis would kill (the "provably-always-false branch" case) | This is DUC's conscious conservatism; it is *sound*, and refinement layers (deferred) tighten it. Document that I0 is an upper bound, not a claim of necessity. |
| `decompose()` is frozen (`DEC-WI510-ENGINE-ORCHESTRATION-LAYER-001`) | We do **not** touch the engine. The gate lives in the persist path / orchestration layer / slicer's existing `validateStrictSubset` seam — all outside `decompose()`. |
| Rocq mechanization (S6) is large and could stall the whole effort | S6 is the last wave and parallelizable; I0 (S1–S2) delivers standalone value with zero Rocq. The facet is useful paper-proved at I0 before I1 lands (same staging DUC itself uses). |
| Scope creep into a full IFC system | Non-goals (§2) are load-bearing. Base is path-insensitive, finite, acyclic, synchronous. Everything richer is a named deferred refinement layer. |

---

## 9. Deferred / out of scope (named, not forgotten)

- **Path-sensitive guard layer** (DUC §7): guards, path conditions, declassification as conservative refinement layers over the same graph. Each provably shrinks influence.
- **Side-channel / timing facet** (DUC §8, discipline 3): emit elapsed time as a value flowing to an observation; graph-NI then decides timing leaks with zero new theory. Discovery of *what* to observe is a separate measurement problem.
- **W7 — def-use-graph isomorphism** as a stronger structural-equivalence than `canonical_ast_hash` (`DEC-VERIFY-009`). Sound-completeness upgrade; undecidable in general, so a bounded strengthening only.
- **Behavioral-embedding cross-wire** (`DEC-VERIFY-010`): the influence graph is a natural behavioral fingerprint; possible input to the L1+ behavioral provider. Deferred with that facet.
- **Loops-as-fixpoint** and recursive least-fixpoint semantics — deliberately out (DUC §2.8); would change WF-A.

---

## 10. Proposed tickets (for filing — do not create until approved)

| WI (pre-issue) | Title | Deps | Gate | Closes DEC |
|---|---|---|---|---|
| WI-DUC-01 | `@yakcc/duc` — DUC graph model + lifter + well-formedness | — | review | GRAPH-MODEL-001, SCOPE-001, PKG-NAME-001 |
| WI-DUC-02 | Conservation gate at shave persist time + `usupp` provenance (`MIGRATION_15`) | 01 | approve | CONSERVATION-GATE-001, DIAMOND-SOURCE-UNIFY-001, USUPP-PROVENANCE-001 |
| WI-DUC-03 | may-influence + term-model witness + `duc_influence` artifact | 01 | review | INFLUENCE-FACET-I-AXIS-001 (I0), ARTIFACT-KINDS-001 |
| WI-DUC-04 | graph-NI (reachability) + info-flow facet + `duc_ni` artifact | 03 | approve | NI-REACHABILITY-001 |
| WI-DUC-05 | composition / monotone refinement + interprocedural program influence + strictness falsifier | 03 | approve | COMPOSITION-MONOTONE-001 |
| WI-DUC-06 | Rocq mechanization (builder-run core) + verifier-as-block (I1) | 04, 05 | approve | MECHANIZATION-001, INFLUENCE-FACET-I-AXIS-001 (I1) |
| WI-DUC-07 | Closer — docs (I-axis in DESIGN/VERIFICATION), DEC roll-up, deferred register | 06 | review | — |

Epic umbrella issue: **WI-DUC — DUC Influence & Provability Layer** (this document).

*End of architecture plan — DUC influence layer for yakcc shave + verification.*
