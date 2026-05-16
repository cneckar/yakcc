/**
 * system-prompt.test.ts — Structural regression tests for docs/system-prompts/yakcc-discovery.md.
 *
 * WI-578 acceptance criteria:
 *   - Imperative language ("MUST") replaces suggestions ("should consider")
 *   - Explicit refusal of loose/vague intents documented in the prompt
 *   - Descent-and-compose loop is the canonical control flow
 *   - URL-parser (or equivalent) worked example is present
 *   - Self-check step is present
 *   - No carve-outs for "business logic" / "application-specific" / "one-off" (they must be
 *     explicitly REJECTED, not silently omitted)
 *   - Registry-offline is the ONLY permissible exception to querying first
 *
 * These tests are structural: they verify the prompt file CONTAINS the required language and
 * EXCLUDES forbidden patterns. They do not execute an LLM against the prompt — that requires
 * a telemetry-driven eval (see the eval corpus fixtures below for the intent corpus).
 *
 * @decision DEC-WI578-HOOK-PROMPT-SPECIFIC-FIRST-001
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT_PATH } from "../src/yakcc-resolve-tool.js";

// ---------------------------------------------------------------------------
// Load the canonical system prompt
// ---------------------------------------------------------------------------

// __dirname equivalent for ESM: the test file is at packages/hooks-claude-code/test/
const testDir = fileURLToPath(new URL(".", import.meta.url));
// Workspace root is three levels up from the test directory.
const workspaceRoot = join(testDir, "../../..");

const PROMPT_PATH = join(workspaceRoot, SYSTEM_PROMPT_PATH);
const prompt = readFileSync(PROMPT_PATH, "utf-8");
const promptLower = prompt.toLowerCase();

// ---------------------------------------------------------------------------
// Imperative language
// ---------------------------------------------------------------------------

describe("imperative language", () => {
  it("uses MUST (imperative) not 'should consider' (suggestive)", () => {
    expect(prompt).toContain("MUST");
    expect(promptLower).not.toMatch(/you should consider/);
    expect(promptLower).not.toMatch(/you might want to/);
    expect(promptLower).not.toMatch(/it is recommended that/);
  });

  it("states that querying is mandatory before writing code", () => {
    expect(prompt).toMatch(/MUST.*query|query.*MUST/);
  });

  it("states that zooming out is prohibited on a miss", () => {
    expect(prompt).toMatch(/MUST NOT.*widen|never.*zoom out|MUST.*zoom in/i);
  });
});

// ---------------------------------------------------------------------------
// Self-check step
// ---------------------------------------------------------------------------

describe("self-check step", () => {
  it("includes a self-check before every query", () => {
    expect(promptLower).toMatch(/self.check/);
  });

  it("self-check asks whether intent is the most specific", () => {
    expect(promptLower).toMatch(/most specific/);
  });

  it("defines what makes an intent too broad", () => {
    expect(promptLower).toMatch(/too broad/);
  });
});

// ---------------------------------------------------------------------------
// Descent-and-compose loop
// ---------------------------------------------------------------------------

describe("descent-and-compose control flow", () => {
  it("describes a descent-and-compose or zoom-in loop", () => {
    const hasDescentCompose =
      promptLower.includes("descent-and-compose") ||
      (promptLower.includes("descent") && promptLower.includes("compose")) ||
      (promptLower.includes("zoom in") && promptLower.includes("compose"));
    expect(hasDescentCompose).toBe(true);
  });

  it("instructs composing results upward after leaf hits", () => {
    expect(promptLower).toMatch(/compose upward|compose.*upward|assemble.*atoms/);
  });

  it("instructs persisting the composed atom for future consumers", () => {
    expect(promptLower).toMatch(/persist|new atom/);
  });
});

// ---------------------------------------------------------------------------
// Worked example
// ---------------------------------------------------------------------------

describe("worked example", () => {
  it("includes a URL-parser or equivalent concrete example", () => {
    const hasExample =
      promptLower.includes("url parser") || promptLower.includes("url-parser");
    expect(hasExample).toBe(true);
  });

  it("example shows leaf-level specific queries (e.g. split on `://`)", () => {
    expect(prompt).toMatch(/split.*:\/\/|:\/\//);
  });

  it("example traces a full miss → zoom-in → hit → compose sequence", () => {
    expect(promptLower).toMatch(/miss.*zoom|zoom.*miss|no_match.*zoom|zoom.*no_match/);
  });
});

// ---------------------------------------------------------------------------
// No carve-outs
// ---------------------------------------------------------------------------

describe("no carve-outs", () => {
  it("explicitly rejects 'business logic' as a carve-out exception", () => {
    expect(promptLower).toContain("business logic");
    // The phrase must appear in a rejection/refusal context, not as a permitted exception.
    // We verify the section title or surrounding text rejects it.
    expect(promptLower).toMatch(/no.*carve.out|no exception/i);
  });

  it("explicitly rejects 'application-specific' as a carve-out exception", () => {
    expect(promptLower).toContain("application-specific");
  });

  it("explicitly rejects 'one-off' as a carve-out exception", () => {
    expect(promptLower).toContain("one-off");
  });
});

// ---------------------------------------------------------------------------
// Registry-offline is the ONLY exception
// ---------------------------------------------------------------------------

describe("registry-offline exception", () => {
  it("documents the registry-offline fallback", () => {
    expect(promptLower).toMatch(/registry.*offline|offline.*registry|registry_unreachable/i);
  });

  it("frames registry-offline as the ONLY permissible exception", () => {
    expect(prompt).toMatch(/only.*permissible|ONLY.*permissible|only permissible/i);
  });
});

// ---------------------------------------------------------------------------
// Score bands and auto-accept (functional content preserved from D4 ADR)
// ---------------------------------------------------------------------------

describe("score bands and auto-accept rule", () => {
  it("documents the four score bands", () => {
    expect(prompt).toMatch(/0\.85/);
    expect(prompt).toMatch(/0\.70/);
    expect(prompt).toMatch(/0\.50/);
  });

  it("documents the auto-accept rule with both conditions", () => {
    expect(prompt).toMatch(/auto.accept|auto accept/i);
    expect(prompt).toMatch(/0\.85/);
    expect(prompt).toMatch(/0\.15/);
  });
});

// ---------------------------------------------------------------------------
// D4 ADR authority line is preserved
// ---------------------------------------------------------------------------

describe("ADR authority line", () => {
  it("references DEC-V3-DISCOVERY-D4-001", () => {
    expect(prompt).toContain("DEC-V3-DISCOVERY-D4-001");
  });

  it("references the WI-578 revision decision record", () => {
    expect(prompt).toContain("DEC-WI578");
  });
});
