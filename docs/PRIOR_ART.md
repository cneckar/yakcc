# PRIOR_ART.md — Defensive Publication of Substrate Mechanisms

> **Dedication.** Each mechanism described in this document is dedicated to the public domain or licensed under the substrate's permissive license (Apache 2.0 for substrate code, The Unlicense for atom content — see `LICENSE` and `LICENSE-ATOMS`). This document constitutes prior art for the purpose of preventing third-party intellectual-property claims over the substrate's open mechanisms. No rights are retained, asserted, or reserved by the substrate authors; the document does not establish a contributor license agreement, does not require attribution, and does not impose any condition on use of the mechanisms herein.

> **Purpose.** The substrate's no-ownership cornerstone (`MASTER_PLAN.md` Cornerstone #2) commits the registry and its mechanisms to a public-domain commons. That commitment is durable only if the mechanisms are protected against IP capture by third parties — for example, a patent troll filing on a substrate mechanism and threatening downstream users with infringement claims. Defensive publication makes such filings unenforceable by establishing prior art with a discoverable, dated record. This document is that record.

> **Status of the underlying mechanisms.** The substrate's existing artifacts (commits, `MASTER_PLAN.md`, `DESIGN.md`, `MANIFESTO.md`, `FEDERATION.md`, `VERIFICATION.md`, and the source tree in `packages/*/src/`) already constitute prior art by virtue of being on a public version-controlled repository with timestamped commits. This document consolidates the most novel mechanism combinations into a single, claim-style writeup optimized for prior-art searchability, so the protection is mechanically discoverable by patent examiners and prior-art researchers rather than requiring scattered-source archaeology.

---

## Index of mechanisms

1. **M1** — Triplet content-addressing for code blocks (BlockMerkleRoot)
2. **M2** — Strictness-monotonic content-addressed registry
3. **M3** — Universalize pipeline: slicer + canonical-AST-hash + glue framing
4. **M4** — Atom-test reviewer gate
5. **M5** — Constitutional canonicalizer for structural equivalence
6. **M6** — Multi-dimensional behavioral embedding schema with weighted query-time cosine + binary structural filter
7. **M7** — Hook architecture: registry-hit / synthesis-required / passthrough triad with contract skeleton on miss
8. **M8** — F0..F4 trust/scale federation axis with slashing-as-deprecation
9. **M9** — Verification ladder L0..L3 with triplet-based attestation
10. **M10** — Cross-axis orthogonality (v / F / L)

---

## M1 — Triplet content-addressing for code blocks (BlockMerkleRoot)

**Decision-log anchor:** `DEC-VERIFY-002`, `DEC-TRIPLET-IDENTITY-020` (see `MASTER_PLAN.md` Decision Log)
**Source-code anchor:** `packages/contracts/src/merkle.ts`, `packages/contracts/src/index.ts` (`blockMerkleRoot`, `specHash`, exported types)
**Cross-reference:** `DESIGN.md` (block-triplet architecture), `VERIFICATION.md` (triplet identity)
**First public disclosure:** `WI-T01` landing — the v0 substrate's initial block-triplet spec

**Claim-style description.** A method for content-addressing reusable code artifacts in which a single identifier (the "block Merkle root") is computed as the BLAKE3 hash of the concatenation of three subordinate hashes:

```
spec_hash         = BLAKE3(canonicalize(spec))
impl_hash         = BLAKE3(utf-8(impl_source))
proof_root        = BLAKE3(canonicalize(proof_manifest)
                          || BLAKE3(artifact[0].bytes)
                          || BLAKE3(artifact[1].bytes)
                          || ...)
block_merkle_root = BLAKE3(spec_hash || impl_hash || proof_root)
```

The `spec` is a canonicalized contract specification describing the code artifact's expected behavior, guarantees, error conditions, non-functional properties, and property tests. The `impl_source` is the source-code implementation satisfying the spec. The `proof_manifest` and its byte-stream artifacts constitute verification evidence (property-test outcomes, formal proofs, fuzzing reports, et cetera).

The identifier serves three roles simultaneously: (a) it is the persistent key under which the block is stored in the registry; (b) it is the identifier emitted by a compiler in a provenance manifest naming every constituent block of an assembled program; and (c) it is the address by which a federation peer fetches the block over a content-addressed protocol.

**Novelty argument.** Existing content-addressing systems (Git, IPFS, Nix store paths, Bazel actions) address one of: source code, file content, build artifacts, or process outputs. None of these address a code artifact's *combination* of (specification, implementation, verification evidence) under a single identifier such that a change to any of the three constituents produces a different identifier. The novelty lies in the **composition of identity across the three categories simultaneously**, enabling registry operations (lookup, dedup, retrieval) to be governed by the totality of an artifact's contract-implementation-evidence state rather than by any subset thereof.

---

## M2 — Strictness-monotonic content-addressed registry

**Decision-log anchor:** Cornerstones #1, #3, #4, #6 in `MASTER_PLAN.md`; cornerstone-bound throughout the substrate
**Source-code anchor:** `packages/registry/src/storage.ts`, `packages/registry/src/index.ts`
**Cross-reference:** `MASTER_PLAN.md` (Cornerstone section), `DESIGN.md` (registry architecture)
**First public disclosure:** Substrate v0 stage spec (initial `MASTER_PLAN.md` Cornerstone section landing)

**Claim-style description.** A content-addressed software registry exhibiting the following composed properties:

(a) **Identity by specification hash.** Each entry is keyed by the hash of its canonicalized specification (see M1 and M5). Two implementations satisfying the same specification share the same registry identity for the specification; their distinct implementations differ in `impl_hash` while sharing `spec_hash`.

(b) **No versioning.** The registry does not maintain semantic-version, calendar-version, build-number, or other linear-version metadata. There is no `latest` tag, no breaking-change event, no migration path between versions of "the same block." Two artifacts with different canonicalized specs are different blocks with different identities, period.

(c) **No ownership.** The registry maintains no `author_email`, `signature`, `submitter`, `maintainer`, or any other ownership-, attribution-, or identity-related metadata for any entry. No reserved nullable columns "for later" carrying such metadata. The registry is a public-domain commons; no owner is being preserved.

(d) **Monotonic addition.** Entries are added but never deleted, renamed, or modified. Schema migrations add new content-addressed metadata to existing immutable entries; they do not retract or alter existing entries.

(e) **Selection by declared strictness, not by cosine distance.** When multiple implementations of the same specification are present, selection among them at compile time is governed by **declared strictness ordering** (an explicit per-implementation property recording which guarantees, error conditions, or non-functional properties are enforced more strictly) plus structural matching of the request. Cosine distance to query embeddings (where embeddings are an index over the registry) is **never** the correctness criterion — it surfaces candidates only.

**Novelty argument.** Software registries are commonly governed by some combination of: linear versioning (npm, PyPI, Maven Central), owner authentication (Docker Hub, GitHub Packages), or trust-on-first-use (Cargo, Go modules). The combination of (a)–(e) above — particularly the *simultaneous* commitments to no-versioning AND no-ownership AND monotonic-addition AND strictness-driven-selection — is novel as a composed mechanism. Each individual property has prior art in restricted contexts (e.g., Nix store is content-addressed and immutable but versioned via channels; IPFS is content-addressed and ownership-free but has no spec/impl distinction; Hoogle is structurally indexed but does not commit to no-versioning); none combine all five properties in the manner of this registry.

---

## M3 — Universalize pipeline: slicer + canonical-AST-hash + glue framing

**Decision-log anchor:** `DEC-CONTINUOUS-SHAVE-022`, `DEC-V2-GLUE-AWARE-SHAVE-001`, `DEC-V2-GLUE-LEAF-CONTRACT-001` (`MASTER_PLAN.md`)
**Source-code anchor:** `packages/shave/src/universalize/slicer.ts`, `packages/shave/src/universalize/types.ts`, `packages/contracts/src/canonical-ast.ts`
**Cross-reference:** `DESIGN.md` (shave pipeline), `MASTER_PLAN.md` (initiative: shave-what-shaves + glue)
**First public disclosure:** `WI-010` landing (initial slicer) + the `WI-V2-GLUE-AWARE-SHAVE` consolidation (#78 / `DEC-V2-GLUE-AWARE-SHAVE-001`)

**Claim-style description.** A code-decomposition pipeline that recursively decomposes a candidate source artifact and emits, for each subgraph of the artifact's abstract syntax tree, one of three classified outcomes:

(a) **Local entry (`LocalEntry`).** The subgraph satisfies the substrate's strict-subset predicate (a per-language definition of what code is safely shaveable), and is replaced in the output with a pointer to a registry block identity. The block identity is determined by hashing a canonical-form rewrite of the subgraph (the "canonical AST hash"); if a registry entry already exists at that identity, the existing entry is reused without modification; otherwise a new entry is composed and persisted.

(b) **Foreign-leaf entry (`ForeignLeafEntry`).** The subgraph references an external dependency that is out of scope for shaving (e.g., a Node.js built-in, a third-party package not in the registry). The subgraph is preserved as an opaque leaf reference in the slice plan, and the foreign dependency is tracked in the provenance manifest of every block that transitively depends on it.

(c) **Glue-leaf entry (`GlueLeafEntry`).** The subgraph does not satisfy the strict-subset predicate AND is project-local (not foreign). The subgraph is preserved verbatim — neither shaved into the registry nor treated as a foreign dependency — but is tracked in the slice plan with content boundaries delineating its start and end. The compile pipeline emits glue entries verbatim with comment-boundary markers; downstream registries do not store glue entries as content-addressed atoms.

**Predicate, not gate.** The strict-subset predicate is applied **per subgraph** (the "shave-what-shaves" framing), not as a per-file gate. A file containing both shaveable and non-shaveable subgraphs produces a heterogeneous slice plan with local entries for the shaveable subgraphs and glue entries for the rest. This is distinct from a whole-file shaveability check, which would reject any file containing any non-shaveable construct.

**Novelty argument.** Code-decomposition systems for reuse generally fall into two camps: (i) whole-file modular reuse (npm packages, Python modules), and (ii) syntactic dedup at the token or AST level (clone detection, decompilation deduplication). The combination of (a) recursive subgraph-level decomposition, (b) content-addressing of the canonicalized subgraph for registry lookup, (c) ternary classification into local / foreign / glue, and (d) verbatim preservation of glue with explicit boundary markers — all governed by a per-language strict-subset predicate applied per-subgraph rather than per-file — is novel as a composed mechanism for source-level code reuse via a content-addressed commons.

---

## M4 — Atom-test reviewer gate

**Decision-log anchor:** `DEC-DECOMPOSE-STAGE-015-CORRECTION`, `WI-012` acceptance criteria (in `MASTER_PLAN.md` work-item table)
**Source-code anchor:** `packages/shave/src/universalize/` (decomposer + atom-test enforcement), reviewer-time mechanical checks (substrate-specific)
**Cross-reference:** `DESIGN.md` (atom-test rationale), `MASTER_PLAN.md` (WI-012 row)
**First public disclosure:** v0.7 stage spec landing

**Claim-style description.** A mechanical, reviewer-side acceptance gate that rejects shave output (the output of the M3 universalize pipeline) when the decomposition fails to reach atomic primitives. An "atomic primitive" is defined operationally as a code subgraph satisfying both:

(a) **At most one control-flow boundary.** The subgraph contains at most one decision point (conditional branch, loop entry, throw, return-via-early-exit). Subgraphs with more than one such boundary are considered non-atomic and rejected.

(b) **No further non-trivial sub-block already in the registry.** The subgraph does not transitively contain a smaller subgraph whose canonical AST hash already exists as a distinct entry in the registry. (If it did, the subgraph should have decomposed to a pointer to that existing entry.)

The combination of (i) recursive decomposition to atomicity, (ii) registry-aware atom-near-duplicate detection, and (iii) **hard-fail** reviewer semantics (no override flag, no operator opt-out) constitutes the gate. There is no escape hatch: a block that fails the atom-test gate does not enter the registry.

**Novelty argument.** Reviewer-side acceptance gates exist in software engineering as code-review checklists, linter rules, or merge-blocking CI checks. None known to the substrate authors combine all of: (a) recursive decomposition to a registry-aware atomicity definition, (b) atom-near-duplicate detection against a content-addressed registry, and (c) hard-fail semantics with no operator override. The composition is what's novel; the components individually have weak prior art (decomposition is well-known; deduplication is well-known; hard-fail gates are well-known) but the substrate's combination is the gate.

---

## M5 — Constitutional canonicalizer for structural equivalence

**Decision-log anchor:** `DEC-VERIFY-009`, `DEC-AST-CANON-001` (`MASTER_PLAN.md` Decision Log)
**Source-code anchor:** `packages/contracts/src/canonical-ast.ts`, `packages/contracts/src/canonicalize.ts`, `packages/contracts/src/spec-yak.ts`
**Cross-reference:** `VERIFICATION.md` (canonical AST), `DESIGN.md` (canonicalizer)
**First public disclosure:** `VERIFICATION.md` v1 landing

**Claim-style description.** A canonical-form AST rewrite function used as the structural-equivalence index for code deduplication at registry-write time. The canonicalizer rewrites an input AST into a normal form that is invariant under cosmetic rewrites — identifier renaming, parameter reordering (where order is not semantically significant), whitespace, comment placement, equivalent control-flow restructurings (e.g., `if (!x) return; ...` versus `if (x) { ... }`), and other syntactic variations that do not change semantics. The canonical form's BLAKE3 hash (the "canonical AST hash") is then used as part of the block's identity composition (see M1).

Critically, the canonicalizer is **applied at registry-write time** (when a block is composed and submitted), so cosmetic-rewrite duplicates collapse to existing block identities at submission — preventing the registry from accumulating semantically-equivalent near-duplicate entries that differ only in syntactic form.

**Novelty argument.** Canonical-form rewrites for code exist in compiler-internal contexts (SSA form, normalized lambda calculus, etc.) and in code-similarity research (clone detection, plagiarism detection). The novelty here lies in using a canonical form as the **registry-write-time deduplication index for a content-addressed code registry**, such that the registry's identity model is structurally-equivalence-aware by construction rather than by post-hoc dedup. Combined with M1's triplet identity, this means two implementations identical-up-to-cosmetic-rewrite share `impl_hash` (and therefore `block_merkle_root`) without separate dedup logic.

---

## M6 — Multi-dimensional behavioral embedding schema with weighted query-time cosine + binary structural filter

**Decision-log anchor:** `DEC-V3-DISCOVERY-D1-001`, `DEC-V3-DISCOVERY-D3-001` (`MASTER_PLAN.md`)
**Source-code anchor:** `packages/registry/src/storage.ts` (multi-column vec0 schema; v3 implementation pending operator decision per `DEC-V3-INITIATIVE-002`)
**Cross-reference:** `docs/adr/discovery-multi-dim-embeddings.md` (D1 ADR), `docs/adr/discovery-ranking.md` (D3 ADR)
**First public disclosure:** v3 discovery D-series ADRs landing (D1: 2026-05-08; D3: 2026-05-08)

**Claim-style description.** A query-and-retrieval schema for a content-addressed code registry comprising:

(a) **Per-aspect embedding dimensions.** Each registry entry is associated with a tuple of vector embeddings, one per declared aspect of the entry's specification: behavior, guarantees, error conditions, non-functional properties, and property-test descriptions. The embeddings are stored in a vector database (e.g., a `sqlite-vec` `vec0` virtual table with one `FLOAT[N]` column per dimension) keyed on the registry entry's identity.

(b) **Query-time weighted cosine.** Queries are expressed as a `QueryIntentCard` carrying a partial specification plus per-dimension weight values. At query time, the cosine similarity between the query's per-dimension embedding and each registry entry's corresponding per-dimension embedding is computed; the weighted sum (using the query's weight values, renormalized over the surviving non-null dimension set) yields a combined score in [0, 1]. The query operator may emphasize different aspects for different queries (e.g., "behavior must match" vs "guarantees must match") by adjusting the weight values.

(c) **Binary structural filter governs correctness.** A binary structural-match filter (e.g., type-signature compatibility, declared-strictness lattice membership) gates correctness *independently* of the cosine score. A candidate that scores high on cosine but fails the structural filter is rejected; cosine score never decides correctness. This preserves the substrate's cornerstone that "embedding is just an index" — vector similarity surfaces candidates; structural matching plus declared strictness decides selection.

(d) **Five-stage ranking pipeline.** Candidates flow through: (i) vector KNN retrieval; (ii) structural filter (binary gate); (iii) strictness filter (binary gate against declared strictness); (iv) reserved stage for future verification-aware ranking; (v) final ranking with tiebreaker hierarchy (property-test depth → usage history → test history → atom age → lexicographic identity).

**Novelty argument.** Vector retrieval for code is well-established in code search (CodeBERT, GraphCodeBERT, OpenAI embeddings for retrieval-augmented code generation). The novelty here is the composition: **per-aspect multi-dimensional embedding** (rather than a single concatenated embedding) **with operator-controlled query-time weighting** **and a binary structural-correctness filter that gates independently of cosine score**, applied to a content-addressed registry whose identity model is governed by M1/M2/M5 above. None of (a)–(d) individually is unprecedented; the combination, applied to a no-ownership monotonic registry with a strict-subset shaveability predicate, is novel.

---

## M7 — Hook architecture: registry-hit / synthesis-required / passthrough triad with contract skeleton on miss

**Decision-log anchor:** `DEC-HOOK-CLAUDE-CODE-PROD-001`, `DEC-HOOK-LAYER-001`, `DEC-HOOK-BASE-001` (`MASTER_PLAN.md`)
**Source-code anchor:** `packages/hooks-base/src/index.ts` (the typed-triad return contract), `packages/hooks-claude-code/src/index.ts`, `packages/hooks-cursor/src/index.ts`, `packages/hooks-codex/src/index.ts`
**Cross-reference:** `docs/adr/hook-layer-architecture.md` (full hook architecture ADR)
**First public disclosure:** `WI-V1W2-HOOKS-01` landing (initial Claude Code hook); subsequently refined in WI-HOOK-LAYER Phase 0/1/2 cascade

**Claim-style description.** An integration architecture for AI-coding-agent code-emission interception in which the agent's intent to emit code (delivered to the hook as an `EmissionContext` carrying a natural-language intent plus optional surrounding source context) is processed by a hook subprocess that queries a content-addressed code registry (M1/M2) and returns one of exactly three typed outcomes:

(a) **`registry-hit`.** A registry entry's specification matches the emission intent above a confidence threshold AND passes the binary structural filter (per M6 stage 2). The hook returns the entry's content address (BlockMerkleRoot) plus optionally the surrounding metadata required for substitution. The agent's emitted code is replaced with a reference to the registry entry; the file on disk reflects the substitution, not the original emission.

(b) **`synthesis-required`.** No registry entry matches with sufficient confidence. The hook returns a **contract skeleton** (the structured specification of what the agent should synthesize — inputs, outputs, behavior text, guarantees, error conditions, non-functional properties, property-test stubs) **rather than generated code**. The agent synthesizes the implementation to satisfy the skeleton, and the resulting block is a candidate for novel-glue registration with the registry.

(c) **`passthrough`.** An infrastructure error occurred (registry unreachable, embedding-provider error, et cetera). The hook returns no substitution and no skeleton; the agent's original emission proceeds unchanged. This is explicitly reserved for infrastructure errors — it is **not** an escape hatch for low-confidence matches or operator preferences.

**Novelty argument.** AI code-completion systems (GitHub Copilot, Cursor, Anthropic Claude Code, et al.) generate code in response to context. None known to the substrate authors intercept emission intent and (i) consult a content-addressed registry to substitute existing blocks, AND (ii) on registry-miss return a contract skeleton (a specification, not code) to direct the agent toward synthesizing into a registry-compatible shape. The triad's particular combination — **registry-hit as substitution, synthesis-required as contract-skeleton, passthrough as infrastructure-error-only** — is the novel composition. Cornerstone-bound: cosine alone does not decide hit vs miss; the binary structural filter (M6) is the deciding criterion at the hook boundary as well.

---

## M8 — F0..F4 trust/scale federation axis with slashing-as-deprecation

**Decision-log anchor:** `DEC-FED-001` through `DEC-FED-006` (`FEDERATION.md` and `MASTER_PLAN.md`)
**Source-code anchor:** `packages/federation/src/pull.ts`, `packages/federation/src/serve.ts` (F1 implementation; higher tiers specified, not yet implemented)
**Cross-reference:** `FEDERATION.md` (full federation axis specification)
**First public disclosure:** `FEDERATION.md` v1 landing

**Claim-style description.** A federation participation ladder for content-addressed code registries comprising five trust/scale tiers:

- **F0** — Single-machine deployment. Registry is a local SQLite file. No network operations. First-class deployment posture at every substrate-maturity level.
- **F1** — Read-only mirror. Federation peers fetch blocks from each other over a content-addressed protocol; every transferred block is integrity-checked by recomputing the M1 block_merkle_root from the received bytes.
- **F2** — Write-allowing federation. Peers accept block submissions from other peers; disputes resolved via structural-match adjudication against a designated authoritative peer.
- **F3** — Proof-of-fuzz attestation. Federation participants stake compute on fuzzing campaigns against registry entries; attestation evidence (counterexamples found, fuzz hours elapsed) attaches to the entry's mutable metadata (see M9).
- **F4** — Stake-to-refine economic model, with **slashing-as-deprecation** as the primary protective primitive.

**The slashing-as-deprecation mechanism.** A federation participant who refines a registry entry (e.g., introducing a tighter property test or stricter implementation) may stake a deposit attesting to the refinement's correctness. If the refinement is subsequently shown to be incorrect (a counterexample is found via M9 verification, or the refinement's guarantees are violated in production), the slashing primitive **does not seize the participant's stake into any owner's account** — because the registry has no owners (M2). Instead, the slashing mechanism **deprecates the failing block at the registry level**: the block is marked deprecated metadata-wise (immutable identity retained per M2 cornerstone #6), the stake is destroyed (not transferred), and future federation queries deprioritize the deprecated block. The participant's stake is gone; no party gains from its destruction; the registry's quality is preserved by the deprecation signal.

**Novelty argument.** Federated software registries exist (npm registry, PyPI mirror network, IPFS-based code distribution). Federation-with-economic-staking exists in the blockchain space (validator staking, prediction markets). The specific combination — **content-addressed code registry** with **multi-tier federation ladder where the highest tiers carry economic primitives** with **slashing-as-deprecation rather than slashing-as-seizure** to preserve the **no-ownership cornerstone** of the underlying registry — is novel. The slashing-as-deprecation primitive in particular is novel because it inverts the usual slashing semantics (transfer-of-value to a protocol treasury or reward pool) to a pure destruction-with-deprecation-signal, which only makes sense when there is no owner to receive the seized stake.

---

## M9 — Verification ladder L0..L3 with triplet-based attestation

**Decision-log anchor:** `DEC-VERIFY-001` through `DEC-VERIFY-010` (`VERIFICATION.md` and `MASTER_PLAN.md`)
**Source-code anchor:** `packages/contracts/src/proof-manifest.ts` (proof manifest schema), `packages/registry/src/storage.ts` (verification evidence storage)
**Cross-reference:** `VERIFICATION.md` (full verification ladder specification)
**First public disclosure:** `VERIFICATION.md` v1 landing

**Claim-style description.** A four-level verification-rigor axis for content-addressed code registry entries:

- **L0** — Property tests. The block is associated with property-test code (`property_tests` artifact in the proof manifest) and has executed those tests successfully at registry-write time.
- **L1** — Totality. The block's implementation is total over its declared input domain (no panics, no infinite loops, no implicit error paths). Totality is checked by structural analysis plus property-test coverage of edge cases.
- **L2** — SMT / BMC. The block's contract is verified via SMT-based bounded model checking against the implementation; counterexamples found during verification become regression tests attached to the block.
- **L3** — Machine-checked formal proof. The block's contract is proven in a machine-checked proof assistant (e.g., Lean) and the proof script is itself a registry artifact.

**Triplet-based attestation.** A block's verification level is **mutable metadata attached to the immutable block_merkle_root** (per M1). The block's identity does not change when its verification level rises from L0 to L1 to L2 to L3; only the attestation evidence (property tests, totality witnesses, SMT proofs, Lean proof scripts) is added to the entry's metadata. This decouples **identity** (hash of canonical artifacts) from **trust** (verification status): two participants disagreeing on whether a block has reached L2 can still address it by the same identity.

**Novelty argument.** Software verification systems exist in static analysis, SMT-based verification (Frama-C, KeY, Dafny), and formal proof (Coq, Lean, Isabelle/HOL). Property-test-as-evidence exists (QuickCheck, fast-check). The novelty here is the combination: a **four-level verification ladder** where (i) levels are operator-declarable goals, (ii) evidence at each level attaches as mutable metadata to a content-addressed identity, (iii) the identity does NOT change when the verification level rises, and (iv) the levels are explicitly **orthogonal** to the federation axis (M8) and the substrate-maturity axis (M10) — a single-machine F0 deployment at v0 substrate maturity can host blocks at any verification level.

---

## M10 — Cross-axis orthogonality (v / F / L)

**Decision-log anchor:** `DEC-AXIS-017` (`MASTER_PLAN.md`)
**Source-code anchor:** Architectural — no single file; orthogonality is enforced by the absence of cross-axis coupling in `packages/registry/src/`, `packages/federation/src/`, and verification-evidence storage paths.
**Cross-reference:** `DESIGN.md` (axis architecture section), `MASTER_PLAN.md` (orthogonality cornerstone discussion)
**First public disclosure:** Substrate v0 stage spec landing

**Claim-style description.** A composed software-substrate architecture explicitly designed around three orthogonal axes:

- **v (substrate-maturity axis).** v0 / v1 / v2 / v3 / ... describing the substrate's capability stages.
- **F (federation participation axis).** F0 / F1 / F2 / F3 / F4 per M8.
- **L (verification rigor axis).** L0 / L1 / L2 / L3 per M9.

The axes are **orthogonal** in the architectural sense: a deployment at any point in the cross-product space `(v, F, L)` is first-class — there is no coupling that makes (e.g.) "v2 substrate at F0 federation with L2 verification" architecturally invalid or operationally degraded relative to "v2 substrate at F4 federation with L2 verification." A single-machine, no-network, no-stake F0 deployment at v0 substrate maturity is as much "the real yakcc" as any networked, staked, formally-verified higher-tier deployment.

**Architectural commitment.** The orthogonality is itself a design pattern: every cross-axis coupling that arises in implementation is treated as a bug, and the substrate's package decomposition (`@yakcc/registry` vs `@yakcc/federation` vs `@yakcc/contracts` carrying verification schemas) reflects the axis split.

**Novelty argument.** Multi-dimensional architecture-style axes exist in product taxonomies, ML model release pipelines (model size × training data × verification), and platform-engineering frameworks. The novelty here is (i) the specific identification of v / F / L as the substrate's load-bearing orthogonal axes, (ii) the explicit operational commitment that every point in the cross-product is first-class (not merely a degraded version of "the full deployment"), and (iii) the architectural enforcement of orthogonality via package-boundary discipline. Combined with M1–M9, the orthogonality is what makes the no-ownership cornerstone (M2) durable: a fully-local F0 / L0 / v-current deployment is operationally complete, and no federation-tier or verification-tier requirement can be imposed retroactively as a precondition for substrate use.

---

## Patent-search keyword glossary

The following technical terms appear in the mechanisms above and are intended to maximize prior-art findability under common patent-search vocabulary:

- Content-addressed code registry
- Triplet content-addressing (specification + implementation + proof)
- Block Merkle root for code artifacts
- Canonical AST hash for structural equivalence
- AST canonicalization at registry-write time
- Strictness-monotonic registry
- Strictness-driven selection among multiple implementations of a specification
- Slicer with subgraph-level shaveability predicate
- Glue-leaf entry for non-shaveable project-local subgraphs
- Atom-test reviewer gate (mechanical hard-fail acceptance)
- Multi-dimensional embedding for code retrieval
- Per-aspect embedding with operator-controlled query-time weighting
- Binary structural filter as cosine-independent correctness gate
- Five-stage ranking pipeline (vector KNN + structural + strictness + reserved + final ranking)
- Hook-based AI-coding-agent integration with registry-hit / synthesis-required / passthrough triad
- Contract skeleton on registry miss (specification-not-code response)
- Federation participation ladder with proof-of-fuzz and stake-to-refine tiers
- Slashing-as-deprecation (stake destruction without seizure)
- No-ownership federation primitive
- Verification ladder for code registry entries (property-tests / totality / SMT / formal proof)
- Mutable verification metadata attached to immutable content-address
- Cross-axis orthogonality (substrate maturity × federation × verification)

---

## Decision-log entry

> `@decision DEC-PRIOR-ART-001`
> **Status:** accepted (this document — WI-PRIOR-ART-001).
> **Rationale:** Filed as a single document at `docs/PRIOR_ART.md` (recommendation per the issue body — single-file form maximizes prior-art searchability versus per-mechanism split). Includes a patent-search-keyword glossary at the end (recommendation per the issue body — improves examiner findability). `MANIFESTO.md` is left untouched (recommendation per the issue body — MANIFESTO is rhetorical, this document is technical; cross-mixing dilutes both).
> **Cross-references:** `LICENSE`, `LICENSE-ATOMS` (the licensing instruments under which the mechanisms are open), Cornerstones #1, #2, #3, #4, #5, #6 (`MASTER_PLAN.md` — the no-ownership commitment that motivates this filing).

---

## Closing reaffirmation

The mechanisms described in this document are dedicated to the public commons. No rights are retained by the substrate authors. This document is itself part of the prior-art record by virtue of being published on a public timestamped repository and indexed by repository search engines, patent-search prior-art databases, and downstream prior-art researchers.

If a third party asserts an intellectual-property claim over any mechanism described herein, this document — together with the source-code anchors, decision-log anchors, and supporting documents (`MASTER_PLAN.md`, `DESIGN.md`, `MANIFESTO.md`, `FEDERATION.md`, `VERIFICATION.md`) cited per-mechanism — constitutes evidence of prior art predating the assertion.
