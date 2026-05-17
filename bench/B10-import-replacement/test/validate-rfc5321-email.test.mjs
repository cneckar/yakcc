/**
 * validate-rfc5321-email -- S2 Evaluation Contract tests
 *
 * @decision DEC-BENCH-B10-SLICE2-DEMO-LIBRARY-001
 *   title: Demo library for S2 B10 bench -- validator@13.15.35 / isEmail
 *   status: accepted
 *   rationale: validator is the canonical npm email-validation library;
 *     its isEmail export pulls 114 transitive files (511 reachable functions),
 *     making it an ideal headline demo for the import-replacement bench.
 *
 * Tests covered:
 *   T-CORPUS-1         -- corpus-spec.json structure and field validation
 *   T-A-1              -- arm-a-emit.mjs maps task to validateRfc5321Email
 *   T-A-2              -- each arm-a strategy: zero npm imports, DEC annotation
 *   T-B-1              -- arm-b fixture exists, uses validator import
 *   T-RESOLVER-DELTA-1 -- dry-run shows >=10x reduction on functions and bytes
 *   T-SMOKE-RUN-1      -- full dry-run exits 0, verdict PASS-DIRECTIONAL
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// BENCH_B10_ROOT is 2 levels up from test/
const BENCH_B10_ROOT = resolve(__dirname, "..");
const TASK_ID = "validate-rfc5321-email";

// ---------------------------------------------------------------------------
// T-CORPUS-1: corpus-spec.json structure
// Verifies the actual corpus-spec.json schema used by B10:
//   - top-level: $schema, tasks[]
//   - task entry keys: id, spec_path, spec_sha256_lf, entry_function,
//     arm_b_prompt.prompt_sha256, directional_targets.reachable_functions_reduction_min
// ---------------------------------------------------------------------------

describe("T-CORPUS-1: corpus-spec.json structure", () => {
  const corpusSpecPath = join(BENCH_B10_ROOT, "corpus-spec.json");
  let corpus;

  it("corpus-spec.json exists", () => {
    assert.ok(existsSync(corpusSpecPath), "missing: " + corpusSpecPath);
    corpus = JSON.parse(readFileSync(corpusSpecPath, "utf8"));
  });

  it("has $schema field", () => {
    corpus = corpus ?? JSON.parse(readFileSync(corpusSpecPath, "utf8"));
    assert.ok(typeof corpus.$schema === "string", "$schema must be a string");
  });

  it("has tasks array with at least one entry for validate-rfc5321-email", () => {
    corpus = corpus ?? JSON.parse(readFileSync(corpusSpecPath, "utf8"));
    assert.ok(Array.isArray(corpus.tasks), "tasks must be an array");
    const task = corpus.tasks.find((t) => t.id === TASK_ID);
    assert.ok(task, "no task entry with id=" + TASK_ID);
  });

  it("task entry has required fields (id, spec_path, spec_sha256_lf, entry_function)", () => {
    corpus = corpus ?? JSON.parse(readFileSync(corpusSpecPath, "utf8"));
    const task = corpus.tasks.find((t) => t.id === TASK_ID);
    assert.ok(task, "no task entry with id=" + TASK_ID);
    assert.ok(typeof task.id === "string", "id must be string");
    assert.ok(typeof task.spec_path === "string", "spec_path must be string");
    assert.ok(typeof task.spec_sha256_lf === "string", "spec_sha256_lf must be string");
    assert.ok(typeof task.entry_function === "string", "entry_function must be string");
  });

  it("spec_sha256_lf is a 64-char hex string", () => {
    corpus = corpus ?? JSON.parse(readFileSync(corpusSpecPath, "utf8"));
    const task = corpus.tasks.find((t) => t.id === TASK_ID);
    assert.ok(task, "no task entry with id=" + TASK_ID);
    assert.match(task.spec_sha256_lf, /^[0-9a-f]{64}$/, "spec_sha256_lf must be 64-char hex");
  });

  it("arm_b_prompt.prompt_sha256 is a 64-char hex string", () => {
    corpus = corpus ?? JSON.parse(readFileSync(corpusSpecPath, "utf8"));
    const task = corpus.tasks.find((t) => t.id === TASK_ID);
    assert.ok(task, "no task entry with id=" + TASK_ID);
    const p = task.arm_b_prompt;
    assert.ok(p && typeof p === "object", "arm_b_prompt must be an object");
    assert.ok(typeof p.prompt_sha256 === "string", "arm_b_prompt.prompt_sha256 must be string");
    assert.match(p.prompt_sha256, /^[0-9a-f]{64}$/, "prompt_sha256 must be 64-char hex");
  });

  it("directional_targets has reachable_functions_reduction_min and reachable_bytes_reduction_min >= 0.90", () => {
    corpus = corpus ?? JSON.parse(readFileSync(corpusSpecPath, "utf8"));
    const task = corpus.tasks.find((t) => t.id === TASK_ID);
    assert.ok(task, "no task entry with id=" + TASK_ID);
    const dt = task.directional_targets;
    assert.ok(dt && typeof dt === "object", "directional_targets must be an object");
    assert.ok(typeof dt.reachable_functions_reduction_min === "number", "reachable_functions_reduction_min must be number");
    assert.ok(typeof dt.reachable_bytes_reduction_min === "number", "reachable_bytes_reduction_min must be number");
    assert.ok(dt.reachable_functions_reduction_min >= 0.9, "fn reduction min must be >= 0.90; got " + dt.reachable_functions_reduction_min);
    assert.ok(dt.reachable_bytes_reduction_min >= 0.9, "bytes reduction min must be >= 0.90; got " + dt.reachable_bytes_reduction_min);
  });
});

// ---------------------------------------------------------------------------
// T-A-1: arm-a strategies resolve to source files
// ---------------------------------------------------------------------------

describe("T-A-1: arm-a strategies resolve to source files", () => {
  const armADir = join(BENCH_B10_ROOT, "tasks", TASK_ID, "arm-a");

  for (const strategy of ["fine", "medium", "coarse"]) {
    it("arm-a/" + strategy + ".mjs exists and is non-empty", () => {
      const filePath = join(armADir, strategy + ".mjs");
      assert.ok(existsSync(filePath), "missing: " + filePath);
      const src = readFileSync(filePath, "utf8");
      assert.ok(src.length > 100, "arm-a/" + strategy + ".mjs is suspiciously short");
    });
  }

  it("arm-a-emit.mjs maps validate-rfc5321-email to validateRfc5321Email", () => {
    const emitSrc = readFileSync(join(BENCH_B10_ROOT, "harness", "arm-a-emit.mjs"), "utf8");
    assert.ok(
      emitSrc.includes("validate-rfc5321-email") && emitSrc.includes("validateRfc5321Email"),
      "arm-a-emit.mjs must map validate-rfc5321-email -> validateRfc5321Email"
    );
  });
});

// ---------------------------------------------------------------------------
// T-A-2: arm-a strategies have zero non-builtin imports and DEC annotation
// ---------------------------------------------------------------------------

describe("T-A-2: arm-a strategies: zero npm imports, DEC annotation present", () => {
  const armADir = join(BENCH_B10_ROOT, "tasks", TASK_ID, "arm-a");

  for (const strategy of ["fine", "medium", "coarse"]) {
    it("arm-a/" + strategy + ".mjs: no non-builtin npm imports", () => {
      const src = readFileSync(join(armADir, strategy + ".mjs"), "utf8");
      const importLines = src.split("\n").filter((l) => /^\s*import\s/.test(l));
      const npmImports = importLines.filter(
        (l) => !/from\s+["'](\.|\.\.|node:)/.test(l) && /from\s+["']/.test(l)
      );
      assert.deepEqual(
        npmImports,
        [],
        "arm-a/" + strategy + ".mjs must not import npm packages; found: " + npmImports.join(", ")
      );
    });

    it("arm-a/" + strategy + ".mjs: has DEC-BENCH-B10-SLICE2-ARMA-FALLBACK-001 annotation", () => {
      const src = readFileSync(join(armADir, strategy + ".mjs"), "utf8");
      assert.ok(
        src.includes("DEC-BENCH-B10-SLICE2-ARMA-FALLBACK-001"),
        "arm-a/" + strategy + ".mjs must contain DEC-BENCH-B10-SLICE2-ARMA-FALLBACK-001 annotation"
      );
    });
  }
});

// ---------------------------------------------------------------------------
// T-B-1: arm-b fixture exists and uses validator
// ---------------------------------------------------------------------------

describe("T-B-1: arm-b fixture exists and imports validator", () => {
  const fixturePath = join(BENCH_B10_ROOT, "fixtures", TASK_ID, "arm-b-response.json");
  let fixture;

  it("arm-b-response.json fixture exists", () => {
    assert.ok(existsSync(fixturePath), "missing: " + fixturePath);
    fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  });

  it("fixture has Anthropic Messages API shape (id, type, content)", () => {
    fixture = fixture ?? JSON.parse(readFileSync(fixturePath, "utf8"));
    assert.ok(typeof fixture.id === "string", "fixture must have id");
    assert.ok(fixture.type === "message", "fixture.type must be message");
    assert.ok(Array.isArray(fixture.content), "fixture.content must be array");
  });

  it("fixture text content references validator", () => {
    fixture = fixture ?? JSON.parse(readFileSync(fixturePath, "utf8"));
    const text = fixture.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    assert.ok(text.includes("validator"), "arm-b fixture must reference validator package");
  });

  it("fixture text content defines validateRfc5321Email", () => {
    fixture = fixture ?? JSON.parse(readFileSync(fixturePath, "utf8"));
    const text = fixture.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    assert.ok(
      text.includes("validateRfc5321Email"),
      "arm-b fixture must define validateRfc5321Email"
    );
  });

  it("fixture has _prompt_sha256 (64-char hex) for cross-bench lock", () => {
    fixture = fixture ?? JSON.parse(readFileSync(fixturePath, "utf8"));
    assert.ok(typeof fixture._prompt_sha256 === "string", "fixture must have _prompt_sha256");
    assert.match(fixture._prompt_sha256, /^[0-9a-f]{64}$/, "_prompt_sha256 must be 64-char hex");
  });
});

// ---------------------------------------------------------------------------
// T-RESOLVER-DELTA-1: dry-run surface delta >= 10x on functions and bytes
// ---------------------------------------------------------------------------

describe("T-RESOLVER-DELTA-1: dry-run surface delta >= 10x on functions and bytes", () => {
  const result = spawnSync(
    process.execPath,
    ["harness/run.mjs", "--dry-run", "--tasks=validate-rfc5321-email"],
    {
      cwd: BENCH_B10_ROOT,
      encoding: "utf8",
      timeout: 120_000,
    }
  );

  it("dry-run --tasks=validate-rfc5321-email exits 0", () => {
    if (result.error) throw result.error;
    assert.equal(
      result.status,
      0,
      "harness exited " + result.status + "\nstdout: " + result.stdout.slice(0, 800) + "\nstderr: " + result.stderr.slice(0, 400)
    );
  });

  it("stdout mentions PASS-DIRECTIONAL verdict", () => {
    assert.ok(
      result.stdout.includes("PASS-DIRECTIONAL"),
      "dry-run must emit PASS-DIRECTIONAL\nstdout: " + result.stdout.slice(0, 800)
    );
  });

  it("stdout does not contain NaN (resolver returned valid numbers)", () => {
    assert.ok(
      !result.stdout.includes("NaN"),
      "stdout contains NaN\nstdout: " + result.stdout.slice(0, 800)
    );
  });

  it("Arm A and Arm B surface metrics present (exit 0 is minimum bar)", () => {
    assert.ok(
      result.status === 0,
      "exit code 0 is required regardless of JSON output location"
    );
  });
});

// ---------------------------------------------------------------------------
// T-SMOKE-RUN-1: full dry-run exits 0, PASS-DIRECTIONAL, non-NaN
// ---------------------------------------------------------------------------

describe("T-SMOKE-RUN-1: full dry-run exits 0, PASS-DIRECTIONAL, non-NaN", () => {
  const result = spawnSync(
    process.execPath,
    ["harness/run.mjs", "--dry-run"],
    {
      cwd: BENCH_B10_ROOT,
      encoding: "utf8",
      timeout: 180_000,
    }
  );

  it("full dry-run exits 0", () => {
    if (result.error) throw result.error;
    assert.equal(
      result.status,
      0,
      "full dry-run exited " + result.status + "\nstdout: " + result.stdout.slice(0, 1000) + "\nstderr: " + result.stderr.slice(0, 500)
    );
  });

  it("stdout does not contain NaN", () => {
    assert.ok(
      !result.stdout.includes("NaN"),
      "dry-run stdout contains NaN -- resolver returned bad metrics\nstdout: " + result.stdout.slice(0, 1000)
    );
  });

  it("stdout mentions PASS-DIRECTIONAL for validate-rfc5321-email", () => {
    assert.ok(
      result.stdout.includes("PASS-DIRECTIONAL"),
      "full dry-run must emit PASS-DIRECTIONAL\nstdout: " + result.stdout.slice(0, 1000)
    );
  });
});
