# DEC-HOOK-LAYER-001 — AI agent interception architecture

**Status:** Accepted (Phase 0 design pass; implementation deferred to WI-HOOK-LAYER Phases 1–5)
**Date:** 2026-05-10
**Issue:** https://github.com/cneckar/yakcc/issues/194
**Initiative:** WI-HOOK-LAYER (v0.5+ GTM surface — local-dev usability)

---

## Context

The hook layer is the user-facing surface of yakcc. Without it, yakcc is a registry plus a CLI; with it, yakcc is the substrate that intercepts AI coding agents and substitutes content-addressed atom references for re-emitted code. Five of nine project benchmarks (B3, B4, B5, B7, B8-CURVE — issues #187, #188, #189, #191, #193) gate on hook-layer existence; the v0.5 GTM thesis cannot be measured without it.

The `@yakcc/hooks-base` package already exists and carries substantial infrastructure (per `DEC-HOOK-BASE-001`, 213 LoC at `packages/hooks-base/src/index.ts`):

- `EmissionContext` shape (intent + optional source context).
- `HookResponse` discriminated union: `registry-hit | synthesis-required | passthrough`.
- `executeRegistryQuery()` calling `Registry.findCandidatesByIntent({ k: 1, rerank: "structural" })` against the **single-vector** embedding path (`DEC-EMBED-010`).
- Marker-file write helper for the v0/v1 facade (`writeMarkerCommand` writes a JSON marker to `~/.claude` / `~/.cursor` / `~/.yakcc`).
- IDE-specific adapter packages: `@yakcc/hooks-claude-code`, `@yakcc/hooks-cursor`, `@yakcc/hooks-codex` (139, 139, 132 LoC respectively).

The CLI install command (`yakcc hooks claude-code install`) is a v0 facade per the README header note (lines 76–84): writes a documentation stub to `.claude/` but does not wire production interception into Claude Code's actual integration surfaces. `WI-V05-CLI-INSTALL-RETIRE-FACADE` (#203) is the implementation ticket that retires the facade once this ADR's decisions land.

This ADR makes six load-bearing decisions (D-HOOK-1 through D-HOOK-6) about how the production hook should evolve from the current v0/v1 facade to a real interception + substitution + telemetry surface. The decisions are constrained by the project cornerstones (`AGENTS.md`) and by the v3 discovery design (D1–D6 ADRs already landed).

## Boundary with v3 discovery (D1–D6)

The hook calls into discovery for atom resolution. The boundary is intentionally narrow:

- **Discovery owns**: embedding generation, multi-dim vector storage, KNN search, structural matching, score banding, candidate ranking. (D1–D6.)
- **Hook owns**: capturing the LLM's emission intent, calling discovery, deciding whether to substitute, performing the substitution, surfacing the atom contract back into LLM context, capturing telemetry.

Discovery returns a `Candidate[]` ranked per `DEC-V3-DISCOVERY-D3-001`. The hook's job is to decide *what to do with that result* in the context of an active LLM session — not to re-rank or filter on cosine. Cornerstone #4 ("embedding is just an index") is preserved at the hook boundary by deferring all selection to discovery's structural + property-test stages.

The hook depends on `WI-V3-DISCOVERY-D5-HARNESS` (#200) producing a measurement-first baseline before Phase 2 (smart substitution) ships. Per `DEC-V3-INITIATIVE-001`, if the single-vector embedding (DEC-EMBED-010) already meets D5's M1 ≥ 80% hit-rate target, the multi-dim migration (D1's 5× storage cost) is unjustified and v3 implementation pauses pending re-spec. The hook layer is unaffected by this gate — it works against whichever embedding shape discovery exposes via `Registry.findCandidatesByIntent` / `Registry.findCandidatesByQuery`.

---

## Decision

### D-HOOK-1: First IDE target — Claude Code

**Decision:** Claude Code is the first production-target IDE for the v0.5 hook layer. Cursor follows in Phase 4. Codex CLI in Phase 5 if and only if demand surfaces. An agnostic / proxy mode (intercepting Anthropic / OpenAI API traffic at the network layer) is explicitly **not pursued** without operator-approved demand signal.

**Rationale.** Three considerations dominate the IDE choice for v0.5:

1. **Tightness of integration surface.** Claude Code exposes settings.json hooks, MCP server registration, and slash-command surfaces — all of which can host the hook without modifying Claude Code itself. Cursor's extension API is broader but less stable; Codex CLI is leanest but smallest user base. Claude Code is the strongest signal-per-engineering-hour bet.
2. **Reference setup.** The orchestrator session is a Claude Code session; we live in the tool we are integrating with. Iteration cost per design loop is minutes, not days.
3. **Reverse compatibility cost.** The `@yakcc/hooks-base` package was designed to abstract the IDE-specific surface (`DEC-HOOK-BASE-001` consolidates duplicated EmissionContext / HookResponse / HookOptions across all three consumer packages). Adding a new IDE adapter is bounded work; the architectural decisions in this ADR are IDE-agnostic at the base-package level.

The agnostic / proxy mode is rejected for v0.5 because it amplifies engineering scope (HTTP traffic interception, vendor-specific request/response parsing per Anthropic / OpenAI API surface, TLS termination concerns) for a generality benefit that is not yet demanded by any user.

### D-HOOK-2: Interception layer — tool-call interception

**Decision:** The hook intercepts at the **tool-call layer** (Claude Code's `Edit` / `Write` / `MultiEdit` tool calls), not at the file-write layer or the prompt-rewrite layer. The hook receives the proposed `new_string` content before it is written to disk; it has the opportunity to substitute an atom reference; it returns either the original or substituted content; the IDE writes whatever the hook returned.

**Rationale.** Three options were considered:

- **(a) Tool-call interception** *(chosen)*. Mechanically clean; the agent's tool emission is the natural seam. The IDE's tool-execution surface already serializes calls, so there is no race between detecting an emission and substituting it. Settings.json hook configuration in Claude Code makes the wiring explicit and operator-controllable. Selected.
- **(b) File-write interception.** Watch the file system for changes; substitute after the agent writes. Broader (catches anything that touches disk) but fragile (the tool that wrote the file may have already returned its observation to the agent before substitution lands; the LLM's next-turn reasoning is then inconsistent with what's on disk). Rejected.
- **(c) Prompt-rewrite.** Modify outgoing prompts to teach the LLM about atoms (no interception). Lightest weight; testable today. Captured by B8's "Yakcc-aware prompting baseline" condition (#193 DQ-7). It is a complementary technique that may layer on top of (a), not a replacement.

Tool-call interception preserves the agent's mental model: when the agent emits an `Edit` tool call and the tool returns success, what's on disk matches what the agent thinks it wrote — modulo the contract comment surfaced per D-HOOK-4.

### D-HOOK-3: Synchronous vs asynchronous — synchronous, ≤200ms budget

**Decision:** Atom resolution runs **synchronously** during tool-call interception. The agent's tool call blocks while discovery runs and substitution decides. The end-to-end latency budget for the substitution path (intent extraction → discovery query → ranking → substitution decision → contract-comment generation) is **≤200ms p95**. If discovery cannot meet this budget, the fix is to make discovery faster, **not** to switch to asynchronous post-emission rewriting.

**Rationale.** Two options were considered:

- **(a) Synchronous** *(chosen)*. Agent's current turn sees the substituted version; the next turn's reasoning is immediately consistent with what's on disk. Multi-turn coherence (B5) is preserved by construction. Latency is the sole concern, mitigated by the ≤200ms budget and discovery's local-SQLite + sqlite-vec architecture (no network I/O on the hot path).
- **(b) Asynchronous.** Code lands as the agent emitted; hook substitutes in the background; subsequent turns see the substituted version. Zero perceived per-call latency, but the agent's *current* turn cannot reason about the substitution. The agent emits code, observes the tool result (which says "wrote X bytes"), and may then write follow-up code that references the unsubstituted version. The hook then has to either revert its own substitution or accept that the LLM's mental model has drifted from disk.

The 200ms budget is enforced as a hard cap. A budget violation is a regression that must be fixed in discovery (D5 calibration knobs, D6 migration tuning, or per-dimension model adjustment per D1's v3.1 trigger — see ADR docs/adr/discovery-multi-dim-embeddings.md). The hook does not include a "fall back to async if discovery is slow" escape hatch — that escape hatch silently degrades coherence guarantees and would mask discovery regressions.

### D-HOOK-4: Contract surfacing — inline contract comment

**Decision:** When the hook substitutes an atom reference for emitted code, the substituted bytes are an **inline contract comment** followed by an atom-import + call expression. The comment format is:

```
// @atom <atomName> (<signature>; <key-guarantee>) — yakcc:<BlockMerkleRoot[:8]>
```

For example, substituting a JSON-integer-list parser:

```ts
// @atom listOfInts (string => number[]; rejects non-int) — yakcc:abc12345
import { listOfInts } from "@yakcc/atoms/listOfInts";
const result = listOfInts(input);
```

The full BlockMerkleRoot is emitted in a sidecar comment (or the import path's namespaced suffix) so the agent can resolve the atom's full contract via D4's `yakcc_resolve(query)` tool surface in subsequent turns.

**Rationale.** Three options were considered:

- **(a) Opaque hash only.** Substitute `yakcc:abc123def456` with no surrounding semantics. Catastrophic for B5 coherence: the LLM has no way to reason about what the atom does, so subsequent turns either re-emit the original code (defeating the point) or hallucinate atom semantics (worse). Rejected.
- **(b) Inline contract comment** *(chosen)*. Best signal-to-noise in the LLM's context window; lowest cognitive load. The contract comment carries the atom's name, signature, and one key guarantee — enough for the LLM to reason about whether to use the atom in subsequent calls without consulting D4's tool surface for routine cases. The full contract is one tool-call away (`yakcc_resolve("listOfInts")`) when needed.
- **(c) Sidecar contract file.** Ref-only in source; contract definitions in a sibling `.yakcc-contracts/` file. Cleaner source code, but requires the LLM to read an additional file to reason about substitutions. The cognitive overhead breaks the coherence loop.

The inline contract format is intentionally short (~60–120 characters per substitution). Per cornerstone #5 (composition from minimal blocks), the comment carries only what's needed for routine reasoning; richer information is available on-demand via D4's tool surface.

### D-HOOK-5: Telemetry shape — local-only by default; cornerstone-bound

**Decision:** Hook telemetry is **local-only by default**. Telemetry data is written to `~/.yakcc/telemetry/<session-id>.jsonl` (configurable via `YAKCC_TELEMETRY_DIR`). The captured fields per emission event:

```ts
type TelemetryEvent = {
  readonly t: number;                     // unix ms
  readonly intentHash: string;            // BLAKE3 of the EmissionContext.intent (NOT the intent text)
  readonly toolName: "Edit" | "Write" | "MultiEdit";
  readonly candidateCount: number;
  readonly topScore: number | null;
  readonly substituted: boolean;
  readonly substitutedAtomHash: string | null;  // BlockMerkleRoot[:8] if substituted
  readonly latencyMs: number;             // end-to-end discovery + decision latency
  readonly outcome: "registry-hit" | "synthesis-required" | "passthrough";
};
```

**No personally-identifying data is captured.** The intent text itself is hashed before storage; the LLM-emitted code is never logged; user identifier, repository name, file path, and project metadata are all excluded. Opt-in upload (to a future yakcc-the-company telemetry endpoint or a customer's own collection point) requires explicit operator config (`YAKCC_TELEMETRY_UPLOAD_URL` env var); there is no implicit network traffic.

**Rationale.** This is the hardest cornerstone-bound decision in the ADR. Cornerstone #2 (no ownership; the registry is a public-domain commons) does not directly constrain telemetry, but its spirit ("no owner is being preserved here") extends to the hook layer: a system designed around no-ownership should not become a backdoor for telemetry-derived ownership of usage patterns. Three implementation paths preserve the spirit:

- **(a) No telemetry.** Maximally pure. Loses the data needed to validate B3 (cache hit rate), B4 (token expenditure), and B8 (scaling curve). Rejected because the benchmark suite has no measurement path otherwise.
- **(b) Anonymized local-only with opt-in upload** *(chosen)*. Captures hit/miss / latency / atom-hash data needed for benchmarks; never captures identifying data; upload is opt-in. Preserves the no-ownership posture.
- **(c) Full telemetry to a cloud endpoint by default.** Standard SaaS telemetry pattern. Rejected: violates the spirit of cornerstone #2 and the no-ownership project ethos. Adopting it would visibly signal a commercial pivot in artifacts that are supposed to be PD-commons-aligned.

The `intentHash` field uses BLAKE3 of the intent text rather than storing the text itself. This preserves the ability to ask "did this *exact* intent appear before?" (useful for cache-hit-rate measurement) without storing the intent contents, which could otherwise leak natural-language descriptions of customer-internal logic.

The B6 air-gapped CI gate (#190) enforces that the default configuration produces zero outbound network calls — including from the telemetry pipeline. Any code path that violates this is a stop-the-line bug, regardless of whether it would be useful telemetry.

### D-HOOK-6: Discovery integration shape — embedded library call

**Decision:** The hook calls discovery as an **embedded library call**, not via IPC, RPC, or a separate process. `@yakcc/hooks-base` declares a workspace dependency on `@yakcc/registry` (already in place per `DEC-HOOK-BASE-001`); the hook calls `Registry.findCandidatesByIntent(query, options)` (current single-vector path) or `Registry.findCandidatesByQuery(query, options)` (post-WI-V3-DISCOVERY-IMPL-QUERY) directly.

**Rationale.** Two options were considered:

- **(a) Embedded library call** *(chosen)*. Same-process; no IPC overhead. Aligns with cornerstone #5 (composition). Latency budget under D-HOOK-3 (200ms) is achievable without process-boundary serialization costs. The hook process IS the registry process.
- **(b) Out-of-process discovery service.** Hook calls a sidecar daemon (`yakccd`) over IPC. Architecturally cleaner for sharing a registry across multiple hook clients. But: (1) it forces every yakcc-using process to either run its own daemon or coordinate on a shared one — operationally complex; (2) IPC marshalling adds latency that erodes the D-HOOK-3 budget; (3) the air-gapped story (B6) gets harder because every process boundary is a network-boundary candidate to audit; (4) no demonstrated need — current registry use cases are CLI-driven, single-process.

The library-call approach implies that the hook process must include the `@yakcc/registry` runtime (and transitively `better-sqlite3` + `sqlite-vec`). For Claude Code, this means the hook runs in a Node.js subprocess that Claude Code spawns per the settings.json hook configuration; the subprocess opens the local registry and serves the resolution request synchronously.

---

## Migration from v0/v1 hook (current state → desired)

The existing `@yakcc/hooks-base` already implements the load-bearing logic (`executeRegistryQuery`). The migration to the production hook is **additive across phases**, not a rewrite:

| Phase | Adds | Replaces |
|---|---|---|
| 1 — Telemetry-only MVP | Telemetry capture (D-HOOK-5); real Claude Code settings.json wiring (replaces v0 facade); production CLI install per #203 | Marker-file pattern in `executeRegistryQuery`; `yakcc hooks claude-code install` v0 stub |
| 2 — Smart substitution | Wire `executeRegistryQuery`'s `registry-hit` outcome into actual tool-call rewriting; perform substitution per D-HOOK-2; surface substitution latency per D-HOOK-3 | Currently no substitution happens — `registry-hit` returns the ContractId but the IDE keeps the original emitted code |
| 3 — Contract surfacing | D-HOOK-4 inline contract comments; D4 `yakcc_resolve` tool-call surface | None (additive) |
| 4 — Cursor adapter | `@yakcc/hooks-cursor` parity with `@yakcc/hooks-claude-code` | The Cursor v0 facade per #204-equivalent ticket |
| 5 — Codex / agnostic (conditional) | `@yakcc/hooks-codex` parity OR API-level proxy if demand surfaces | Codex v0 facade |

**`executeRegistryQuery` survives across all phases.** Its production logic is correct today (single-vector path or multi-dim path post-D1 implementation); the gap is in what happens after the function returns. Phases 1–5 add wiring around it, not within it.

---

## Alternatives considered (cross-cutting)

### Alternative A: Build the hook as a fork of an existing tool (cline, aider, etc.)

Forking accelerates the IDE-integration surface but locks yakcc to a specific upstream's evolution. The hook layer is small enough (the load-bearing logic is `executeRegistryQuery`'s ~30 lines) that the cost of a clean implementation is lower than the maintenance cost of tracking an upstream. Rejected.

### Alternative B: Skip Phase 1 (telemetry-only MVP); start at Phase 2 (substitution)

Tempting because Phase 2 is the user-visible product. Rejected because: (1) substitution without telemetry can't be benchmarked (B3/B4/B8 all need the data); (2) substitution without an established interception surface puts more in flight at once, increasing rollback complexity; (3) Phase 1 produces measurable hit-rate data even before substitution lands, which sharpens the calibration of D5's M1 metric and the auto-accept threshold from D2 / D4.

### Alternative C: Make atom substitution opt-in per substitution (LLM consents inline)

For each potential substitution, surface the candidate to the LLM and let it accept or reject. Rejected: (1) doubles the per-emission tool-call count (proposal + substitution); (2) the auto-accept threshold from D2 (top-1 score > 0.85, gap > 0.15) is exactly the heuristic that makes opt-in unnecessary; (3) D4's `ConfidenceMode` enum (`auto_accept | always_show | hybrid`) already provides operator-side control of this trade-off.

### Alternative D: Cache the LLM's emitted code, then substitute only after a session ends

Avoids the in-session latency budget entirely. Rejected: (1) breaks the coherence loop (B5) — the LLM never sees its substitutions in the same session; (2) post-session substitution is essentially a code-modification tool, which is a different product category from "live agent interception"; (3) the latency budget under D-HOOK-3 is achievable with the current registry architecture; the constraint is engineering effort, not architecture.

---

## When to revisit

This ADR should be re-opened if any of the following occur:

- **Discovery latency exceeds the D-HOOK-3 200ms budget.** Triggers a discovery-side investigation (D5 calibration, D6 migration tuning, or per-dimension model adjustment). The hook's latency budget is non-negotiable; the fix is in discovery.
- **B3 cache hit rate < 30% on real-world workloads** at corpus saturation. Triggers re-examination of D-HOOK-4 contract surfacing (is the LLM actually using the substituted atoms in subsequent turns?) and possibly D-HOOK-2 interception layer (is tool-call the right seam?).
- **B5 coherence rate < 90%.** Triggers re-examination of D-HOOK-4 contract format. The contract comment may need to carry more or less information than the chosen format.
- **A second IDE acquires substantial market share** that we're not addressing via Phase 4 (Cursor) or Phase 5 (Codex). Triggers consideration of D-HOOK-1's "build agnostic first" alternative — but only with explicit demand signal, not preemptively.
- **A regulated-industry customer requires telemetry guarantees stricter than D-HOOK-5's local-only default** (e.g., "no telemetry data leaves the air-gapped VPC under any circumstance, including operator-explicit upload"). Triggers a `--no-telemetry` flag or compile-time exclusion.

---

## Implementation phase boundary

Phase 0 (this ADR) ships:

- This document at `docs/adr/hook-layer-architecture.md`
- `DEC-HOOK-LAYER-001` row in MASTER_PLAN's Decision Log (filed alongside this commit)
- Implementation cascade as sub-tickets of #194, filed concurrently

Phases 1–5 are tracked as separate WIs. Each implementation WI cites this ADR in its pre-assigned-decision section and is bounded by the decisions herein. Implementation WIs:

| Phase | WI | Description | Estimate | Dependencies |
|---|---|---|---|---|
| 1 | WI-HOOK-PHASE-1-MVP | Telemetry-only MVP: real Claude Code settings.json wiring, telemetry capture per D-HOOK-5, retire the v0 marker-file facade | ~3 weeks | #203, #200 (D5-HARNESS measurement-first baseline) |
| 2 | WI-HOOK-PHASE-2-SUBSTITUTION | Smart substitution: rewrite tool-call output per D-HOOK-2; integrate D2 `findCandidatesByQuery` post-WI-V3-DISCOVERY-IMPL-QUERY | ~4 weeks | Phase 1 + WI-V3-DISCOVERY-IMPL-QUERY |
| 3 | WI-HOOK-PHASE-3-CONTRACT-SURFACING | Inline contract comment per D-HOOK-4; integrate D4 `yakcc_resolve` MCP/tool surface | ~2 weeks | Phase 2 + WI-V3-DISCOVERY-IMPL-CLI |
| 4 | WI-HOOK-PHASE-4-CURSOR | Cursor adapter parity (per `@yakcc/hooks-cursor` package skeleton) | ~3 weeks | Phase 3 |
| 5 | WI-HOOK-PHASE-5-CODEX-OR-AGNOSTIC | Conditional: Codex CLI parity OR API-level proxy mode (only if demand surfaces) | TBD | Phase 4 |

Phase 5 is explicitly conditional. If neither the Codex CLI base grows nor the demand for an agnostic proxy materializes within ~3 months of Phase 4 landing, Phase 5 is closed without action.

---

## References

- Issue: https://github.com/cneckar/yakcc/issues/194
- Cornerstones: `AGENTS.md` ("Cornerstone (do not violate without explicit replanning)")
- Existing hook infrastructure:
  - `packages/hooks-base/src/index.ts` (`DEC-HOOK-BASE-001`)
  - `packages/hooks-claude-code/src/index.ts`
  - `packages/hooks-cursor/src/index.ts`
  - `packages/hooks-codex/src/index.ts`
- Discovery integration:
  - D1: `docs/adr/discovery-multi-dim-embeddings.md` (`DEC-V3-DISCOVERY-D1-001`)
  - D2: `docs/adr/discovery-query-language.md` (`DEC-V3-DISCOVERY-D2-001`)
  - D3: `docs/adr/discovery-ranking.md` (`DEC-V3-DISCOVERY-D3-001`)
  - D4: `docs/adr/discovery-llm-interaction.md` (`DEC-V3-DISCOVERY-D4-001`)
  - D5: `docs/adr/discovery-quality-measurement.md` (`DEC-V3-DISCOVERY-D5-001`)
  - D6: `docs/adr/discovery-migration.md` (`DEC-V3-DISCOVERY-D6-001`)
- Related decisions:
  - `DEC-V3-INITIATIVE-001` — measurement-first guardrail (gates Phase 2)
  - `DEC-EMBED-010` — single-vector embedding (current hook integration)
  - `DEC-VECTOR-RETRIEVAL-001/004` — `findCandidatesByIntent` placement
  - `DEC-V05-CLI-FACADE-001` (TBD via #203) — facade retirement
- Benchmark dependencies:
  - B3 #187, B4 #188, B5 #189, B7 #191, B8-CURVE #193 — all gated on this initiative
  - B6 #190 — air-gapped CI gate (enforces D-HOOK-5's zero-outbound-by-default rule)
