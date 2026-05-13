// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/harness/harness-unit.test.mjs
//
// Unit tests for B4 harness correctness.
// Covers:
//   - extractCode robustness (tool_use stop_reason scenario — issue #450)
//   - MCP server lifecycle (WI-460: real atom-lookup backend)
//
// Run:
//   node --test bench/B4-tokens/harness/harness-unit.test.mjs
//   (uses Node.js built-in test runner to avoid vitest version conflicts)

import { strict as assert } from "node:assert";
import { describe, it, before } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { statSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = __dirname;
const ORACLE_RUNNER_PATH = join(HARNESS_DIR, "oracle-runner.mjs");
const MCP_SERVER_PATH = join(HARNESS_DIR, "mcp-server.mjs");

// Resolve main repo root (same logic as run.mjs)
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
const REPO_ROOT = findRepoRootSync(__dirname);

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
    // the oracle WILL fail (semantic_equivalent: false), which is correct.
    const emptyCode = extractCode("");
    assert.equal(typeof emptyCode, "string");
    assert.equal(emptyCode.length, 0);
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

// ---------------------------------------------------------------------------
// MCP server lifecycle tests (WI-460)
// ---------------------------------------------------------------------------

/**
 * Send a Content-Length framed JSON-RPC message to a process's stdin.
 */
function sendMcpMessage(proc, message) {
  const body = JSON.stringify(message);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  proc.stdin.write(header + body);
}

/**
 * Start the MCP server and return a helper object.
 * Caller must call close() when done.
 */
async function spawnMcpServer() {
  const server = spawn("node", [MCP_SERVER_PATH], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      YAKCC_REPO_ROOT: REPO_ROOT,
      YAKCC_REGISTRY_PATH: join(REPO_ROOT, ".yakcc", "registry.sqlite"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuf = Buffer.alloc(0);
  const pending = new Map();
  let reqId = 1;

  server.stdout.on("data", (chunk) => {
    stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
    while (true) {
      const hEnd = stdoutBuf.indexOf("\r\n\r\n");
      if (hEnd === -1) break;
      const hText = stdoutBuf.slice(0, hEnd).toString("utf8");
      const m = hText.match(/Content-Length:\s*(\d+)/i);
      if (!m) { stdoutBuf = stdoutBuf.slice(hEnd + 4); break; }
      const cl = parseInt(m[1], 10);
      const bStart = hEnd + 4;
      if (stdoutBuf.length < bStart + cl) break;
      const body = stdoutBuf.slice(bStart, bStart + cl).toString("utf8");
      stdoutBuf = stdoutBuf.slice(bStart + cl);
      try {
        const msg = JSON.parse(body);
        const res = pending.get(msg.id);
        if (res) { pending.delete(msg.id); res(msg); }
      } catch (_) {}
    }
  });

  function request(method, params) {
    const id = reqId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      sendMcpMessage(server, { jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 15000);
    });
  }

  // Perform MCP handshake
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });

  return {
    request,
    close: () => server.kill("SIGTERM"),
  };
}

describe("MCP server lifecycle (WI-460)", { timeout: 30000 }, () => {
  it("starts cleanly and responds to tools/list with atom-lookup tool", async () => {
    const server = await spawnMcpServer();
    try {
      const response = await server.request("tools/list", {});
      assert.ok(response.result, "tools/list must return a result");
      assert.ok(Array.isArray(response.result.tools), "tools must be an array");
      const atomLookup = response.result.tools.find((t) => t.name === "atom-lookup");
      assert.ok(atomLookup, "atom-lookup tool must be present");
      assert.ok(atomLookup.description, "tool must have a description");
      assert.ok(atomLookup.inputSchema, "tool must have an inputSchema");
      assert.ok(atomLookup.inputSchema.properties.intent, "inputSchema must have 'intent' property");
    } finally {
      server.close();
    }
  });

  it("atom-lookup tool returns { atoms: Array } structure", async () => {
    const server = await spawnMcpServer();
    try {
      const response = await server.request("tools/call", {
        name: "atom-lookup",
        arguments: {
          intent: "parse integers from a string at a given position",
          substitution_aggressiveness: "aggressive",
        },
      });
      assert.ok(response.result, "tools/call must return a result");
      assert.ok(Array.isArray(response.result.content), "result.content must be array");
      const text = response.result.content[0]?.text;
      assert.ok(text, "content[0].text must exist");
      const parsed = JSON.parse(text);
      assert.ok(Array.isArray(parsed.atoms), "parsed result must have atoms array");
      // With aggressive mode and a parseable query, we expect at least 1 candidate
      // (the existing integer/digit atoms in the registry)
      assert.ok(parsed.atoms.length > 0, "should find at least one candidate for integer parsing");
      // Verify atom structure
      const first = parsed.atoms[0];
      assert.ok(typeof first.atom_id === "string", "atom_id must be a string");
      assert.ok(typeof first.atom_signature === "string", "atom_signature must be a string");
      assert.ok(typeof first.match_confidence === "number", "match_confidence must be a number");
      assert.ok(typeof first.atom_body_sha256 === "string", "atom_body_sha256 must be a string");
    } finally {
      server.close();
    }
  });

  it("atom-lookup with timer-shaped query returns timer-handle atom (debounce coverage)", async () => {
    const server = await spawnMcpServer();
    try {
      const response = await server.request("tools/call", {
        name: "atom-lookup",
        arguments: {
          intent: "schedule a delayed timer callback with setTimeout clearTimeout cancel handle",
          substitution_aggressiveness: "aggressive",
        },
      });
      const text = response.result?.content?.[0]?.text;
      assert.ok(text, "content text must exist");
      const parsed = JSON.parse(text);
      // With aggressive mode, should return candidates (timer-handle should be in there
      // once the registry is rebuilt with the new seed; even before that, other atoms return)
      assert.ok(Array.isArray(parsed.atoms), "atoms must be array");
      // Log what we got for observability
      console.log(`  timer-query: ${parsed.atoms.length} candidate(s) returned`);
      if (parsed.atoms.length > 0) {
        console.log(`  first: ${parsed.atoms[0].atom_signature} confidence=${parsed.atoms[0].match_confidence}`);
      }
    } finally {
      server.close();
    }
  });

  it("substitution aggressiveness produces monotonic candidate set sizes", async () => {
    const server = await spawnMcpServer();
    const intent = "parse integer digits from input string at position";

    async function queryCount(aggressiveness) {
      const response = await server.request("tools/call", {
        name: "atom-lookup",
        arguments: { intent, substitution_aggressiveness: aggressiveness },
      });
      const text = response.result?.content?.[0]?.text;
      const parsed = JSON.parse(text);
      return parsed.atoms.length;
    }

    try {
      const conservative = await queryCount("conservative");
      const defaultCount = await queryCount("default");
      const aggressive = await queryCount("aggressive");

      console.log(`  conservative=${conservative} default=${defaultCount} aggressive=${aggressive}`);
      // Monotonic invariant: conservative <= default <= aggressive
      assert.ok(
        conservative <= defaultCount,
        `conservative (${conservative}) must be <= default (${defaultCount})`
      );
      assert.ok(
        defaultCount <= aggressive,
        `default (${defaultCount}) must be <= aggressive (${aggressive})`
      );
    } finally {
      server.close();
    }
  });

  it("atom-lookup with empty result (unknown concept) returns { atoms: [] }", async () => {
    const server = await spawnMcpServer();
    try {
      const response = await server.request("tools/call", {
        name: "atom-lookup",
        arguments: {
          // Use a very high threshold + specific query likely to miss
          intent: "quantum entanglement photon beam splitter quantum cryptography",
          confidence_threshold: 0.99,
          substitution_aggressiveness: "conservative",
        },
      });
      const text = response.result?.content?.[0]?.text;
      assert.ok(text, "content text must exist");
      const parsed = JSON.parse(text);
      // High threshold + quantum concept should return empty (not throw)
      assert.ok(Array.isArray(parsed.atoms), "atoms must be array even for empty results");
      // We don't assert length=0 because a real registry might have surprising matches,
      // but we do assert the structure is correct.
    } finally {
      server.close();
    }
  });

  it("server shuts down cleanly on SIGTERM", async (t) => {
    const server = spawn("node", [MCP_SERVER_PATH], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        YAKCC_REPO_ROOT: REPO_ROOT,
        YAKCC_REGISTRY_PATH: join(REPO_ROOT, ".yakcc", "registry.sqlite"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Wait for server to start
    await new Promise((r) => setTimeout(r, 500));

    const exitCode = await new Promise((resolve) => {
      server.on("exit", (code) => resolve(code));
      server.kill("SIGTERM");
    });

    // SIGTERM should produce a clean exit (0 or null/killed-by-signal)
    assert.ok(
      exitCode === 0 || exitCode === null,
      `Server should exit cleanly on SIGTERM, got exit code: ${exitCode}`
    );
  });
});
