// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/harness/harness-unit.test.mjs
//
// Unit tests for B4 harness correctness.
// Covers the tool_use stop_reason bug (issue #450) and extractCode robustness.
//
// Run:
//   node --test bench/B4-tokens/harness/harness-unit.test.mjs
//   (uses Node.js built-in test runner to avoid vitest version conflicts)

import { strict as assert } from "node:assert";
import { describe, it, before } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = __dirname;
const ORACLE_RUNNER_PATH = join(HARNESS_DIR, "oracle-runner.mjs");

// Dynamically import since oracle-runner.mjs is ESM
let extractCode;
before(async () => {
  const mod = await import(new URL(`file://${ORACLE_RUNNER_PATH}`).href);
  extractCode = mod.extractCode;
});

// ---------------------------------------------------------------------------
// extractCode — text block extraction
// ---------------------------------------------------------------------------

describe("extractCode — TypeScript fenced blocks", () => {
  it("extracts content from ```typescript block", () => {
    const response = "Here is the code:\n\n```typescript\nexport function foo() {}\n```\n";
    assert.equal(extractCode(response), "export function foo() {}");
  });

  it("extracts content from ```ts block", () => {
    const response = "```ts\nexport function bar() {}\n```";
    assert.equal(extractCode(response), "export function bar() {}");
  });

  it("falls back to generic ``` block when no ts/typescript fence", () => {
    const response = "```\nexport function baz() {}\n```";
    assert.equal(extractCode(response), "export function baz() {}");
  });

  it("returns raw text when no fences found", () => {
    const response = "export function qux() {}";
    assert.equal(extractCode(response), "export function qux() {}");
  });

  it("returns empty string when response is empty (tool_use scenario)", () => {
    // When the model uses a tool instead of generating text,
    // extractResponseText returns "" (no text block in content array).
    // extractCode("") must return "" not throw.
    assert.equal(extractCode(""), "");
  });

  it("trims whitespace from extracted code", () => {
    const response = "```typescript\n  export function foo() {}  \n```";
    assert.equal(extractCode(response), "export function foo() {}");
  });
});

// ---------------------------------------------------------------------------
// tool_use stop_reason scenario
// ---------------------------------------------------------------------------

describe("tool_use stop_reason handling", () => {
  it("extractCode returns empty string when response has only tool_use content blocks", () => {
    // This simulates what happens when the model calls yakccResolve instead of
    // generating TypeScript code directly. The response.content array has no
    // text block, only a tool_use block. extractResponseText returns "".
    // extractCode should handle this gracefully.
    const toolUseResponseText = ""; // result of extractResponseText on a tool_use response
    const code = extractCode(toolUseResponseText);
    assert.equal(code, "", "empty string expected for tool_use response with no text block");
  });

  it("empty code string triggers oracle failure (not a crash)", () => {
    // When extractCode returns "", writing it to the oracle-scratch file produces
    // a file with no exports. The oracle test should fail gracefully (not crash).
    // This test documents the expected behavior before the tool_use fix is applied:
    // the oracle WILL fail (semantic_equivalent: false), which is correct — it should not
    // silently pass when no code was generated.
    const emptyCode = extractCode("");
    assert.equal(typeof emptyCode, "string");
    assert.equal(emptyCode.length, 0);
    // A harness with tool_use handling will retry with tool result to obtain real code.
    // Without the fix, the empty code causes all oracle tests to fail.
  });
});

// ---------------------------------------------------------------------------
// extractCode — CRLF in fenced blocks (Windows compat)
// ---------------------------------------------------------------------------

describe("extractCode — CRLF in fenced blocks (Windows)", () => {
  it("handles CRLF line endings in typescript fenced block", () => {
    const response = "```typescript\r\nexport function foo() {}\r\n```";
    assert.equal(extractCode(response), "export function foo() {}");
  });

  it("handles CRLF line endings in generic fenced block", () => {
    const response = "```\r\nexport function bar() {}\r\n```";
    assert.equal(extractCode(response), "export function bar() {}");
  });
});
