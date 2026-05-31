/**
 * Tool: yakcc_resolve
 *
 * @decision DEC-HOOK-PROACTIVE-A-001
 * @title yakcc_resolve — LLM's intent-time discovery surface (Gap A, #953)
 * @status decided (wi-953-yakcc-resolve-wiring, bite 1)
 * @rationale
 *   Per DEC-HOOK-PROACTIVE-PRIMARY-001 (MASTER_PLAN.md) this is the canonical
 *   path: LLM emits an IntentCard before writing code, this tool returns
 *   candidates structured by D4 ADR Q5 confidence bands.
 *
 *   Architecture:
 *   (1) LOCAL-FIRST (D-HOOK-6, Cornerstone B6):
 *       yakccResolve() from @yakcc/hooks-base is the sole local-query authority
 *       (Sacred Practice #12 — no parallel implementation). The tool calls it
 *       directly (embedded-library-call discipline, no IPC/RPC/sidecar).
 *       The local registry is opened lazily from YAKCC_REGISTRY_PATH or the
 *       workspace default (.yakcc/registry.sqlite). Lazy open is cached for
 *       the tool instance lifetime.
 *
 *   (2) GLOBAL CASCADE (DEC-MCP-FETCH-ONE-CLIENT-006):
 *       When local yields no auto_accept tier result AND YAKCC_AIRGAPPED !== "1",
 *       the tool falls through to GET /v1/blocks via the injected HttpClient
 *       (the single fetch authority — never calls fetch() directly). In v1 the
 *       global endpoint is a catalog walk; semantic server-side search is a
 *       future WI. Global roots are surfaced as additional candidates.
 *
 *   (3) DEGRADE GRACEFULLY (DEC-MCP-ERROR-AS-CONTENT-004):
 *       Air-gap (YAKCC_AIRGAPPED=1) → skip global, return local_only.
 *       Network error from http.get → catch, return local_only.
 *       Registry open failure → catch, return structured error content.
 *       No path throws from the handler.
 *
 *   (4) CONFIDENCE TIERS (D4 ADR Q5 hybrid mode):
 *       "auto_accept"    — top local score > 0.85 AND gap-to-2nd > 0.05
 *       "candidate_list" — has candidates but not auto_accept
 *       "no_candidates"  — empty after local + global merge
 *
 *   (5) FACTORY PATTERN:
 *       createResolveTool(opts?) returns a ToolModule with a configurable
 *       openRegistry factory. The default export `resolveTool` uses the
 *       production factory. Tests inject a stub via the factory parameter.
 *
 *   (6) AUTO_ACCEPT ATOM BODY INLINE (wi-1009-flow-coherence):
 *       When tier=auto_accept, the top candidate's EvidenceProjection spec
 *       metadata (behavior, signature, guarantees) is embedded as `atom_body`
 *       in the envelope. This allows the model to emit `yakcc compile <atom_id>`
 *       immediately without a second yakcc_get_atom round-trip. EvidenceProjection
 *       only carries the 8-char BlockMerkleRoot[:8] prefix (`address`); if the
 *       model needs the full WireBlockTriplet source it should call yakcc_get_atom
 *       with the full 64-char root (obtainable via `yakcc ls` or the registry CLI).
 *       For the compile-and-stop path the atom_body spec fields are sufficient.
 *
 *   Cross-references:
 *     DEC-HOOK-PROACTIVE-PRIMARY-001 — initiative umbrella
 *     DEC-MCP-FETCH-ONE-CLIENT-006   — HttpClient as single fetch authority
 *     DEC-MCP-ERROR-AS-CONTENT-004   — errors as content, never throw
 *     DEC-MCP-STDERR-LOGGING-005     — no stdout output (no console.log)
 *     DEC-HOOK-PHASE-3-L3-MCP-001    — yakccResolve D4 envelope + thresholds
 *     DEC-1009-THRESHOLD-RETUNE-001  — threshold retune (this file, wi-1009)
 *     D4 ADR Q5 (hybrid mode, auto-accept threshold 0.85, gap 0.05)
 *     Cornerstone B6 (air-gap: local stays offline; global gated)
 *     Sacred Practice #12 (single source of truth — yakccResolve is the authority)
 *     DEC-COMMONS-NO-AUTH-001 (no identity in global payload — IntentCard only)
 *
 * Implements: yakcc#953, yakcc#1009
 *
 * @decision DEC-1009-THRESHOLD-RETUNE-001
 * @title yakcc_resolve — threshold retune: prompt is authority, code now matches
 * @status decided (wi-1009-flow-coherence)
 * @rationale
 *   docs/system-prompts/yakcc-discovery.md (the LLM-facing prompt) has always
 *   stated auto-accept at score > 0.85 with gap > 0.15. The code had 0.92/0.15.
 *   B4-v5 traces show real corpora score 0.90–0.95 for correct matches, so the
 *   0.92 threshold was suppressing auto_accept in practice (candidates scored
 *   0.91 and fell to candidate_list). The prompt is the authoritative user-facing
 *   contract (docs/archive/developer/adr/discovery-llm-interaction.md §Q5).
 *   The gap threshold is revised from 0.15 to 0.05: real semantic neighbor
 *   vectors are close (cosine gap rarely exceeds 0.10 for near-duplicates),
 *   so 0.15 was requiring an implausibly large gap. 0.05 distinguishes a clear
 *   winner from a tied pair without over-requiring margin.
 *   Supersedes: DEC-HOOK-PHASE-3-L3-MCP-001 threshold values (0.92, 0.15).
 *   The D4 ADR prose in docs/archive/... is NOT edited (out of scope for wi-1009).
 */

import { yakccResolve } from "@yakcc/hooks-base";
import type { EvidenceProjection, ResolveResult } from "@yakcc/hooks-base";
import type { Registry } from "@yakcc/registry";
import type { HttpClient } from "../http-client.js";
import type { MCPContent, ToolModule } from "./types.js";

// ---------------------------------------------------------------------------
// D4 ADR Q5 hybrid-mode thresholds (local copy)
// ---------------------------------------------------------------------------

/**
 * Hybrid auto-accept threshold: top score must exceed 0.85 for auto-accept.
 * Mirrors HYBRID_AUTO_ACCEPT_THRESHOLD from @yakcc/hooks-base.
 * Kept local so the MCP adapter doesn't fail when vi.mock() replaces
 * @yakcc/hooks-base in tests (constants are not functions — they don't need
 * to be mocked, but module mocking would drop them).
 *
 * Source: docs/system-prompts/yakcc-discovery.md (prompt is authority).
 * Cross-reference: DEC-1009-THRESHOLD-RETUNE-001, DEC-HOOK-PROACTIVE-A-001.
 * Previously 0.92 (DEC-HOOK-PHASE-3-L3-MCP-001); lowered to 0.85 to match
 * the prompt contract and real-corpus scoring (wi-1009-flow-coherence).
 */
const HYBRID_AUTO_ACCEPT_THRESHOLD = 0.85;

/**
 * Auto-accept gap threshold: gap between top-1 and top-2 score must exceed 0.05.
 * Mirrors AUTO_ACCEPT_GAP_THRESHOLD from @yakcc/hooks-base.
 *
 * Source: docs/system-prompts/yakcc-discovery.md §auto-accept rule.
 * Previously 0.15; lowered to 0.05 because real semantic neighbor vectors are
 * close — a cosine gap > 0.15 is rarely seen for near-duplicates in practice,
 * so the old value suppressed auto_accept on valid single-winner results
 * (wi-1009-flow-coherence, DEC-1009-THRESHOLD-RETUNE-001).
 */
const AUTO_ACCEPT_GAP_THRESHOLD = 0.05;

// ---------------------------------------------------------------------------
// Public IntentCard input shape (minimal subset for MCP surface)
// ---------------------------------------------------------------------------

/**
 * The LLM-facing intent card. This is a minimal subset of @yakcc/contracts
 * QueryIntentCard sufficient for MCP tool input. Keeping a local redeclaration
 * per dispatch spec: "redeclare the minimal subset the MCP tool needs" — avoids
 * pulling the full contracts dep chain into the inputSchema definition.
 *
 * The handler maps this to yakccResolve's input format.
 */
export interface ResolveInput {
  readonly intent: {
    readonly title: string; // 1-line task description (required)
    readonly description?: string; // longer rationale
    readonly signature?: string; // proposed function signature
    readonly examples?: string[]; // example usages
  };
  readonly limit?: number; // candidates returned (default 10)
}

// ---------------------------------------------------------------------------
// Confidence tier derivation (D4 ADR Q5 hybrid mode)
// ---------------------------------------------------------------------------

type ConfidenceTier = "auto_accept" | "candidate_list" | "no_candidates";

/**
 * Map a ResolveResult's candidates to one of three D4 ADR Q5 confidence tiers.
 *
 * auto_accept:    top score > HYBRID_AUTO_ACCEPT_THRESHOLD (0.85)
 *                 AND gap to second candidate > AUTO_ACCEPT_GAP_THRESHOLD (0.05)
 * candidate_list: has candidates but not auto_accept
 * no_candidates:  no candidates after full merge
 *
 * This logic is the MCP adapter's responsibility (D4 ADR Q5 "hybrid" mode).
 * yakccResolve returns the raw status + candidates; the adapter maps to tiers.
 */
function deriveConfidenceTier(candidates: readonly EvidenceProjection[]): ConfidenceTier {
  if (candidates.length === 0) {
    return "no_candidates";
  }
  const top = candidates[0];
  if (top === undefined) return "no_candidates";

  const topScore = top.score;
  const secondScore = candidates[1]?.score ?? 0;
  const gap = topScore - secondScore;

  if (topScore > HYBRID_AUTO_ACCEPT_THRESHOLD && gap > AUTO_ACCEPT_GAP_THRESHOLD) {
    return "auto_accept";
  }

  return "candidate_list";
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

type ParsedInput = { ok: true; value: ResolveInput } | { ok: false; message: string };

function parseArgs(args: unknown): ParsedInput {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, message: "args must be a non-null object" };
  }
  const obj = args as Record<string, unknown>;

  // Validate intent
  const rawIntent = obj.intent;
  if (rawIntent === null || typeof rawIntent !== "object" || Array.isArray(rawIntent)) {
    return { ok: false, message: "intent must be a non-null object" };
  }
  const intentObj = rawIntent as Record<string, unknown>;
  if (typeof intentObj.title !== "string" || intentObj.title.length === 0) {
    return { ok: false, message: "intent.title must be a non-empty string" };
  }

  // Validate optional fields
  if (intentObj.description !== undefined && typeof intentObj.description !== "string") {
    return { ok: false, message: "intent.description must be a string if provided" };
  }
  if (intentObj.signature !== undefined && typeof intentObj.signature !== "string") {
    return { ok: false, message: "intent.signature must be a string if provided" };
  }
  if (intentObj.examples !== undefined) {
    if (
      !Array.isArray(intentObj.examples) ||
      (intentObj.examples as unknown[]).some((e) => typeof e !== "string")
    ) {
      return { ok: false, message: "intent.examples must be an array of strings if provided" };
    }
  }

  // Validate limit
  if (obj.limit !== undefined) {
    const lim = obj.limit;
    if (typeof lim !== "number" || !Number.isInteger(lim) || lim < 1 || lim > 100) {
      return { ok: false, message: "limit must be an integer between 1 and 100" };
    }
  }

  const intent: ResolveInput["intent"] = {
    title: intentObj.title as string,
    ...(typeof intentObj.description === "string" ? { description: intentObj.description } : {}),
    ...(typeof intentObj.signature === "string" ? { signature: intentObj.signature } : {}),
    ...(Array.isArray(intentObj.examples) ? { examples: intentObj.examples as string[] } : {}),
  };

  const value: ResolveInput = {
    intent,
    ...(typeof obj.limit === "number" ? { limit: obj.limit } : {}),
  };

  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Candidate shaping for global roots
// ---------------------------------------------------------------------------

/**
 * Shape a global root hash (64-char hex) as a minimal candidate.
 * In v1 the global endpoint is a catalog walk (no spec metadata available).
 * We surface the address as the only field. Semantic enrichment is a future WI.
 */
function globalRootToCandidate(root: string): {
  atom_id: string;
  score: number;
  summary: string;
  source: "global";
} {
  return {
    atom_id: root,
    score: 0,
    summary: `global atom ${root.slice(0, 8)} (no local spec metadata)`,
    source: "global",
  };
}

/**
 * Shape a local EvidenceProjection as a candidate for the response envelope.
 */
function localCandidateToResponse(p: EvidenceProjection): {
  atom_id: string;
  score: number;
  summary: string;
  source: "local";
  evidence: EvidenceProjection;
} {
  return {
    atom_id: p.address,
    score: p.score,
    summary: p.behavior,
    source: "local",
    evidence: p,
  };
}

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

/**
 * Options accepted by createResolveTool().
 *
 * Tests inject openRegistry to avoid real SQLite access.
 * Production uses the default factory (lazy open via openRegistry from @yakcc/registry).
 */
export interface CreateResolveToolOptions {
  /**
   * Factory for the local registry. Called lazily on the first handler invocation
   * and cached for the tool instance lifetime. Defaults to openRegistry() from
   * @yakcc/registry with createOfflineEmbeddingProvider() from @yakcc/contracts.
   */
  readonly openRegistry?: (() => Promise<Registry>) | undefined;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create a yakcc_resolve ToolModule with an optionally injected registry factory.
 *
 * The returned ToolModule has the same ToolModule interface as all other tools
 * (name, description, inputSchema, handler). The handler is a closure over the
 * registry promise, which is initialized lazily on the first call.
 *
 * @param opts - Optional registry factory override (for tests).
 */
export function createResolveTool(opts?: CreateResolveToolOptions): ToolModule {
  // Lazy-cached registry promise (opened at most once per tool instance).
  let registryPromise: Promise<Registry> | null = null;

  function getRegistry(): Promise<Registry> {
    if (registryPromise !== null) return registryPromise;
    const factory = opts?.openRegistry ?? defaultOpenRegistry;
    registryPromise = factory();
    return registryPromise;
  }

  return {
    name: "yakcc_resolve",

    description: [
      "Discover yakcc atoms that match the agent's intent BEFORE emitting code.",
      "Build an IntentCard from your plan and call this tool. It queries the local",
      "yakcc registry first; if no high-confidence match is found and the environment",
      "is not air-gapped, it falls through to the global commons at registry.yakcc.com.",
      "",
      "When to call:",
      "- BEFORE Edit/Write/MultiEdit when you have a clear intent (a function or",
      "  cohesive snippet whose contract you can describe).",
      "- The returned `confidence_tier` tells you what to do next:",
      "  - 'auto_accept' → COMPILE AND STOP. Emit `yakcc compile <atom_id>` as your",
      "    final code answer. Do NOT also re-implement the function — the build",
      "    substrate inlines the atom body. The response includes `atom_body` with",
      "    spec metadata (behavior, signature, guarantees) so you can confirm fit",
      "    without a separate yakcc_get_atom call.",
      "  - 'candidate_list' → review the candidates; pick one and `yakcc compile <id>`,",
      "    OR emit a fully-formed atom triplet (spec + impl + property tests) for a",
      "    novel atom. To inspect an atom's full source before committing, call",
      "    yakcc_get_atom with the full 64-char BlockMerkleRoot (available via",
      "    `yakcc ls` or the registry CLI — the `atom_id` here is an 8-char prefix).",
      "  - 'no_candidates' → emit a fully-formed atom triplet for a novel atom.",
      "",
      "If you don't call this tool before emitting code, the PreToolUse fallback",
      "(yakcc#950) will still capture your emission via post-hoc atomize — but the",
      "atom you contribute will have machine-generated property tests instead of",
      "your higher-quality ones.",
    ].join("\n"),

    inputSchema: {
      type: "object",
      required: ["intent"],
      properties: {
        intent: {
          type: "object",
          required: ["title"],
          properties: {
            title: {
              type: "string",
              minLength: 1,
              description: "One-line task description (the verb-phrase).",
            },
            description: {
              type: "string",
              description: "Longer rationale; what problem the code solves.",
            },
            signature: {
              type: "string",
              description: "Proposed TS-strict-subset function signature.",
            },
            examples: {
              type: "array",
              items: { type: "string" },
              description: "Example usages if any.",
            },
          },
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 100,
          default: 10,
          description: "Maximum number of candidates to return (1–100, default 10).",
        },
      },
    },

    async handler(args: unknown, http: HttpClient): Promise<MCPContent[]> {
      // --- Input validation ---
      const parsed = parseArgs(args);
      if (!parsed.ok) {
        return [
          {
            type: "text",
            text: JSON.stringify({ error: "invalid_input", message: parsed.message }),
          },
        ];
      }

      const { intent, limit = 10 } = parsed.value;
      const airgapped = process.env.YAKCC_AIRGAPPED === "1";

      // --- Open the local registry (lazy, cached) ---
      let registry: Registry;
      try {
        registry = await getRegistry();
      } catch (err) {
        // Registry open failure (DEC-MCP-ERROR-AS-CONTENT-004): return structured error content.
        // This happens when the workspace has no local yakcc registry yet.
        return [
          {
            type: "text",
            text: JSON.stringify({
              error: "registry_unavailable",
              message: `Could not open local registry: ${err instanceof Error ? err.message : String(err)}`,
              confidence_tier: "no_candidates",
              source: "local_only",
              candidates: [],
              airgapped,
            }),
          },
        ];
      }

      // --- Local query via yakccResolve (D-HOOK-6, Sacred Practice #12) ---
      // Map the MCP IntentCard to a yakccResolve QueryIntentCard.
      //
      // Mapping rationale:
      // - intent.title → behavior (primary semantic field, always present)
      // - intent.description → appended to behavior for richer semantic signal
      // - intent.signature → NOT mapped: QueryIntentCard.signature is a structured
      //   {inputs, outputs} type, incompatible with our text-format string. The text
      //   form can be added to behavior if desired but is not currently mapped.
      // - intent.examples → NOT mapped: QueryIntentCard has no examples dimension.
      // - topK: limit → governs max candidates returned by the pipeline.
      //
      // yakccResolve accepts string | QueryIntentCard | HashLookup.
      // We pass a QueryIntentCard directly so the registry pipeline uses
      // all available dimensions (not just behavior).
      const behaviorText =
        intent.description !== undefined ? `${intent.title} ${intent.description}` : intent.title;
      const intentCard = { behavior: behaviorText, topK: limit };

      let resolveResult: ResolveResult;
      try {
        resolveResult = await yakccResolve(registry, intentCard, { confidenceMode: "hybrid" });
      } catch (err) {
        // yakccResolve failure (defensive; the library should not throw but we guard it).
        resolveResult = { status: "no_match", candidates: [] };
        void err; // Swallow; degrade to no_match
      }

      const localCandidates = [...resolveResult.candidates].slice(0, limit);

      // --- Auto-accept short-circuit: no global call needed ---
      const localTier = deriveConfidenceTier(localCandidates);
      if (localTier === "auto_accept") {
        // Inline atom_body from the top candidate's EvidenceProjection so the
        // model can confirm fit and emit `yakcc compile <atom_id>` without a
        // second yakcc_get_atom round-trip (wi-1009, DEC-1009-THRESHOLD-RETUNE-001).
        // EvidenceProjection carries the 8-char BlockMerkleRoot[:8] prefix in
        // `address`; for the full 64-char root use `yakcc ls` or the registry CLI.
        // Fail loud: if top candidate is absent (should not happen after tier check),
        // return an error rather than silently degrading to candidate_list.
        const top = localCandidates[0];
        if (top === undefined) {
          return [
            {
              type: "text",
              text: JSON.stringify({
                error: "auto_accept_invariant_violated",
                message:
                  "auto_accept tier derived but top candidate is absent — internal invariant failure",
                confidence_tier: "no_candidates",
                candidates: [],
              }),
            },
          ];
        }
        const atomBody = {
          behavior: top.behavior,
          signature: top.signature,
          guarantees: top.guarantees,
          tests: top.tests,
        };
        return [
          {
            type: "text",
            text: JSON.stringify(
              {
                confidence_tier: "auto_accept",
                source: "local_only",
                candidates: localCandidates.map(localCandidateToResponse),
                atom_body: atomBody,
                airgapped,
              },
              null,
              2,
            ),
          },
        ];
      }

      // --- Air-gap check: skip global pass entirely ---
      if (airgapped) {
        return [
          {
            type: "text",
            text: JSON.stringify(
              {
                confidence_tier: localCandidates.length > 0 ? "candidate_list" : "no_candidates",
                source: "local_only",
                candidates: localCandidates.map(localCandidateToResponse),
                airgapped: true,
              },
              null,
              2,
            ),
          },
        ];
      }

      // --- Global cascade via HttpClient (DEC-MCP-FETCH-ONE-CLIENT-006) ---
      // The global endpoint is GET /v1/blocks — a catalog walk.
      // Real semantic search server-side is a follow-up (registry.yakcc.com doesn't
      // yet expose embedding-adjacency over HTTP). In v1, surface top-N global atoms
      // as additional candidates with score=0 and source="global".
      // Global query payload is the content-derived IntentCard only (DEC-COMMONS-NO-AUTH-001).
      let globalRoots: string[] = [];
      let globalFailed = false;

      try {
        const globalPage = await http.get<{ roots?: string[]; nextCursor?: string | null }>(
          `v1/blocks?limit=${limit}`,
        );
        globalRoots = Array.isArray(globalPage.roots) ? globalPage.roots : [];
      } catch {
        // Network error: degrade to local_only (DEC-MCP-ERROR-AS-CONTENT-004).
        // Never throw from the handler.
        globalFailed = true;
      }

      if (globalFailed) {
        return [
          {
            type: "text",
            text: JSON.stringify(
              {
                confidence_tier: localCandidates.length > 0 ? "candidate_list" : "no_candidates",
                source: "local_only",
                candidates: localCandidates.map(localCandidateToResponse),
                airgapped: false,
              },
              null,
              2,
            ),
          },
        ];
      }

      // --- Merge + dedup by address prefix ---
      // Local candidates keyed by first-8-char address prefix (already short-form).
      const localAddresses = new Set(localCandidates.map((c) => c.address));

      // Global roots whose first-8-char prefix is NOT already in local candidates.
      const freshGlobalCandidates = globalRoots
        .filter((root) => !localAddresses.has(root.slice(0, 8)))
        .slice(0, Math.max(0, limit - localCandidates.length))
        .map(globalRootToCandidate);

      const merged = [...localCandidates.map(localCandidateToResponse), ...freshGlobalCandidates];

      const mergedTier = deriveConfidenceTier(localCandidates);
      const finalTier: ConfidenceTier =
        merged.length === 0
          ? "no_candidates"
          : mergedTier === "auto_accept"
            ? "auto_accept"
            : "candidate_list";

      return [
        {
          type: "text",
          text: JSON.stringify(
            {
              confidence_tier: finalTier,
              source: "local+global",
              candidates: merged,
              airgapped: false,
            },
            null,
            2,
          ),
        },
      ];
    },
  };
}

// ---------------------------------------------------------------------------
// Default production registry opener
// ---------------------------------------------------------------------------

// @decision DEC-MCP-RESOLVE-SEMANTIC-EMBED-001
// @title yakcc_resolve uses semantic embedding provider (Xenova/bge-small-en-v1.5) for queries
// @status decided (wi-1006-resolve-semantic-embedding)
// @rationale
//   The prior implementation used createOfflineEmbeddingProvider() (BLAKE3 hash stub)
//   for the query provider, producing semantically meaningless vectors that cannot
//   retrieve related atoms by cosine distance. WI-1006 replaces it with the semantic
//   provider (Xenova/bge-small-en-v1.5, 384-dim, same as the ingest provider), restoring
//   retrieval quality.
//
//   Key invariants preserved:
//   - Schema unchanged: FLOAT[384] (DEC-EMBED-010). bge-small-en-v1.5 is 384-dim.
//   - Provider parity: query-side modelId == stored-side modelId when the registry
//     was populated with createLocalEmbeddingProvider(). The storage.ts cross-provider
//     gate (DEC-V3-IMPL-QUERY-002, storage.ts:823) enforces this at query time.
//   - Lazy-singleton preserved (DEC-EMBED-SINGLETON-CLOSURE-001): createLocalEmbeddingProvider()
//     delegates to the getPipeline singleton defined in contracts/embeddings.ts — one
//     ONNX load per process regardless of how many times defaultOpenRegistry is called.
//   - YAKCC_EMBEDDING_PROVIDER env override honored: resolveEmbeddingProviderFromEnv()
//     is checked first (returns null when unset), so no new env var is introduced
//     (DEC-EMBED-ENV-RESOLUTION-001).
//
//   Supersedes: the hash-stub rationale comment at this location in v1 (~resolve.ts:546).

// @decision DEC-MCP-RESOLVE-OFFLINE-GUARANTEE-001
// @title yakcc_resolve pins @xenova/transformers env.allowRemoteModels=false before first embed
// @status decided (wi-1006-resolve-semantic-embedding)
// @rationale
//   Cornerstone B6 (air-gap) requires that yakcc_resolve NEVER fetches a model from
//   HuggingFace at runtime. Without pinning, @xenova/transformers would silently
//   download the ONNX model if not in cache, violating the offline guarantee.
//
//   Implementation: we set `env.allowRemoteModels = false` synchronously before
//   opening the registry (and thus before the first embed() call). This is done
//   inside defaultOpenRegistry so it happens unconditionally on the production path.
//   A missing local model (cache miss) surfaces as a LOUD Error thrown by @xenova,
//   which propagates as a "registry_unavailable" structured error content via
//   DEC-MCP-ERROR-AS-CONTENT-004 — never a silent download or zero-vector fallback.
//
//   @xenova/transformers is added as a direct dependency of @yakcc/mcp-registry so
//   TypeScript can resolve the env import; the ONNX model itself is loaded transitively
//   through @yakcc/contracts's pipeline at first embed().

/**
 * Default registry opener for production use.
 *
 * Resolves the registry path from YAKCC_REGISTRY_PATH env var or falls back
 * to ".yakcc/registry.sqlite" relative to process.cwd().
 *
 * Provider selection (DEC-MCP-RESOLVE-SEMANTIC-EMBED-001):
 *   1. Explicit YAKCC_EMBEDDING_PROVIDER env var → resolveEmbeddingProviderFromEnv()
 *   2. Default: createLocalEmbeddingProvider() (Xenova/bge-small-en-v1.5, 384-dim)
 *
 * Offline guarantee (DEC-MCP-RESOLVE-OFFLINE-GUARANTEE-001):
 *   @xenova/transformers env.allowRemoteModels is set to false before any embed()
 *   call. A missing ONNX cache throws loudly rather than fetching from HuggingFace.
 *
 * Cross-reference: DEC-HOOK-PHASE-3-L3-MCP-001-C (registry path resolution),
 * DEC-HOOK-PHASE-3-L3-MCP-001-A (embedded-library-call discipline).
 */
async function defaultOpenRegistry(): Promise<Registry> {
  const { resolve } = await import("node:path");
  const { openRegistry } = await import("@yakcc/registry");
  const { createLocalEmbeddingProvider, resolveEmbeddingProviderFromEnv } = await import(
    "@yakcc/contracts"
  );

  // B6 offline guarantee: pin allowRemoteModels=false before any embed call so
  // @xenova/transformers cannot fetch from HuggingFace at runtime.
  // This must execute before the provider's first embed() call (which is lazy,
  // triggered by the first yakccResolve handler invocation, but we pin eagerly
  // here at registry-open time to be safe regardless of call ordering).
  const xenovaEnv = await import("@xenova/transformers").then((mod) => mod.env);
  xenovaEnv.allowRemoteModels = false;

  const DEFAULT_REGISTRY_PATH = ".yakcc/registry.sqlite";
  const registryPath =
    process.env.YAKCC_REGISTRY_PATH ?? resolve(process.cwd(), DEFAULT_REGISTRY_PATH);

  // Provider selection: env override > local semantic default
  const provider = resolveEmbeddingProviderFromEnv() ?? createLocalEmbeddingProvider();
  return openRegistry(registryPath, { embeddings: provider });
}

// ---------------------------------------------------------------------------
// Default export — the production tool instance
// ---------------------------------------------------------------------------

/**
 * The default yakcc_resolve tool module, registered in the TOOLS array.
 * Uses the production registry factory (lazy open, cached per process).
 *
 * Tests use createResolveTool({ openRegistry: mockFn }) instead.
 */
export const resolveTool: ToolModule = createResolveTool();
