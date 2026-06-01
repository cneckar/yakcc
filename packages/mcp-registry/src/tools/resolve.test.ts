// @mock-exempt: yakccResolve wraps SQLite (local DB boundary); openRegistry opens SQLite; createOfflineEmbeddingProvider is a native embedding layer. All are external boundaries relative to the MCP tool under test.
/**
 * Tests for yakcc_resolve tool.
 *
 * @decision DEC-HOOK-PROACTIVE-A-001 (MASTER_PLAN.md)
 * @title yakcc_resolve — intent-time discovery surface via MCP
 * @status decided (wi-953, bite 1)
 * @rationale
 *   These tests verify all four resolution paths:
 *   1. Local auto-accept short-circuit (no http calls when high-confidence local match)
 *   2. Local empty + global merge (http.get called when local yields no candidates)
 *   3. Air-gap short-circuit (YAKCC_AIRGAPPED=1 prevents http.get entirely)
 *   4. Network error in global (http.get throws → degrade to local_only content)
 *   Plus confidence band mapping, input validation, and error-as-content discipline.
 *
 * Mock strategy:
 *   - yakccResolve from @yakcc/hooks-base is vi.mock()'d at the module boundary.
 *     This means no real Registry or SQLite is needed in tests.
 *   - HttpClient is injected as a stub (same pattern as search-atoms.test.ts).
 *
 * @mock-exempt HttpClient and yakccResolve are injected/mocked — no real network or DB.
 *
 * Implements: yakcc#953
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HttpClient, HttpError } from "../http-client.js";

// ---------------------------------------------------------------------------
// Module mock: yakccResolve from @yakcc/hooks-base
// ---------------------------------------------------------------------------
// We mock the entire @yakcc/hooks-base module so we never open a real SQLite DB.
// The tool is created with a mock registry factory that returns a stub registry.
// yakccResolve is the sole local-query authority (Sacred Practice #12).

vi.mock("@yakcc/hooks-base", () => ({
  yakccResolve: vi.fn(),
}));

// We also mock @yakcc/registry's openRegistry so the lazy open doesn't hit disk.
vi.mock("@yakcc/registry", () => ({
  openRegistry: vi.fn(),
}));

// We mock @yakcc/contracts' createOfflineEmbeddingProvider.
vi.mock("@yakcc/contracts", () => ({
  createOfflineEmbeddingProvider: vi.fn().mockReturnValue({}),
}));

import type { ResolveResult } from "@yakcc/hooks-base";
import { yakccResolve } from "@yakcc/hooks-base";
import { openRegistry } from "@yakcc/registry";
import { createResolveTool, resolveTool } from "./resolve.js";

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function makeHttp(
  overrides: Partial<{
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
  }> = {},
): HttpClient {
  return {
    get: overrides.get ?? vi.fn(),
    post: overrides.post ?? vi.fn(),
  } as unknown as HttpClient;
}

/** A stub registry object — the content doesn't matter since yakccResolve is mocked. */
const STUB_REGISTRY = {} as unknown as import("@yakcc/registry").Registry;

/** Produce a tool instance with a registry factory that immediately returns STUB_REGISTRY. */
function makeToolWithStubRegistry(): ReturnType<typeof createResolveTool> {
  return createResolveTool({
    openRegistry: async () => STUB_REGISTRY,
  });
}

/** A minimal "matched" ResolveResult with one auto-accept-tier candidate (score 0.95). */
function makeAutoAcceptResult(): ResolveResult {
  return {
    status: "matched",
    candidates: [
      {
        address: "abcd1234",
        behavior: "computes deterministic hash of a UTF-8 string",
        signature: "(input: string) => string",
        score: 0.95,
        guarantees: ["deterministic", "pure"],
        tests: { count: 5 },
        usage: null,
      },
    ],
  };
}

/** A ResolveResult with no candidates (empty / no_match from local). */
function makeEmptyResult(): ResolveResult {
  return { status: "no_match", candidates: [] };
}

/** A ResolveResult with one weak candidate (score 0.55 — candidate_list tier). */
function makeWeakResult(): ResolveResult {
  return {
    status: "weak_only",
    candidates: [
      {
        address: "deadbeef",
        behavior: "weak match description",
        signature: "(x: number) => number",
        score: 0.55,
        guarantees: [],
        tests: { count: 1 },
        usage: null,
      },
    ],
  };
}

/** Minimal blocks-page response from the global catalog endpoint. */
const GLOBAL_BLOCKS_RESPONSE = {
  roots: [`aabbccdd${"0".repeat(56)}`, `11223344${"0".repeat(56)}`],
  nextCursor: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("yakcc_resolve tool shape", () => {
  it("has correct name", () => {
    expect(resolveTool.name).toBe("yakcc_resolve");
  });

  it("has a non-empty description", () => {
    expect(resolveTool.description.length).toBeGreaterThan(100);
  });

  it("inputSchema has type=object, required=[intent], properties for intent and limit", () => {
    expect(resolveTool.inputSchema.type).toBe("object");
    expect(resolveTool.inputSchema.required).toContain("intent");
    expect(resolveTool.inputSchema.properties).toHaveProperty("intent");
    expect(resolveTool.inputSchema.properties).toHaveProperty("limit");
  });
});

describe("yakcc_resolve handler — local auto-accept short-circuit", () => {
  let tool: ReturnType<typeof createResolveTool>;

  beforeEach(() => {
    vi.mocked(yakccResolve).mockResolvedValue(makeAutoAcceptResult());
    tool = makeToolWithStubRegistry();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns confidence_tier=auto_accept for a high-score local match", async () => {
    const http = makeHttp();
    const result = await tool.handler(
      { intent: { title: "compute deterministic hash of string" } },
      http,
    );
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as {
      confidence_tier: string;
      source: string;
      candidates: unknown[];
      airgapped: boolean;
    };
    expect(parsed.confidence_tier).toBe("auto_accept");
    expect(parsed.source).toBe("local_only");
    expect(parsed.airgapped).toBe(false);
    expect(parsed.candidates).toHaveLength(1);
  });

  it("does NOT call http.get when local yields auto_accept-tier result", async () => {
    const getFn = vi.fn();
    const http = makeHttp({ get: getFn });
    await tool.handler({ intent: { title: "compute hash" } }, http);
    expect(getFn).not.toHaveBeenCalled();
  });

  it("yakccResolve is called with the correct intent card", async () => {
    const http = makeHttp();
    await tool.handler(
      {
        intent: {
          title: "my function title",
          description: "detailed rationale",
          signature: "(a: string) => boolean",
        },
        limit: 5,
      },
      http,
    );
    expect(vi.mocked(yakccResolve)).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(yakccResolve).mock.calls[0];
    // First arg is registry, second is the QueryIntentCard built from intent.
    // title + description are merged into the behavior field.
    const query = callArgs?.[1];
    expect(query).toMatchObject({ behavior: "my function title detailed rationale", topK: 5 });
  });
});

describe("yakcc_resolve handler — local empty + global merge", () => {
  let tool: ReturnType<typeof createResolveTool>;
  const savedAirgap = process.env.YAKCC_AIRGAPPED;

  beforeEach(() => {
    vi.mocked(yakccResolve).mockResolvedValue(makeEmptyResult());
    tool = makeToolWithStubRegistry();
    // Ensure airgap is OFF
    process.env.YAKCC_AIRGAPPED = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (savedAirgap !== undefined) {
      process.env.YAKCC_AIRGAPPED = savedAirgap;
    } else {
      process.env.YAKCC_AIRGAPPED = undefined;
    }
  });

  it("calls http.get when local yields no candidates and YAKCC_AIRGAPPED is not set", async () => {
    const getFn = vi.fn().mockResolvedValueOnce(GLOBAL_BLOCKS_RESPONSE);
    const http = makeHttp({ get: getFn });
    await tool.handler({ intent: { title: "novel function no local match" } }, http);
    expect(getFn).toHaveBeenCalled();
  });

  it("returns confidence_tier=candidate_list with source=local+global when global returns blocks", async () => {
    const getFn = vi.fn().mockResolvedValueOnce(GLOBAL_BLOCKS_RESPONSE);
    const http = makeHttp({ get: getFn });
    const result = await tool.handler({ intent: { title: "no local match" } }, http);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as {
      confidence_tier: string;
      source: string;
      candidates: unknown[];
      airgapped: boolean;
    };
    expect(parsed.confidence_tier).toBe("candidate_list");
    expect(parsed.source).toBe("local+global");
    expect(parsed.airgapped).toBe(false);
    expect(Array.isArray(parsed.candidates)).toBe(true);
    expect(parsed.candidates.length).toBeGreaterThan(0);
  });

  it("returns confidence_tier=no_candidates when both local and global are empty", async () => {
    const getFn = vi.fn().mockResolvedValueOnce({ roots: [], nextCursor: null });
    const http = makeHttp({ get: getFn });
    const result = await tool.handler({ intent: { title: "truly novel" } }, http);
    const parsed = JSON.parse(result[0]!.text) as { confidence_tier: string };
    expect(parsed.confidence_tier).toBe("no_candidates");
  });

  it("deduplicates candidates that appear in both local and global results", async () => {
    // Local has one weak candidate with a known address prefix
    vi.mocked(yakccResolve).mockResolvedValue(makeWeakResult());
    // Global returns the same root as what the weak local result maps to,
    // plus one genuinely new root.
    // "deadbeef" from makeWeakResult maps to address "deadbeef" (first 8 chars).
    const dedupedRoot = `deadbeef${"0".repeat(56)}`;
    const freshRoot = `cafebabe${"0".repeat(56)}`;
    const getFn = vi
      .fn()
      .mockResolvedValueOnce({ roots: [dedupedRoot, freshRoot], nextCursor: null });
    const http = makeHttp({ get: getFn });
    const result = await tool.handler({ intent: { title: "partial local match" } }, http);
    const parsed = JSON.parse(result[0]!.text) as {
      candidates: Array<{ source: string; atom_id: string }>;
    };
    // "deadbeef" should only appear once (deduped)
    const deadbeefCandidates = parsed.candidates.filter((c) => c.atom_id.startsWith("deadbeef"));
    expect(deadbeefCandidates).toHaveLength(1);
  });
});

describe("yakcc_resolve handler — air-gap short-circuit", () => {
  let tool: ReturnType<typeof createResolveTool>;
  const savedAirgap = process.env.YAKCC_AIRGAPPED;

  beforeEach(() => {
    vi.mocked(yakccResolve).mockResolvedValue(makeEmptyResult());
    tool = makeToolWithStubRegistry();
    process.env.YAKCC_AIRGAPPED = "1";
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (savedAirgap !== undefined) {
      process.env.YAKCC_AIRGAPPED = savedAirgap;
    } else {
      process.env.YAKCC_AIRGAPPED = undefined;
    }
  });

  it("does NOT call http.get when YAKCC_AIRGAPPED=1, even when local is empty", async () => {
    const getFn = vi.fn();
    const http = makeHttp({ get: getFn });
    await tool.handler({ intent: { title: "any intent" } }, http);
    expect(getFn).not.toHaveBeenCalled();
  });

  it("returns airgapped=true and source=local_only when airgapped", async () => {
    const getFn = vi.fn();
    const http = makeHttp({ get: getFn });
    const result = await tool.handler({ intent: { title: "any intent" } }, http);
    const parsed = JSON.parse(result[0]!.text) as {
      airgapped: boolean;
      source: string;
    };
    expect(parsed.airgapped).toBe(true);
    expect(parsed.source).toBe("local_only");
  });

  it("returns confidence_tier=no_candidates when airgapped and local is empty", async () => {
    const getFn = vi.fn();
    const http = makeHttp({ get: getFn });
    const result = await tool.handler({ intent: { title: "any intent" } }, http);
    const parsed = JSON.parse(result[0]!.text) as { confidence_tier: string };
    expect(parsed.confidence_tier).toBe("no_candidates");
  });
});

describe("yakcc_resolve handler — network error degradation", () => {
  let tool: ReturnType<typeof createResolveTool>;
  const savedAirgap = process.env.YAKCC_AIRGAPPED;

  beforeEach(() => {
    vi.mocked(yakccResolve).mockResolvedValue(makeEmptyResult());
    tool = makeToolWithStubRegistry();
    process.env.YAKCC_AIRGAPPED = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (savedAirgap !== undefined) {
      process.env.YAKCC_AIRGAPPED = savedAirgap;
    } else {
      process.env.YAKCC_AIRGAPPED = undefined;
    }
  });

  it("catches HttpError from http.get and returns source=local_only without throwing", async () => {
    const getFn = vi
      .fn()
      .mockRejectedValueOnce(
        new HttpError({ status: 503, code: "service_unavailable", message: "Down" }),
      );
    const http = makeHttp({ get: getFn });
    // Must NOT throw
    const result = await tool.handler({ intent: { title: "intent" } }, http);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as { source: string };
    expect(parsed.source).toBe("local_only");
  });

  it("catches generic Error from http.get and returns source=local_only without throwing", async () => {
    const getFn = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const http = makeHttp({ get: getFn });
    const result = await tool.handler({ intent: { title: "intent" } }, http);
    const parsed = JSON.parse(result[0]!.text) as { source: string };
    expect(parsed.source).toBe("local_only");
  });

  it("never throws from the handler even when local registry open fails", async () => {
    const failingTool = createResolveTool({
      openRegistry: async () => {
        throw new Error("SQLite open failed — no registry at path");
      },
    });
    const http = makeHttp({ get: vi.fn() });
    // Must NOT throw — DEC-MCP-ERROR-AS-CONTENT-004
    const result = await failingTool.handler({ intent: { title: "intent" } }, http);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as { error?: string };
    expect(typeof parsed.error).toBe("string");
  });
});

describe("yakcc_resolve handler — confidence band mapping", () => {
  let tool: ReturnType<typeof createResolveTool>;
  const savedAirgap = process.env.YAKCC_AIRGAPPED;

  beforeEach(() => {
    tool = makeToolWithStubRegistry();
    // Force airgap so global path never fires and we test local-only bands purely
    process.env.YAKCC_AIRGAPPED = "1";
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (savedAirgap !== undefined) {
      process.env.YAKCC_AIRGAPPED = savedAirgap;
    } else {
      process.env.YAKCC_AIRGAPPED = undefined;
    }
  });

  it("auto_accept tier: matched status + score>0.85 AND gap>0.05 → auto_accept", async () => {
    // Single candidate, score 0.95. No second candidate → gap is effectively 1.0 > 0.05.
    vi.mocked(yakccResolve).mockResolvedValue(makeAutoAcceptResult());
    const http = makeHttp();
    const result = await tool.handler({ intent: { title: "hash string" } }, http);
    const parsed = JSON.parse(result[0]!.text) as { confidence_tier: string };
    expect(parsed.confidence_tier).toBe("auto_accept");
  });

  // @mock-exempt: mirrors the established mock pattern in this describe block
  // (yakccResolve is replaced via vi.mock("@yakcc/hooks-base") at the top so
  // every tier test can drive the unit-under-test deterministically).
  it("auto_accept tier: #1029 high-confidence override — top>0.92 auto-accepts regardless of gap", async () => {
    // Top 0.95 with a 2nd candidate at 0.93 -> gap is 0.02 (< 0.05 threshold).
    // Without the override this would be candidate_list and the model would
    // hedge; with override it correctly auto-accepts.
    vi.mocked(yakccResolve).mockResolvedValue({
      status: "matched",
      candidates: [
        {
          address: "aaaabbbb",
          behavior: "perfect match",
          signature: "(x: string) => number",
          score: 0.95,
          guarantees: [],
          tests: { count: 2 },
          usage: null,
        },
        {
          address: "ccccdddd",
          behavior: "very close runner-up",
          signature: "(x: string) => number",
          score: 0.93,
          guarantees: [],
          tests: { count: 2 },
          usage: null,
        },
      ],
    });
    const http = makeHttp();
    const result = await tool.handler({ intent: { title: "hash string" } }, http);
    const parsed = JSON.parse(result[0]!.text) as { confidence_tier: string };
    expect(parsed.confidence_tier).toBe("auto_accept");
  });

  it("candidate_list tier: matched status with score ≥0.70 but not auto_accept → candidate_list", async () => {
    // Score 0.75 — confident band but NOT auto_accept (0.75 < 0.92)
    vi.mocked(yakccResolve).mockResolvedValue({
      status: "matched",
      candidates: [
        {
          address: "aaaabbbb",
          behavior: "confident match",
          signature: "(x: number) => number",
          score: 0.75,
          guarantees: [],
          tests: { count: 2 },
          usage: null,
        },
      ],
    });
    const http = makeHttp();
    const result = await tool.handler({ intent: { title: "confident match" } }, http);
    const parsed = JSON.parse(result[0]!.text) as { confidence_tier: string };
    expect(parsed.confidence_tier).toBe("candidate_list");
  });

  it("candidate_list tier: weak_only status → candidate_list", async () => {
    vi.mocked(yakccResolve).mockResolvedValue(makeWeakResult());
    const http = makeHttp();
    const result = await tool.handler({ intent: { title: "weak match" } }, http);
    const parsed = JSON.parse(result[0]!.text) as { confidence_tier: string };
    expect(parsed.confidence_tier).toBe("candidate_list");
  });

  it("no_candidates tier: no_match status → no_candidates", async () => {
    vi.mocked(yakccResolve).mockResolvedValue(makeEmptyResult());
    const http = makeHttp();
    const result = await tool.handler({ intent: { title: "unknown" } }, http);
    const parsed = JSON.parse(result[0]!.text) as { confidence_tier: string };
    expect(parsed.confidence_tier).toBe("no_candidates");
  });
});

describe("yakcc_resolve handler — input validation", () => {
  let tool: ReturnType<typeof createResolveTool>;

  beforeEach(() => {
    vi.mocked(yakccResolve).mockResolvedValue(makeEmptyResult());
    tool = makeToolWithStubRegistry();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("missing intent → returns error content, does not throw", async () => {
    const http = makeHttp();
    const result = await tool.handler({}, http);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as { error: string; message: string };
    expect(parsed.error).toBe("invalid_input");
    expect(typeof parsed.message).toBe("string");
  });

  it("intent is not an object → returns error content, does not throw", async () => {
    const http = makeHttp();
    const result = await tool.handler({ intent: "bare string not allowed" }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("intent.title is missing → returns error content, does not throw", async () => {
    const http = makeHttp();
    const result = await tool.handler({ intent: { description: "no title" } }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("intent.title is empty string → returns error content, does not throw", async () => {
    const http = makeHttp();
    const result = await tool.handler({ intent: { title: "" } }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("args is null → returns error content, does not throw", async () => {
    const http = makeHttp();
    const result = await tool.handler(null, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("limit out of range → returns error content, does not throw", async () => {
    const http = makeHttp();
    const result = await tool.handler({ intent: { title: "valid title" }, limit: 0 }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("limit too large → returns error content, does not throw", async () => {
    const http = makeHttp();
    const result = await tool.handler({ intent: { title: "valid title" }, limit: 9999 }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });
});

describe("yakcc_resolve handler — openRegistry lazy call", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls the injected openRegistry factory exactly once even on multiple handler calls", async () => {
    vi.mocked(yakccResolve).mockResolvedValue(makeAutoAcceptResult());
    const openFn = vi.fn().mockResolvedValue(STUB_REGISTRY);
    const tool = createResolveTool({ openRegistry: openFn });
    const http = makeHttp();
    await tool.handler({ intent: { title: "first call" } }, http);
    await tool.handler({ intent: { title: "second call" } }, http);
    // Registry opened once and cached
    expect(openFn).toHaveBeenCalledTimes(1);
  });
});

describe("openRegistry mock integration — createResolveTool uses injected factory", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("the default tool instance (resolveTool) still exports correct name", () => {
    expect(resolveTool.name).toBe("yakcc_resolve");
  });

  it("openRegistry from @yakcc/registry mock is callable from createResolveTool default path", () => {
    // This just verifies the mock is wired — we don't want to actually call openRegistry
    // in unit tests (it would try to open SQLite). The mock ensures it's a no-op.
    expect(vi.mocked(openRegistry)).toBeDefined();
  });
});
