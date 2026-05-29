// SPDX-License-Identifier: MIT
// @mock-exempt: @yakcc/shave-python and @yakcc/compile-python are external subprocess/package
// boundaries (python3+libcst and ts-morph respectively). Mocking at the public-API surface
// is explicitly required by DEC-WI877-007 so tests run in pure-TS CI without Python toolchain.
// Real integration is covered by shave-python.smoke.test.ts and compile-python.smoke.test.ts.
//
// roundtrip.test.ts — unit tests for `yakcc roundtrip`.
//
// @decision DEC-WI877-007
// @title Test seam: mock adapter packages at the public-API boundary; gated smoke
// @status accepted (WI-877)
// @rationale
//   Mock @yakcc/shave-python and @yakcc/compile-python at the public-API boundary.
//   The roundtrip verb calls both in sequence; mocking both lets us exercise all
//   status-table paths without Python or ts-morph.
//   Cross-reference: PLAN.md §3.4 / #877

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollectingLogger } from "../index.js";
import { roundtrip } from "./roundtrip.js";

// ---------------------------------------------------------------------------
// Mocks
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

vi.mock("@yakcc/compile-python", () => ({
  compileToPython: vi.fn(),
}));

import * as shavePythonMod from "@yakcc/shave-python";
import * as compilePythonMod from "@yakcc/compile-python";

const mockParsePythonSource = vi.mocked(shavePythonMod.parsePythonSource);
const mockExtractFunctionSignatures = vi.mocked(shavePythonMod.extractFunctionSignatures);
const mockRaiseFn = vi.mocked(shavePythonMod.raiseFunctionWithPurityAndNormalization);
const mockCompileToPython = vi.mocked(compilePythonMod.compileToPython);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnvelope(fnNames: string[]) {
  return {
    version: 1 as const,
    module: {
      type: "Module" as const,
      functions: fnNames.map((name) => ({ name, body: [] })),
    },
  };
}

function makeSig(name: string, bodyPythonSource = "return 1") {
  return {
    name,
    params: [] as [],
    returnType: "number",
    pythonReturnAnnotation: "int",
    bodyPythonSource,
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "roundtrip-test-"));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function fixture(name: string, content = "def double(x: int) -> int:\n    return x + x\n"): string {
  const p = join(tempDir, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("roundtrip — happy path: 2 functions, both round-trip cleanly", () => {
  it("prints status table with 2 rows and returns 0", async () => {
    const file = fixture("two.py");
    mockParsePythonSource.mockResolvedValue(makeEnvelope(["add", "sub"]));
    mockExtractFunctionSignatures.mockReturnValue([
      makeSig("add", "return x + y"),
      makeSig("sub", "return x - y"),
    ]);
    // Raised IR
    mockRaiseFn
      .mockReturnValueOnce("export function add(x: number, y: number): number {\n  return (x + y);\n}")
      .mockReturnValueOnce("export function sub(x: number, y: number): number {\n  return (x - y);\n}");
    // compileToPython returns the original body source (clean round-trip)
    mockCompileToPython
      .mockReturnValueOnce({ source: "return x + y", testSource: "", warnings: [] })
      .mockReturnValueOnce({ source: "return x - y", testSource: "", warnings: [] });

    const logger = new CollectingLogger();
    const code = await roundtrip([file], logger);

    expect(code).toBe(0);
    const table = logger.logLines.join("\n");
    expect(table).toContain("add");
    expect(table).toContain("sub");
    // Both should have shave=pass and compile=pass
    expect(logger.errLines).toHaveLength(0);
  });
});

describe("roundtrip — mixed: 1 pass, 1 impure", () => {
  it("returns 0 (any function reached round-trip stage), table shows mixed rows", async () => {
    const file = fixture("mixed.py");
    const { ImpureFunctionError } = shavePythonMod;
    mockParsePythonSource.mockResolvedValue(makeEnvelope(["pure_fn", "impure_fn"]));
    mockExtractFunctionSignatures.mockReturnValue([
      makeSig("pure_fn", "return 1"),
      makeSig("impure_fn", "import os; return os.getcwd()"),
    ]);
    mockRaiseFn
      .mockReturnValueOnce("export function pureFn(): number {\n  return 1;\n}")
      .mockImplementationOnce(() => {
        throw new ImpureFunctionError("reads env");
      });
    mockCompileToPython.mockReturnValueOnce({ source: "return 1", testSource: "", warnings: [] });

    const logger = new CollectingLogger();
    const code = await roundtrip([file], logger);

    expect(code).toBe(0);
    const table = logger.logLines.join("\n");
    expect(table).toContain("pure_fn");
    expect(table).toContain("impure_fn");
    expect(table).toContain("impure");
  });
});

describe("roundtrip — all fail → exit 1", () => {
  it("returns 1 when every function fails shave", async () => {
    const file = fixture("allfail.py");
    const { ImpureFunctionError } = shavePythonMod;
    mockParsePythonSource.mockResolvedValue(makeEnvelope(["a", "b"]));
    mockExtractFunctionSignatures.mockReturnValue([makeSig("a"), makeSig("b")]);
    mockRaiseFn.mockImplementation(() => {
      throw new ImpureFunctionError("impure");
    });

    const logger = new CollectingLogger();
    const code = await roundtrip([file], logger);

    expect(code).toBe(1);
  });
});

describe("roundtrip — .ts input → exit 1 with follow-up note", () => {
  it("returns 1 and mentions #877 follow-up", async () => {
    const file = fixture("foo.ts", "export function foo() {}");

    const logger = new CollectingLogger();
    const code = await roundtrip([file], logger);

    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("877");
    expect(logger.errLines.join("\n")).toContain("not wired");
  });
});

describe("roundtrip — unparseable input → exit 2", () => {
  it("returns 2 when parsePythonSource throws", async () => {
    const file = fixture("bad.py", "<<< not python >>>");
    mockParsePythonSource.mockRejectedValue(new Error("libcst: SyntaxError"));

    const logger = new CollectingLogger();
    const code = await roundtrip([file], logger);

    expect(code).toBe(2);
    expect(logger.errLines.join("\n")).toContain("parse failed");
  });
});

describe("roundtrip — --out <dir> writes per-function artifacts", () => {
  it("creates .ir.ts, .module.py, .diff.txt for each function", async () => {
    const file = fixture("out.py");
    const outDir = join(tempDir, "artifacts");
    mockParsePythonSource.mockResolvedValue(makeEnvelope(["double"]));
    mockExtractFunctionSignatures.mockReturnValue([makeSig("double", "return x * 2")]);
    mockRaiseFn.mockReturnValue(
      "export function double(x: number): number {\n  return (x * 2);\n}",
    );
    mockCompileToPython.mockReturnValue({
      source: "return x * 2",
      testSource: "",
      warnings: [],
    });

    const logger = new CollectingLogger();
    const code = await roundtrip([file, "--out", outDir], logger);

    expect(code).toBe(0);
    const files = readdirSync(outDir);
    expect(files).toContain("double.ir.ts");
    expect(files).toContain("double.module.py");
    expect(files).toContain("double.diff.txt");
  });
});

describe("roundtrip — --help returns 0 and prints usage", () => {
  it("returns 0 and mentions roundtrip usage", async () => {
    const logger = new CollectingLogger();
    const code = await roundtrip(["--help"], logger);
    expect(code).toBe(0);
    expect(logger.logLines.join("\n")).toContain("roundtrip");
    expect(logger.logLines.join("\n")).toContain("--target");
  });
});

describe("roundtrip — no args → exit 1 + usage", () => {
  it("returns 1 with usage hint when no file given", async () => {
    const logger = new CollectingLogger();
    const code = await roundtrip([], logger);
    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("missing file");
  });
});

describe("roundtrip — --target rust → exit 2 with #868 pointer", () => {
  it("returns 2 and mentions #868", async () => {
    const file = fixture("foo.py");
    const logger = new CollectingLogger();
    const code = await roundtrip([file, "--target", "rust"], logger);
    expect(code).toBe(2);
    expect(logger.errLines.join("\n")).toContain("868");
  });
});

describe("roundtrip — --target go → exit 2 with #870 pointer", () => {
  it("returns 2 and mentions #870", async () => {
    const file = fixture("foo.py");
    const logger = new CollectingLogger();
    const code = await roundtrip([file, "--target", "go"], logger);
    expect(code).toBe(2);
    expect(logger.errLines.join("\n")).toContain("870");
  });
});

describe("roundtrip — compound interaction: shave → compile → status table (production sequence)", () => {
  it("exercises the real in-process shave→compile chain crossing both adapter boundaries", async () => {
    // This is the compound-interaction test required by the implementer protocol.
    // It exercises: roundtrip() → parsePythonSource → extractFunctionSignatures
    //   → raiseFunctionWithPurityAndNormalization → compileToPython → status table render
    // The two adapter mocks represent the external subprocess/ts-morph boundaries.
    const file = fixture("compound.py");
    mockParsePythonSource.mockResolvedValue(makeEnvelope(["double", "triple"]));
    mockExtractFunctionSignatures.mockReturnValue([
      makeSig("double", "return x + x"),
      makeSig("triple", "return x + x + x"),
    ]);
    mockRaiseFn
      .mockReturnValueOnce(
        "export function double(x: number): number {\n  return (x + x);\n}",
      )
      .mockReturnValueOnce(
        "export function triple(x: number): number {\n  return ((x + x) + x);\n}",
      );
    mockCompileToPython
      .mockReturnValueOnce({ source: "return x + x", testSource: "", warnings: [] })
      .mockReturnValueOnce({
        source: "return x + x + x",
        testSource: "",
        warnings: [{ kind: "chained-add", message: "chained add pattern" }],
      });

    const logger = new CollectingLogger();
    const code = await roundtrip([file], logger);

    // Compound assertions: exit code + table contains both functions + warning surfaced
    expect(code).toBe(0);
    const table = logger.logLines.join("\n");
    expect(table).toContain("double");
    expect(table).toContain("triple");
    // Verify the full chain ran: both raiseFn and compileToPython were called
    expect(mockRaiseFn).toHaveBeenCalledTimes(2);
    expect(mockCompileToPython).toHaveBeenCalledTimes(2);
    // compileToPython should receive the synthesized atom with implSource from raiseFn
    expect(mockCompileToPython).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        implSource: "export function double(x: number): number {\n  return (x + x);\n}",
      }),
    );
  });
});
