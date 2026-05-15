// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/harness/mcp-server.mjs
//
// @decision DEC-V0-B4-MCP-001
// @title MCP atom-lookup server: stdio JSON-RPC backend against the real yakcc registry
// @status accepted
// @rationale
//   This server implements the Model Context Protocol (MCP) over stdio using
//   JSON-RPC 2.0 with Content-Length framing. It exposes a single tool:
//   `atom-lookup` that queries the real yakcc registry.
//
//   BACKEND CHOICE -- real registry, not mocked:
//   The server opens the registry from the workspace default path
//   (.yakcc/registry.sqlite) or YAKCC_REGISTRY_PATH env var. This is the same
//   registry used by the production hook layer. Using the real registry enforces
//   the never-synthetic cornerstone (DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001).
//
//   REGISTRY QUERY SHAPE:
//   Tool input: { intent: string, atom_grain?: 'fine'|'medium'|'coarse',
//                 confidence_threshold?: number,
//                 substitution_aggressiveness?: 'conservative'|'default'|'aggressive' }
//   Tool output: { atoms: Array<{ atom_id, atom_signature, match_confidence, atom_body_sha256 }> }
//
//   EMPTY RESULT HANDLING:
//   When the registry returns no candidates above threshold, the tool returns
//   { atoms: [] } explicitly -- NOT a tool_use cycle with no text. The harness
//   handles empty results by proceeding without substitution. This prevents the
//   phantom-tool failure that PR #457 was working around (DEC-BENCH-B4-HARNESS-002).
//
//   SUBSTITUTION AGGRESSIVENESS (DEC-V0-B4-SLICE2-MATRIX-002):
//   Three aggressiveness modes control threshold:
//   - 'conservative': confidence_threshold = 0.95 (high-confidence only)
//   - 'default': confidence_threshold = param or 0.7
//   - 'aggressive': confidence_threshold = 0.0 (return all candidates)
//
//   TRANSPORT CHOICE -- stdio over HTTP:
//   stdio avoids port management in CI and matches Claude Code's native MCP
//   pattern. The harness spawns this server as a subprocess and communicates
//   via stdin/stdout with Content-Length framing.
//
//   @decision DEC-V0-B4-SLICE2-CONSOLIDATION-001
//   @title MCP server consolidates harness integration decisions
//   @status accepted
//   @rationale
//     Slice 2 Wave 1 consolidation: this server replaces the phantom yakccResolve
//     tool cut from Slice 1 (PR #457). The real implementation queries the seeded
//     registry for candidates, enabling substitution_aggressiveness as a real
//     sweep dimension. The server starts fast (< 1s) because it opens SQLite with
//     no migrations (registry already exists) and the offline embedding provider
//     is deterministic (no network calls required).
//
//   @decision DEC-V0-B4-EMBED-REAL-001
//   @title Real semantic embedding provider for B4 MCP runtime path
//   @status accepted
//   @rationale
//     Provider: Xenova/bge-small-en-v1.5 via @xenova/transformers (createLocalEmbeddingProvider).
//     Dimension: 384-dim Float32Array, L2-normalized, cosine-distance compatible with vec0 index.
//     License: MIT (confirmed, DEC-EMBED-010).
//     Model size: ~25MB quantized ONNX; downloads from HuggingFace on first call, then cached
//       at ~/.cache/huggingface/ (or $HF_HOME). Subsequent calls are fully local.
//     Cache strategy: lazy singleton via closure (DEC-EMBED-SINGLETON-CLOSURE-001). The model
//       loads on first ensureRegistry() call and is reused for the lifetime of the MCP server
//       process. Since the server is a long-running subprocess (spawned by the harness), the
//       per-run model-load cost (~1-2s cold, ~0s warm) is paid once per bench cell, not per query.
//     Network behavior: outbound HuggingFace download on first cold boot ONLY. Steady-state
//       (warm cache) is network-free. Air-gap note: see DEC-V0-B4-EMBED-SWAP-001.
//     Why this model: Per DEC-EMBED-MODEL-DEFAULT-002, bge-small-en-v1.5 benchmarked at
//       M2=70%, M3=100%, M4=0.823 against the yakcc seed corpus — highest semantic retrieval
//       quality among tested 384-dim models. It is the production default for all registry paths.
//
// Cross-reference:
//   bench/B4-tokens/harness/run.mjs DEC-V0-B4-HOOK-WIRING-001 (hook arm wiring)
//   packages/seeds/src/blocks/timer-handle/ DEC-SEED-TIMER-001 (timer atom closes #454)
//   DEC-BENCH-B4-HARNESS-002 (Slice 1 phantom tool removal decision)
//   GitHub issues #188, #460, #454
//
// Usage:
//   node bench/B4-tokens/harness/mcp-server.mjs
//   YAKCC_REGISTRY_PATH=custom.sqlite node bench/B4-tokens/harness/mcp-server.mjs
//   YAKCC_DEBUG=1 node bench/B4-tokens/harness/mcp-server.mjs  # verbose logging

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B4_ROOT = resolve(__dirname, "..");

// REPO_ROOT: the main git repository root.
// Set via YAKCC_REPO_ROOT env from run.mjs (which resolves it correctly for worktrees).
// Fallback: walk up from __dirname looking for a .git DIRECTORY (not a file, which is
// what worktrees have). This distinguishes the main repo from worktree roots.
function findRepoRootSync(startDir) {
  let current = startDir;
  for (let i = 0; i < 12; i++) {
    const gitPath = join(current, ".git");
    if (existsSync(gitPath)) {
      try {
        if (statSync(gitPath).isDirectory()) {
          return current;
        }
      } catch (_) {}
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return resolve(startDir, "../../..");
}

const REPO_ROOT = process.env["YAKCC_REPO_ROOT"] ?? findRepoRootSync(__dirname);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEBUG = process.env["YAKCC_DEBUG"] === "1";

/** Registry path: YAKCC_REGISTRY_PATH env var or workspace default. */
const REGISTRY_PATH = process.env["YAKCC_REGISTRY_PATH"]
  ?? resolve(REPO_ROOT, ".yakcc", "registry.sqlite");

/** Default top-K candidates to return per query. */
const DEFAULT_TOP_K = 5;

/** Tool name as declared in Anthropic Messages API tools array. */
const TOOL_NAME = "atom-lookup";

// ---------------------------------------------------------------------------
// Logging (stderr only -- stdout is reserved for MCP JSON-RPC)
// ---------------------------------------------------------------------------

function log(msg) {
  if (DEBUG) process.stderr.write(`[MCP-SERVER] ${msg}\n`);
}

function logError(msg) {
  process.stderr.write(`[MCP-SERVER:ERROR] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Registry setup
// ---------------------------------------------------------------------------

let registry = null;

// @decision DEC-V0-B4-EMBED-SWAP-001
// @title MCP server swaps offline BLAKE3 stub for real semantic embedding provider
// @status accepted
// @rationale
//   Investigation #188 (comment 4444935370, PR #482) diagnosed that every B4 hooked-arm
//   tool_use cycle returned {atoms:[]} because:
//     1. Seed atoms in the registry were stored with LOCAL semantic embeddings
//        (createLocalEmbeddingProvider → Xenova/bge-small-en-v1.5, 384-dim).
//     2. Query text was being embedded with the BLAKE3 offline stub
//        (createOfflineEmbeddingProvider), which produces cryptographic-hash vectors
//        with no semantic structure whatsoever.
//     3. Cosine similarity between a BLAKE3 vector and a transformer vector is
//        effectively random, always landing below the 0.7 default threshold.
//   Result: 0% substitution rate across all B4 runs — the +8.8% to +27.0% overhead
//   measured was pure tool_use conversation overhead with zero atom reuse.
//
//   FIX: Use createLocalEmbeddingProvider() (Xenova/bge-small-en-v1.5) for the MCP
//   runtime path. Query vectors are now produced by the same model that embedded the
//   seed atoms, making cosine similarity semantically meaningful.
//
//   STUB PRESERVED: createOfflineEmbeddingProvider() remains exported from
//   @yakcc/contracts for deterministic unit tests and bootstrap (air-gap) paths.
//   The stub is intentionally NOT used here — only the MCP runtime path changes.
//
//   AIR-GAP NOTE (B6 compatibility): createLocalEmbeddingProvider() downloads the
//   Xenova/bge-small-en-v1.5 model (~25MB) from HuggingFace on first use, then
//   caches it locally. Air-gap deployments (B6) must pre-warm the model cache before
//   going offline. The offline stub cannot replace this for semantic search — its
//   vectors are incompatible with the seed atom embeddings in the registry.
//   B6 workaround: YAKCC_MCP_OFFLINE=1 env var (future WI) to skip semantic search
//   and fall back to structural matching. Track as a sub-followup on issue #480.
//
//   Cross-references:
//     Issue #480 (this fix), #188 (investigation), PR #482 (instrumentation)
//     DEC-V0-B4-EMBED-REAL-001 (provider choice)
//     DEC-EMBED-OFFLINE-PROVIDER-001 (why stub exists)

async function ensureRegistry() {
  if (registry !== null) return registry;

  if (!existsSync(REGISTRY_PATH)) {
    throw new Error(
      `Registry not found at: ${REGISTRY_PATH}\n` +
      "Run 'yakcc bootstrap' to initialize the registry, or set YAKCC_REGISTRY_PATH."
    );
  }

  // Lazy import workspace packages via the repo's dist outputs.
  const { openRegistry } = await import(
    new URL(`file://${resolve(REPO_ROOT, "packages/registry/dist/index.js")}`).href
  );
  // DEC-V0-B4-EMBED-SWAP-001: use the local semantic provider (bge-small-en-v1.5),
  // NOT createOfflineEmbeddingProvider(). The offline BLAKE3 stub produces vectors
  // that are incompatible with the seed atom embeddings stored in the registry.
  const { createLocalEmbeddingProvider } = await import(
    new URL(`file://${resolve(REPO_ROOT, "packages/contracts/dist/index.js")}`).href
  );

  log(`Opening registry at: ${REGISTRY_PATH}`);
  log("Loading local embedding provider (Xenova/bge-small-en-v1.5) for semantic search...");
  registry = await openRegistry(REGISTRY_PATH, {
    embeddings: createLocalEmbeddingProvider(),
  });
  log("Registry opened successfully.");
  return registry;
}

// ---------------------------------------------------------------------------
// Atom lookup tool implementation
// ---------------------------------------------------------------------------

/**
 * Execute an atom-lookup query against the real yakcc registry.
 *
 * Returns { atoms: Array<{ atom_id, atom_signature, match_confidence, atom_body_sha256 }> }
 * or { atoms: [] } when no candidates meet the threshold.
 */
async function atomLookup(input) {
  const {
    intent,
    atom_grain = "medium",
    confidence_threshold,
    substitution_aggressiveness = "default",
  } = input;

  if (typeof intent !== "string" || intent.trim() === "") {
    throw new Error("atom-lookup: 'intent' must be a non-empty string");
  }

  // Resolve effective confidence threshold based on substitution aggressiveness.
  // Per DEC-V0-B4-SLICE2-MATRIX-002:
  let effectiveThreshold;
  if (substitution_aggressiveness === "conservative") {
    effectiveThreshold = 0.95;
  } else if (substitution_aggressiveness === "aggressive") {
    effectiveThreshold = 0.0;
  } else {
    // "default" mode: use caller-provided threshold or 0.7
    effectiveThreshold = confidence_threshold ?? 0.7;
  }

  log(`atom-lookup: intent="${intent.slice(0, 60)}..." threshold=${effectiveThreshold}`);

  const reg = await ensureRegistry();

  // Build query card from intent plus optional rich ContractSpec fields.
  // Passing inputs/outputs/guarantees/errorConditions/nonFunctional narrows the
  // candidate pool to atoms whose stored ContractSpec aligns with what the caller
  // is implementing. These are all optional — the intent-only path is unchanged.
  // (Refs #523, #444, #535 — DEC-V0-B4-RICH-QUERY-001)
  const queryCard = {
    behavior: intent,
    topK: DEFAULT_TOP_K,
  };
  if (Array.isArray(input.inputs) && input.inputs.length > 0) {
    queryCard.signature = { ...(queryCard.signature ?? {}), inputs: input.inputs };
  }
  if (Array.isArray(input.outputs) && input.outputs.length > 0) {
    queryCard.signature = { ...(queryCard.signature ?? {}), outputs: input.outputs };
  }
  if (Array.isArray(input.guarantees) && input.guarantees.length > 0) {
    // QueryIntentCard.guarantees is typed as readonly string[]. Convert object-form
    // {description: string} items (as the LLM may send) to plain strings.
    // The typeof guard handles callers that pass strings directly (backwards compat).
    queryCard.guarantees = input.guarantees.map((g) => (typeof g === "string" ? g : g.description));
  }
  if (Array.isArray(input.errorConditions) && input.errorConditions.length > 0) {
    // Same string-extraction as guarantees — QueryIntentCard.errorConditions is string[].
    queryCard.errorConditions = input.errorConditions.map((ec) => (typeof ec === "string" ? ec : ec.description));
  }
  if (input.nonFunctional && typeof input.nonFunctional === "object") {
    queryCard.nonFunctional = input.nonFunctional;
  }

  // Fallback to the IntentQuery shape expected by findCandidatesByIntent when the
  // registry does not yet expose findCandidatesByQuery (backwards compat with older
  // registry builds that only have the intent-only path).
  const intentQuery = {
    behavior: intent,
    inputs: queryCard.signature?.inputs ?? [],
    outputs: queryCard.signature?.outputs ?? [],
  };

  const topK = DEFAULT_TOP_K;
  let candidates;
  try {
    // Prefer findCandidatesByQuery (rich path) when available; fall back to
    // findCandidatesByIntent (intent-only) for older registry builds.
    //
    // findCandidatesByQuery returns { candidates: [...], nearMisses: [...] };
    // findCandidatesByIntent returns a raw array. Both item shapes include
    // { block, cosineDistance } which the downstream confidence mapping uses.
    if (typeof reg.findCandidatesByQuery === "function") {
      const result = await reg.findCandidatesByQuery(queryCard);
      candidates = result.candidates ?? [];
    } else {
      candidates = await reg.findCandidatesByIntent(intentQuery, { k: topK * 5 });
    }
  } catch (err) {
    logError(`findCandidates failed: ${err.message}`);
    return { atoms: [] };
  }

  if (!candidates || candidates.length === 0) {
    log("atom-lookup: no candidates found in registry");
    return { atoms: [] };
  }

  // Convert L2 distance to match_confidence using the correct formula per
  // DEC-V3-DISCOVERY-CALIBRATION-FIX-002 (#500).
  //
  // sqlite-vec vec0 returns L2 Euclidean distance by default (NOT cosine distance).
  // For unit-normalized vectors, cosine_distance = L2² / 2, so the correct mapping
  // from L2 distance d ∈ [0, 2] to a [0, 1] confidence score is:
  //   match_confidence = 1 - d²/4 = (1 + cos(θ)) / 2
  //
  // The retracted formula (1 - d/2) treated d as cosine distance, mapping an LRU
  // intent at L2=0.662 to 0.669 (below the 0.7 threshold). The correct formula
  // maps it to 0.890 (above threshold). See packages/registry/src/discovery-eval-helpers.ts
  // cosineDistanceToCombinedScore() for the canonical implementation.
  const withConfidence = candidates
    .map((c) => ({
      block: c.block,
      match_confidence: Math.max(0, Math.min(1, 1 - (c.cosineDistance * c.cosineDistance) / 4)),
    }))
    .filter((c) => c.match_confidence >= effectiveThreshold)
    .slice(0, topK);

  if (withConfidence.length === 0) {
    log(`atom-lookup: ${candidates.length} candidates found but all below threshold ${effectiveThreshold}`);
    return { atoms: [] };
  }

  log(`atom-lookup: returning ${withConfidence.length} candidates above threshold ${effectiveThreshold}`);

  // Build response atoms array.
  const atoms = withConfidence.map((c) => {
    const block = c.block;
    // atom_id: blockMerkleRoot (content-address)
    const atom_id = block.blockMerkleRoot;
    // atom_signature: extract exported function/class/const name from implSource
    const specName = block.implSource.match(/export (?:function|class|const) (\w+)/)?.[1] ?? "unknown";
    const atom_signature = `${specName}(...)`;
    // atom_body_sha256: SHA-256 of implSource for provenance traceability
    const atom_body_sha256 = createHash("sha256").update(block.implSource).digest("hex");

    return {
      atom_id,
      atom_signature,
      match_confidence: Math.round(c.match_confidence * 1000) / 1000,
      atom_body_sha256,
    };
  });

  return { atoms };
}

// ---------------------------------------------------------------------------
// MCP protocol: JSON-RPC 2.0 over stdio with Content-Length framing
// ---------------------------------------------------------------------------

/** Write a JSON-RPC 2.0 response to stdout. */
function sendResponse(id, result) {
  const payload = JSON.stringify({ jsonrpc: "2.0", id, result });
  const header = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n`;
  process.stdout.write(header + payload);
  log(`response id=${id} bytes=${Buffer.byteLength(payload)}`);
}

/** Write a JSON-RPC 2.0 error response to stdout. */
function sendError(id, code, message, data) {
  const error = { code, message, ...(data !== undefined ? { data } : {}) };
  const payload = JSON.stringify({ jsonrpc: "2.0", id, error });
  const header = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n`;
  process.stdout.write(header + payload);
  logError(`error id=${id} code=${code} msg=${message}`);
}

// ---------------------------------------------------------------------------
// MCP tool definition (Anthropic tool schema shape)
// ---------------------------------------------------------------------------

const ATOM_LOOKUP_TOOL = {
  name: TOOL_NAME,
  description:
    "Query the yakcc atom registry for candidate implementations matching an intent. " +
    "Returns atoms with their content-address (atom_id), signature, confidence score, and body hash. " +
    "Returns { atoms: [] } when no candidates match -- generate the implementation directly.",
  inputSchema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        description: "Behavioral description of the desired atom (e.g. 'debounce a function call with cancel handle').",
      },
      atom_grain: {
        type: "string",
        enum: ["fine", "medium", "coarse"],
        description: "Desired granularity: 'fine'=leaf primitive, 'medium'=utility, 'coarse'=full feature.",
        default: "medium",
      },
      confidence_threshold: {
        type: "number",
        description: "Minimum match_confidence (0.0-1.0). Default: 0.7 in default aggressiveness mode.",
        minimum: 0,
        maximum: 1,
      },
      substitution_aggressiveness: {
        type: "string",
        enum: ["conservative", "default", "aggressive"],
        description: "Threshold mode: 'conservative'=0.95, 'default'=0.7, 'aggressive'=all.",
        default: "default",
      },
      inputs: {
        type: "array",
        description: "Optional: function parameters as [{name, type}, ...]. Pass when you know the signature you're implementing — produces tighter atom matches.",
        items: { type: "object", properties: { name: { type: "string" }, type: { type: "string" } }, required: ["name", "type"] },
      },
      outputs: {
        type: "array",
        description: "Optional: function return values as [{name, type}, ...]. Same purpose as inputs.",
        items: { type: "object", properties: { name: { type: "string" }, type: { type: "string" } }, required: ["name", "type"] },
      },
      guarantees: {
        type: "array",
        description: "Optional: invariants the implementation must satisfy, as [{description}, ...] (e.g. 'pure', 'idempotent', 'O(n) time').",
        items: { type: "object", properties: { description: { type: "string" } }, required: ["description"] },
      },
      errorConditions: {
        type: "array",
        description: "Optional: error conditions the implementation must handle, as [{description}, ...] (e.g. 'RangeError on negative input').",
        items: { type: "object", properties: { description: { type: "string" } }, required: ["description"] },
      },
      nonFunctional: {
        type: "object",
        description: "Optional: non-functional properties (e.g. {purity: 'pure', timeComplexity: 'O(n)', spaceComplexity: 'O(1)'}).",
        properties: {
          purity: { type: "string" },
          timeComplexity: { type: "string" },
          spaceComplexity: { type: "string" },
          threadSafety: { type: "string" },
        },
      },
    },
    required: ["intent"],
  },
};

// ---------------------------------------------------------------------------
// MCP request dispatcher
// ---------------------------------------------------------------------------

async function handleRequest(request) {
  const { id, method, params } = request;
  log(`request id=${id} method=${method}`);

  try {
    switch (method) {
      case "initialize": {
        // MCP protocol handshake
        sendResponse(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "yakcc-atom-lookup", version: "0.1.0" },
        });
        break;
      }

      case "initialized": {
        // Notification (no id) -- no response needed
        log("received initialized notification");
        break;
      }

      case "tools/list": {
        sendResponse(id, { tools: [ATOM_LOOKUP_TOOL] });
        break;
      }

      case "tools/call": {
        const toolName = params?.name;
        const toolInput = params?.arguments ?? {};

        if (toolName !== TOOL_NAME) {
          sendError(id, -32602, `Unknown tool: ${toolName}`);
          break;
        }

        const result = await atomLookup(toolInput);
        sendResponse(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: false,
        });
        break;
      }

      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    logError(`Unhandled error in ${method}: ${err.message}`);
    sendError(id ?? null, -32603, "Internal error", err.message);
  }
}

// ---------------------------------------------------------------------------
// stdio JSON-RPC reader: Content-Length framed messages
// ---------------------------------------------------------------------------

let buffer = Buffer.alloc(0);

function processBuffer() {
  while (true) {
    // Look for the header/body separator: \r\n\r\n
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const headerText = buffer.slice(0, headerEnd).toString("utf8");
    const match = headerText.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      logError("Missing Content-Length header -- skipping malformed message");
      buffer = buffer.slice(headerEnd + 4);
      break;
    }
    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;

    if (buffer.length < bodyStart + contentLength) break;

    const body = buffer.slice(bodyStart, bodyStart + contentLength).toString("utf8");
    buffer = buffer.slice(bodyStart + contentLength);

    let request;
    try {
      request = JSON.parse(body);
    } catch (err) {
      logError(`JSON parse error: ${err.message}`);
      sendError(null, -32700, "Parse error");
      continue;
    }

    handleRequest(request).catch((err) => {
      logError(`Async handler failed: ${err.message}`);
    });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});

process.stdin.on("end", () => {
  log("stdin closed -- shutting down");
  if (registry !== null) {
    registry.close().catch(() => {});
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("SIGTERM received -- shutting down");
  if (registry !== null) {
    registry.close().catch(() => {});
  }
  process.exit(0);
});

log(`MCP atom-lookup server starting. Registry: ${REGISTRY_PATH}`);
