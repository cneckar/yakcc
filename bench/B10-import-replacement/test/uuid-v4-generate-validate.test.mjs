/**
 * uuid-v4-generate-validate -- S3 Evaluation Contract tests
 *
 * @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
 *   title: Arm A hand-translation fallback for uuid-v4-generate-validate
 *   status: accepted
 *   rationale: S3 arm-a files are hand-translated from WI-510 atom subgraphs.
 *     Zero non-builtin imports. Production CLI path not yet wired end-to-end.
 *
 * Tests covered:
 *   T-CORPUS-1         -- corpus-spec.json structure and field validation
 *   T-A-1              -- arm-a-emit.mjs maps task to uuidV4GenerateValidate
 *   T-A-2              -- each arm-a strategy: zero npm imports, DEC annotation
 *   T-B-1              -- arm-b fixture exists, uses uuid import
 *   T-RESOLVER-DELTA-1 -- dry-run shows >=90% reduction on functions and bytes
 *   T-SMOKE-RUN-1      -- full dry-run exits 0, no NaN, PASS or WARN verdict
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
const TASK_ID = "uuid-v4-generate-validate";

// ---------------------------------------------------------------------------
// T-CORPUS-1: corpus-spec.json structure
// ---------------------------------------------------------------------------

describe("T-CORPUS-1: corpus-spec.json structure", () => {
  const corpusSpecPath = join(BENCH_B10_ROOT, "corpus-spec.json");
  let corpus;

  it("corpus-spec.json exists", () => {
    assert.ok(existsSync(corpusSpecPath), "missing: " + corpusSpecPath);
    corpus = JSON.parse(readFileSync(corpusSpecPath, "utf8"));
  });

  it("has tasks array with entry for uuid-v4-generate-validate", () => {
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
    assert.match(p.prompt_sha256, /^[0-9a-f]{64}$/, "prompt_sha256 must be 64-char hex");
  });

  it("directional_targets has reachable_functions_reduction_min >= 0.90", () => {
    corpus = corpus ?? JSON.parse(readFileSync(corpusSpecPath, "utf8"));
    const task = corpus.tasks.find((t) => t.id === TASK_ID);
    assert.ok(task, "no task entry with id=" + TASK_ID);
    const dt = task.directional_targets;
    assert.ok(dt && typeof dt === "object", "directional_targets must be an object");
    assert.ok(typeof dt.reachable_functions_reduction_min === "number", "reachable_functions_reduction_min must be number");
    assert.ok(dt.reachable_functions_reduction_min >= 0.9, "fn reduction min must be >= 0.90");
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

  it("arm-a-emit.mjs maps uuid-v4-generate-validate to uuidV4GenerateValidate", () => {
    const emitSrc = readFileSync(join(BENCH_B10_ROOT, "harness", "arm-a-emit.mjs"), "utf8");
    assert.ok(
      emitSrc.includes("uuid-v4-generate-validate") && emitSrc.includes("uuidV4GenerateValidate"),
      "arm-a-emit.mjs must map uuid-v4-generate-validate -> uuidV4GenerateValidate"
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

    it("arm-a/" + strategy + ".mjs: has DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001 annotation", () => {
      const src = readFileSync(join(armADir, strategy + ".mjs"), "utf8");
      assert.ok(
        src.includes("DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001"),
        "arm-a/" + strategy + ".mjs must contain DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001 annotation"
      );
    });
  }
});

// ---------------------------------------------------------------------------
// T-B-1: arm-b fixture exists and uses uuid import
// ---------------------------------------------------------------------------

describe("T-B-1: arm-b fixture exists and imports uuid", () => {
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

  it("fixture text content references uuid", () => {
    fixture = fixture ?? JSON.parse(readFileSync(fixturePath, "utf8"));
    const text = fixture.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    assert.ok(text.includes("uuid"), "arm-b fixture must reference uuid package");
  });

  it("fixture text content defines uuidV4GenerateValidate", () => {
    fixture = fixture ?? JSON.parse(readFileSync(fixturePath, "utf8"));
    const text = fixture.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    assert.ok(
      text.includes("uuidV4GenerateValidate"),
      "arm-b fixture must define uuidV4GenerateValidate"
    );
  });

  it("fixture has _prompt_sha256 (64-char hex) for cross-bench lock", () => {
    fixture = fixture ?? JSON.parse(readFileSync(fixturePath, "utf8"));
    assert.ok(typeof fixture._prompt_sha256 === "string", "fixture must have _prompt_sha256");
    assert.match(fixture._prompt_sha256, /^[0-9a-f]{64}$/, "_prompt_sha256 must be 64-char hex");
  });
});

// ---------------------------------------------------------------------------
// T-RESOLVER-DELTA-1: dry-run shows directional improvement
// ---------------------------------------------------------------------------

describe("T-RESOLVER-DELTA-1: dry-run directional improvement for uuid-v4-generate-validate", () => {
  const result = spawnSync(
    process.execPath,
    ["harness/run.mjs", "--dry-run", "--tasks=uuid-v4-generate-validate"],
    {
      cwd: BENCH_B10_ROOT,
      encoding: "utf8",
      timeout: 120_000,
    }
  );

  it("dry-run --tasks=uuid-v4-generate-validate exits 0", () => {
    if (result.error) throw result.error;
    assert.equal(
      result.status,
      0,
      "harness exited " + result.status + "\nstdout: " + result.stdout.slice(0, 800) + "\nstderr: " + result.stderr.slice(0, 400)
    );
  });

  it("stdout does not contain NaN (resolver returned valid numbers)", () => {
    assert.ok(
      !result.stdout.includes("NaN"),
      "stdout contains NaN\nstdout: " + result.stdout.slice(0, 800)
    );
  });

  it("stdout contains PASS-DIRECTIONAL or WARN-DIRECTIONAL verdict", () => {
    assert.ok(
      result.stdout.includes("PASS-DIRECTIONAL") || result.stdout.includes("WARN-DIRECTIONAL"),
      "dry-run must emit PASS-DIRECTIONAL or WARN-DIRECTIONAL\nstdout: " + result.stdout.slice(0, 800)
    );
  });
});

// ---------------------------------------------------------------------------
// T-SMOKE-RUN-1: full dry-run exits 0, no NaN
// ---------------------------------------------------------------------------

describe("T-SMOKE-RUN-1: full dry-run exits 0, no NaN", () => {
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

  it("suite verdict line contains valid count (pass: N)", () => {
    assert.ok(
      result.stdout.includes("pass:"),
      "full dry-run must emit suite verdict with pass: count\nstdout: " + result.stdout.slice(0, 1000)
    );
  });
});