/**
 * Tests for scripts/check-no-bom.mjs
 *
 * @decision DEC-CI-NO-BOM-GUARD-001
 * Title:    BOM scanner test suite — node:test, zero external deps
 * Status:   accepted (WI-755)
 * Rationale: Uses built-in node:test (stable in Node 22, available since
 *   Node 18) to avoid pulling vitest or jest into the root package or
 *   creating a separate scripts/package.json.  Tests exercise the real
 *   production sequence: spawn the scanner as a child process against a
 *   synthetic workspace dir and assert on exit code + stdio, exactly as
 *   CI would observe.  See plans/wi-755-bom-strip.md §3.4.
 *
 * Run: node --test scripts/check-no-bom.test.mjs
 *
 * Test matrix (per plans/wi-755-bom-strip.md §3.4):
 *   1. clean-tree exits 0
 *   2. BOM-bearing file exits 1 + path printed to stderr
 *   3. skip-dir is respected (node_modules/ not scanned)
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Resolve the scanner script path relative to this test file so the test
// works regardless of the process.cwd() at invocation time.
const SCRIPT = fileURLToPath(new URL("./check-no-bom.mjs", import.meta.url));

/**
 * Create an isolated temp directory and populate it with the given files.
 *
 * @param {Record<string, string | Buffer>} files
 *   Map of relative path -> content (string = UTF-8 text, Buffer = raw bytes).
 * @returns {string} Absolute path to the temp directory root.
 */
function makeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), "check-no-bom-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    // Ensure parent directories exist before writing.
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/**
 * Production sequence: a consumer runs `node scripts/check-no-bom.mjs` from
 * the workspace root.  The test exercises that exact sequence by spawning the
 * script as a child process in a synthetic workspace directory, then asserting
 * on exit code and stdio — the same signals CI reads.
 */

test("exits 0 when no BOM is present", () => {
  const root = makeFixture({
    "src/a.ts": "export const x = 1;\n",
    "src/b.mjs": "export default {};\n",
    "package.json": '{"name":"test"}\n',
  });

  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(
    result.status,
    0,
    `expected exit 0 on clean tree, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  assert.match(result.stdout, /OK no BOM found/, "expected OK message on stdout");
});

test("exits 1 and prints offending path when a BOM is present", () => {
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
  const root = makeFixture({
    "src/clean.ts": "export const x = 1;\n",
    // Prepend BOM bytes to a TypeScript file -- mimics editor-on-Windows pattern.
    "src/dirty.ts": Buffer.concat([BOM, Buffer.from("export const y = 2;\n")]),
  });

  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(
    result.status,
    1,
    `expected exit 1 when BOM present, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  // The offending path must appear on stderr (platform path separators vary).
  assert.match(
    result.stderr,
    /src[\\/]dirty\.ts/,
    "expected offending file path in stderr",
  );
  // Clean file must NOT appear in stderr.
  assert.doesNotMatch(
    result.stderr,
    /clean\.ts/,
    "expected clean file to be absent from stderr",
  );
});

test("ignores skip dirs (node_modules not scanned)", () => {
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
  const root = makeFixture({
    // BOM file inside node_modules -- scanner must skip it.
    "node_modules/pkg/index.js": Buffer.concat([
      BOM,
      Buffer.from("module.exports = {};\n"),
    ]),
    // Clean file outside skip dir -- scanner must see it and pass.
    "src/a.ts": "export const x = 1;\n",
  });

  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(
    result.status,
    0,
    `expected exit 0 when BOM is only inside node_modules, got ${result.status}\nstderr: ${result.stderr}`,
  );
});
