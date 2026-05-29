// SPDX-License-Identifier: MIT
// @mock-exempt: @yakcc/shave-python is an external subprocess boundary (python3 + libcst).
// Mocking at the public-API surface is explicitly required by DEC-WI877-007 so the
// CLI unit tests run in pure-TS CI without Python toolchain.  The real subprocess
// integration is covered by shave-python.smoke.test.ts (gated on YAKCC_SKIP_PYTHON_SMOKE).
//
// shave-python.test.ts — unit tests for runShavePython.
//
// Mocks @yakcc/shave-python at the public-API boundary per DEC-WI877-007.
// No subprocess spawn — tests run in pure-TS CI.
//
// @decision DEC-WI877-007
// @title Test seam: mock adapter packages at the public-API boundary; gated smoke
// @status accepted (WI-877)
// @rationale
//   Fast tests; no subprocess spawn.  vi.mock intercepts the shave-python imports
//   before module evaluation.  The mock is reset between tests via vi.clearAllMocks().
//   Cross-reference: PLAN.md §3.4 / #877

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollectingLogger } from "../index.js";
import type { ShavePythonArgs } from "./shave-python.js";
import { runShavePython } from "./shave-python.js";

// ---------------------------------------------------------------------------
// Mock @yakcc/shave-python at the public-API boundary
// ---------------------------------------------------------------------------

vi.mock("@yakcc/shave-python", () => {
  class ImpureFunctionError extends Error {
    constructor(message?: string) {
      super(message ?? "impure");
      this.name = "ImpureFunctionError";
    }
  }
  class UnsupportedAstError extends Error {
    constructor(public readonly reason: string) {
      super(reason);
      this.name = "UnsupportedAstError";
    }
  }
  class UnsupportedTypeError extends Error {
    constructor(
      public readonly pythonType: string,
      message?: string,
    ) {
      super(message ?? pythonType);
      this.name = "UnsupportedTypeError";
    }
  }
  class MissingTypeAnnotationError extends Error {
    constructor(
      public readonly functionName: string,
      public readonly paramName: string | null,
      message?: string,
    ) {
      super(message ?? `missing annotation on ${functionName}`);
      this.name = "MissingTypeAnnotationError";
    }
  }
  return {
    parsePythonSource: vi.fn(),
    extractFunctionSignatures: vi.fn(),
    raiseFunctionWithPurityAndNormalization: vi.fn(),
    ImpureFunctionError,
    UnsupportedAstError,
    UnsupportedTypeError,
    MissingTypeAnnotationError,
  };
});

// Import the mocked module.
import * as shavePythonMod from "@yakcc/shave-python";
const mockParsePythonSource = vi.mocked(shavePythonMod.parsePythonSource);
const mockExtractFunctionSignatures = vi.mocked(shavePythonMod.extractFunctionSignatures);
const mockRaiseFunctionWithPurityAndNormalization = vi.mocked(
  shavePythonMod.raiseFunctionWithPurityAndNormalization,
);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Minimal LibcstParseResult envelope with named function records. */
function makeEnvelope(fnNames: string[]) {
  return {
    version: 1 as const,
    module: {
      type: "Module" as const,
      functions: fnNames.map((name) => ({ name, body: [] })),
    },
  };
}

/** Minimal FunctionSignature stub. */
function makeSig(name: string) {
  return {
    name,
    params: [] as [],
    returnType: "number",
    pythonReturnAnnotation: "int",
    bodyPythonSource: "return 1",
  };
}

/** Build a ShavePythonArgs with sane defaults. */
function args(filePath: string, overrides?: Partial<ShavePythonArgs>): ShavePythonArgs {
  return {
    filePath,
    functionFilter: undefined,
    out: undefined,
    ignoredForeignPolicy: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "shave-python-test-"));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Write a tiny fixture .py to tempDir so readFileSync succeeds. */
function fixture(name: string, content = "def double(x: int) -> int:\n    return x + x\n"): string {
  const p = join(tempDir, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runShavePython — happy path: 2-function fixture", () => {
  it("logs both IR blocks with banners and returns 0", async () => {
    const file = fixture("two.py");
    mockParsePythonSource.mockResolvedValue(makeEnvelope(["add", "sub"]));
    mockExtractFunctionSignatures.mockReturnValue([makeSig("add"), makeSig("sub")]);
    mockRaiseFunctionWithPurityAndNormalization
      .mockReturnValueOnce("export function add(x: number): number {\n  return x;\n}")
      .mockReturnValueOnce("export function sub(x: number): number {\n  return x;\n}");

    const logger = new CollectingLogger();
    const code = await runShavePython(args(file), logger);

    expect(code).toBe(0);
    expect(logger.errLines).toHaveLength(0);
    const allLog = logger.logLines.join("\n");
    expect(allLog).toContain("// ---- function: add ----");
    expect(allLog).toContain("// ---- function: sub ----");
    expect(allLog).toContain("export function add");
    expect(allLog).toContain("export function sub");
  });
});

describe("runShavePython — --out <file> writes concatenated IR", () => {
  it("writes IR to file and returns 0", async () => {
    const file = fixture("single.py");
    const outFile = join(tempDir, "out.ir.ts");

    mockParsePythonSource.mockResolvedValue(makeEnvelope(["double"]));
    mockExtractFunctionSignatures.mockReturnValue([makeSig("double")]);
    mockRaiseFunctionWithPurityAndNormalization.mockReturnValue(
      "export function double(x: number): number {\n  return (x + x);\n}",
    );

    const logger = new CollectingLogger();
    const code = await runShavePython(args(file, { out: outFile }), logger);

    expect(code).toBe(0);
    const written = readFileSync(outFile, "utf-8");
    expect(written).toContain("export function double");
  });
});

describe("runShavePython — --out <dir> writes one file per function", () => {
  it("creates <fn>.ir.ts for each function in the directory, returns 0", async () => {
    const file = fixture("multi.py");
    // Trailing slash → directory target
    const outDir = join(tempDir, "out") + "/";

    mockParsePythonSource.mockResolvedValue(makeEnvelope(["alpha", "beta"]));
    mockExtractFunctionSignatures.mockReturnValue([makeSig("alpha"), makeSig("beta")]);
    mockRaiseFunctionWithPurityAndNormalization
      .mockReturnValueOnce("export function alpha(): number {\n  return 1;\n}")
      .mockReturnValueOnce("export function beta(): number {\n  return 2;\n}");

    const logger = new CollectingLogger();
    const code = await runShavePython(args(file, { out: outDir }), logger);

    expect(code).toBe(0);
    const files = readdirSync(outDir.replace(/\/$/, ""));
    expect(files).toContain("alpha.ir.ts");
    expect(files).toContain("beta.ir.ts");
    expect(readFileSync(join(outDir, "alpha.ir.ts"), "utf-8")).toContain("export function alpha");
    expect(readFileSync(join(outDir, "beta.ir.ts"), "utf-8")).toContain("export function beta");
  });
});

describe("runShavePython — --function <name> filter", () => {
  it("processes only the named function and returns 0", async () => {
    const file = fixture("filter.py");
    mockParsePythonSource.mockResolvedValue(makeEnvelope(["alpha", "beta"]));
    mockExtractFunctionSignatures.mockReturnValue([makeSig("alpha"), makeSig("beta")]);
    mockRaiseFunctionWithPurityAndNormalization.mockReturnValue(
      "export function alpha(): number {\n  return 1;\n}",
    );

    const logger = new CollectingLogger();
    const code = await runShavePython(args(file, { functionFilter: "alpha" }), logger);

    expect(code).toBe(0);
    expect(mockRaiseFunctionWithPurityAndNormalization).toHaveBeenCalledTimes(1);
    expect(logger.logLines.join("\n")).toContain("export function alpha");
    expect(logger.logLines.join("\n")).not.toContain("export function beta");
  });

  it("returns 1 when the named function is not found", async () => {
    const file = fixture("nofunction.py");
    mockParsePythonSource.mockResolvedValue(makeEnvelope(["alpha"]));
    mockExtractFunctionSignatures.mockReturnValue([makeSig("alpha")]);

    const logger = new CollectingLogger();
    const code = await runShavePython(args(file, { functionFilter: "notexist" }), logger);

    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("notexist");
  });
});

describe("runShavePython — per-function failure: one impure, one pure", () => {
  it("continues after impure function, emits IR for pure function, returns 0", async () => {
    const file = fixture("mixed.py");
    const { ImpureFunctionError } = shavePythonMod;
    mockParsePythonSource.mockResolvedValue(makeEnvelope(["impure_fn", "pure_fn"]));
    mockExtractFunctionSignatures.mockReturnValue([makeSig("impure_fn"), makeSig("pure_fn")]);
    mockRaiseFunctionWithPurityAndNormalization
      .mockImplementationOnce(() => {
        throw new ImpureFunctionError("impure_fn", "forbidden_call", "reads global state");
      })
      .mockReturnValueOnce("export function pureFn(): number {\n  return 1;\n}");

    const logger = new CollectingLogger();
    const code = await runShavePython(args(file), logger);

    expect(code).toBe(0);
    expect(logger.errLines.join("\n")).toContain("impure_fn");
    expect(logger.errLines.join("\n")).toContain("impure");
    expect(logger.logLines.join("\n")).toContain("export function pureFn");
  });
});

describe("runShavePython — all functions failed → exit 1", () => {
  it("returns 1 when every function throws ImpureFunctionError", async () => {
    const file = fixture("allfail.py");
    const { ImpureFunctionError } = shavePythonMod;
    mockParsePythonSource.mockResolvedValue(makeEnvelope(["a", "b"]));
    mockExtractFunctionSignatures.mockReturnValue([makeSig("a"), makeSig("b")]);
    mockRaiseFunctionWithPurityAndNormalization.mockImplementation(() => {
      throw new ImpureFunctionError("impure_fn", "forbidden_call", "impure");
    });

    const logger = new CollectingLogger();
    expect(await runShavePython(args(file), logger)).toBe(1);
  });
});

describe("runShavePython — parse-level failure → exit 2", () => {
  it("returns 2 and emits structured stderr when parsePythonSource throws", async () => {
    const file = fixture("bad.py");
    mockParsePythonSource.mockRejectedValue(new Error("libcst: SyntaxError at line 3"));

    const logger = new CollectingLogger();
    const code = await runShavePython(args(file), logger);

    expect(code).toBe(2);
    expect(logger.errLines.join("\n")).toContain("parse failed");
    expect(logger.errLines.join("\n")).toContain("libcst");
  });
});

describe("runShavePython — --out <file> + multi-function input + no --function → error", () => {
  it("returns 1 with structured error message", async () => {
    const file = fixture("multi2.py");
    const outFile = join(tempDir, "out.ir.ts");

    mockParsePythonSource.mockResolvedValue(makeEnvelope(["a", "b"]));
    mockExtractFunctionSignatures.mockReturnValue([makeSig("a"), makeSig("b")]);

    const logger = new CollectingLogger();
    const code = await runShavePython(args(file, { out: outFile }), logger);

    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("--out must be a directory");
    expect(logger.errLines.join("\n")).toContain(outFile);
  });
});

describe("runShavePython — --foreign-policy ignored warning", () => {
  it("emits warning when ignoredForeignPolicy is true", async () => {
    const file = fixture("warn.py");
    mockParsePythonSource.mockResolvedValue(makeEnvelope(["fn1"]));
    mockExtractFunctionSignatures.mockReturnValue([makeSig("fn1")]);
    mockRaiseFunctionWithPurityAndNormalization.mockReturnValue(
      "export function fn1(): number {\n  return 1;\n}",
    );

    const logger = new CollectingLogger();
    const code = await runShavePython(args(file, { ignoredForeignPolicy: true }), logger);

    expect(code).toBe(0);
    expect(logger.errLines.join("\n")).toContain("--foreign-policy ignored for --target python");
  });
});
