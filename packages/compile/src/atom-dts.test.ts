// SPDX-License-Identifier: MIT
//
// atom-dts.test.ts — tests for generateAtomDts (#1046, DEC-COMPOSE-BY-REF-DTS-001)
//
// Evaluation Contract requirements covered:
//   EC-1: ascii-char-like spec → exact expected export declare signature
//   EC-2: zero outputs → ": void"
//   EC-3: multiple outputs → positional tuple
//   EC-4: missing param name → synthesise arg0, arg1, …
//   EC-5 (compound): the generated .d.ts actually typechecks a consumer that
//         imports the declared symbol — with NO impl present, only the .d.ts.
//         This is the core acceptance: reference source typechecks pre-build.
//   EC-6: malformed spec (missing inputs/outputs) → loud Error, no silent default

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SpecYak } from "@yakcc/contracts";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateAtomDts } from "./atom-dts.js";

// ---------------------------------------------------------------------------
// Shared fixture specs (built inline — no file IO dependency)
// ---------------------------------------------------------------------------

/** ascii-char-equivalent spec: 2 inputs, 1 output (matches seeds/ascii-char/spec.yak) */
const ASCII_CHAR_SPEC: SpecYak = {
  name: "ascii-char",
  inputs: [
    { name: "input", type: "string", description: "The full input string." },
    { name: "position", type: "number", description: "Zero-based index to read from." },
  ],
  outputs: [{ name: "char", type: "string", description: "Single character at position." }],
  preconditions: [],
  postconditions: [],
  invariants: [],
  effects: [],
  level: "L0",
};

/** No-output spec: pure side-effect function */
const VOID_OUTPUT_SPEC: SpecYak = {
  name: "log-message",
  inputs: [{ name: "msg", type: "string" }],
  outputs: [],
  preconditions: [],
  postconditions: [],
  invariants: [],
  effects: [],
  level: "L0",
};

/** Multi-output spec: returns a tuple */
const MULTI_OUTPUT_SPEC: SpecYak = {
  name: "split-pair",
  inputs: [{ name: "src", type: "string" }],
  outputs: [
    { name: "left", type: "string" },
    { name: "right", type: "number" },
  ],
  preconditions: [],
  postconditions: [],
  invariants: [],
  effects: [],
  level: "L0",
};

/** Spec with inputs that have empty/missing names → triggers name synthesis */
const UNNAMED_PARAMS_SPEC: SpecYak = {
  name: "unnamed-params",
  inputs: [
    { name: "", type: "boolean" },
    { name: "", type: "number" },
  ],
  outputs: [{ name: "result", type: "boolean" }],
  preconditions: [],
  postconditions: [],
  invariants: [],
  effects: [],
  level: "L0",
};

// ---------------------------------------------------------------------------
// EC-1: ascii-char exact output assertion
// ---------------------------------------------------------------------------

describe("generateAtomDts — EC-1: ascii-char exact output", () => {
  it("produces the exact export declare signature for ascii-char", () => {
    const dts = generateAtomDts(ASCII_CHAR_SPEC, "asciiChar");

    // The declaration line must be exactly this — single source of truth for consumers.
    expect(dts).toContain(
      "export declare function asciiChar(input: string, position: number): string;",
    );

    // Must end with a trailing newline (determinism requirement).
    expect(dts.endsWith("\n")).toBe(true);

    // Header comment must be present (identifies generator + decision ref).
    expect(dts).toContain("DEC-COMPOSE-BY-REF-DTS-001");
    expect(dts).toContain("yakcc build");
  });

  it("is deterministic: same spec+symbol always produces identical text", () => {
    const first = generateAtomDts(ASCII_CHAR_SPEC, "asciiChar");
    const second = generateAtomDts(ASCII_CHAR_SPEC, "asciiChar");
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// EC-2: zero outputs → void
// ---------------------------------------------------------------------------

describe("generateAtomDts — EC-2: void return type", () => {
  it("emits ': void' when spec has no outputs", () => {
    const dts = generateAtomDts(VOID_OUTPUT_SPEC, "logMessage");
    expect(dts).toContain("export declare function logMessage(msg: string): void;");
  });
});

// ---------------------------------------------------------------------------
// EC-3: multiple outputs → tuple
// ---------------------------------------------------------------------------

describe("generateAtomDts — EC-3: multi-output tuple", () => {
  it("emits a positional tuple when spec has multiple outputs", () => {
    const dts = generateAtomDts(MULTI_OUTPUT_SPEC, "splitPair");
    expect(dts).toContain("export declare function splitPair(src: string): [string, number];");
  });
});

// ---------------------------------------------------------------------------
// EC-4: name synthesis for unnamed params
// ---------------------------------------------------------------------------

describe("generateAtomDts — EC-4: unnamed param synthesis", () => {
  it("synthesises arg0, arg1, … for params with empty name", () => {
    const dts = generateAtomDts(UNNAMED_PARAMS_SPEC, "myFn");
    expect(dts).toContain("export declare function myFn(arg0: boolean, arg1: number): boolean;");
  });
});

// ---------------------------------------------------------------------------
// EC-6: loud failure on malformed spec
// ---------------------------------------------------------------------------

describe("generateAtomDts — EC-6: loud failure on malformed spec", () => {
  it("throws when spec.inputs is not an array", () => {
    const bad = { ...ASCII_CHAR_SPEC, inputs: null as unknown as SpecYak["inputs"] };
    expect(() => generateAtomDts(bad, "fn")).toThrow(/spec\.inputs must be an array/);
  });

  it("throws when spec.outputs is not an array", () => {
    const bad = { ...ASCII_CHAR_SPEC, outputs: undefined as unknown as SpecYak["outputs"] };
    expect(() => generateAtomDts(bad, "fn")).toThrow(/spec\.outputs must be an array/);
  });

  it("throws when symbol is empty", () => {
    expect(() => generateAtomDts(ASCII_CHAR_SPEC, "")).toThrow(/symbol must be a non-empty string/);
  });
});

// ---------------------------------------------------------------------------
// EC-5 (compound): the generated .d.ts typechecks a consumer with NO impl present
//
// This is the core acceptance test for #1046. The production sequence is:
//   1. yakcc_reference emits `import { asciiChar } from ".yakcc/atoms/<alias>"`
//   2. The project typechecks BEFORE `yakcc build` has run (no .ts impl)
//   3. Only the .d.ts is present — tsc must find zero errors
//
// Strategy: write the .d.ts and a tiny consumer to a temp dir in project tmp/,
// then run TypeScript's programmatic API (createProgram) and assert zero diagnostics.
// The `typescript` package is already a dep (used by build.test.ts).
// ---------------------------------------------------------------------------

// Path back to worktree root's tmp/ (Sacred Practice #3 — no /tmp/).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TMP_BASE = join(__dirname, "../../../../tmp");

let tempDir: string;

beforeEach(() => {
  mkdirSync(TMP_BASE, { recursive: true });
  tempDir = mkdtempSync(join(TMP_BASE, "atom-dts-typecheck-"));
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Non-fatal cleanup — test isolation is already provided by unique tempDir.
  }
});

describe("generateAtomDts — EC-5: no-impl typecheck proof", () => {
  it("generated .d.ts typechecks a consumer with only the .d.ts present (no impl)", () => {
    // 1. Generate the .d.ts for asciiChar.
    const dtsText = generateAtomDts(ASCII_CHAR_SPEC, "asciiChar");

    // 2. Write the .d.ts to temp dir as the module declaration file.
    //    The consumer imports from "./m" — so the .d.ts must be "m.d.ts".
    const dtsPath = join(tempDir, "m.d.ts");
    writeFileSync(dtsPath, dtsText, "utf-8");

    // 3. Write a tiny consumer that imports and uses the declared symbol.
    //    This mirrors how reference source looks after yakcc_reference (#1047).
    const consumerSrc = [
      `import { asciiChar } from "./m";`,
      `const c: string = asciiChar("hello", 0);`,
      "void c;",
    ].join("\n");
    const consumerPath = join(tempDir, "consumer.ts");
    writeFileSync(consumerPath, consumerSrc, "utf-8");

    // 4. Run TypeScript's programmatic API.
    //    No tsconfig needed — supply compiler options directly.
    const program = ts.createProgram([consumerPath, dtsPath], {
      noEmit: true,
      strict: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      skipLibCheck: false,
    });

    const diagnostics = ts.getPreEmitDiagnostics(program);

    // 5. Assert zero errors — the .d.ts alone makes the consumer typecheck.
    if (diagnostics.length > 0) {
      const messages = ts
        .formatDiagnosticsWithColorAndContext(diagnostics, {
          getCanonicalFileName: (f) => f,
          getCurrentDirectory: () => tempDir,
          getNewLine: () => "\n",
        })
        .trim();
      // Fail with the full diagnostic output so failures are self-explanatory.
      throw new Error(
        `Expected zero TypeScript diagnostics with only .d.ts present, but got:\n${messages}`,
      );
    }

    expect(diagnostics.length).toBe(0);
  });

  it("type error is caught when consumer uses wrong argument type", () => {
    // Regression: the typecheck proof only counts if the .d.ts actually enforces types.
    // Pass a number where string is required → must produce a diagnostic.
    const dtsText = generateAtomDts(ASCII_CHAR_SPEC, "asciiChar");
    const dtsPath = join(tempDir, "m.d.ts");
    writeFileSync(dtsPath, dtsText, "utf-8");

    const badConsumerSrc = [
      `import { asciiChar } from "./m";`,
      // Wrong: first arg should be string, not number.
      "const c: string = asciiChar(42, 0);",
      "void c;",
    ].join("\n");
    const consumerPath = join(tempDir, "consumer.ts");
    writeFileSync(consumerPath, badConsumerSrc, "utf-8");

    const program = ts.createProgram([consumerPath, dtsPath], {
      noEmit: true,
      strict: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    });

    const diagnostics = ts.getPreEmitDiagnostics(program);
    // The .d.ts declares `input: string` — passing `42` (number) MUST be an error.
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});
