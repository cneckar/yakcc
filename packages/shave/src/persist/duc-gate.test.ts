// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import {
  DucGateRejection,
  type DucGateResult,
  atomDefinedNames,
  collectInternalSymbols,
  ducGateModeFromEnv,
  enforceDucGate,
  runDucConservationGate,
} from "./duc-gate.js";

const CLOSED = "export function f(a: number, b: number): number { return a + b; }";
const FREE = "export function f(x: number): number { return helper(x); }";
const FOREIGN =
  'import { readFileSync } from "node:fs";\nexport function f(p: string): string { return readFileSync(p); }';
const AMBIENT = "export function f(x: number): number { return Math.abs(x); }";
const SYNTAX_ERROR = "export function f( {";

/** Collect warnings emitted by the gate. */
function withWarnings(): { warn: (m: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m) => messages.push(m), messages };
}

describe("runDucConservationGate", () => {
  it("reports a closed atom with no unknowns", () => {
    const result = runDucConservationGate(CLOSED);
    expect(result.wellFormed).toBe(true);
    expect(result.unknowns).toEqual([]);
    expect(result.unexplained).toEqual([]);
    expect(result.liftError).toBeUndefined();
  });

  it("classifies a free identifier as unexplained", () => {
    const result = runDucConservationGate(FREE);
    expect(result.unknowns.map((u) => u.symbol)).toEqual(["helper"]);
    expect(result.unexplained.map((u) => u.symbol)).toEqual(["helper"]);
  });

  it("records a foreign import as a known (not unexplained) unknown with its module", () => {
    const result = runDucConservationGate(FOREIGN);
    expect(result.unknowns).toContainEqual({
      symbol: "readFileSync",
      reason: "foreign-import",
      module: "node:fs",
    });
    expect(result.unexplained).toEqual([]);
  });

  it("records an ambient global as a known unknown", () => {
    const result = runDucConservationGate(AMBIENT);
    expect(result.unknowns).toContainEqual({ symbol: "Math", reason: "ambient-read" });
    expect(result.unexplained).toEqual([]);
  });

  it("degrades to a recorded liftError on a syntax error (never throws)", () => {
    const result = runDucConservationGate(SYNTAX_ERROR);
    expect(result.wellFormed).toBe(false);
    expect(result.liftError).toBeDefined();
  });
});

describe("enforceDucGate — warn mode (default rollout)", () => {
  it("admits an atom with an unexplained reference but warns loudly", () => {
    const { warn, messages } = withWarnings();
    const { ducUsupp, result } = enforceDucGate(FREE, "add one via helper", "warn", warn);
    expect(result.unexplained).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("helper");
    expect(messages[0]).toContain("admitted");
    // usupp is recorded regardless of mode
    const parsed = JSON.parse(ducUsupp ?? "null") as { unknowns: unknown[] };
    expect(parsed.unknowns).toHaveLength(1);
  });

  it("admits a foreign-only atom silently and still records usupp", () => {
    const { warn, messages } = withWarnings();
    const { ducUsupp } = enforceDucGate(FOREIGN, "read a file", "warn", warn);
    expect(messages).toEqual([]); // foreign imports are declared, not a problem
    expect(ducUsupp).not.toBeNull();
    expect(JSON.parse(ducUsupp as string)).toMatchObject({
      unknowns: [{ symbol: "readFileSync", module: "node:fs" }],
    });
  });

  it("admits a closed atom with null usupp and no warning", () => {
    const { warn, messages } = withWarnings();
    const { ducUsupp } = enforceDucGate(CLOSED, "add", "warn", warn);
    expect(ducUsupp).toBeNull();
    expect(messages).toEqual([]);
  });

  it("warns and records the liftError for an unliftable fragment", () => {
    const { warn, messages } = withWarnings();
    const { ducUsupp } = enforceDucGate(SYNTAX_ERROR, "broken", "warn", warn);
    expect(messages[0]).toContain("could not be lifted");
    expect(JSON.parse(ducUsupp as string)).toMatchObject({ wellFormed: false });
  });
});

describe("enforceDucGate — reject mode", () => {
  it("throws DucGateRejection on an unexplained reference", () => {
    let thrown: unknown;
    try {
      enforceDucGate(FREE, "add one via helper", "reject");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DucGateRejection);
    const result = (thrown as DucGateRejection).result as DucGateResult;
    expect(result.unexplained.map((u) => u.symbol)).toEqual(["helper"]);
  });

  it("throws on an unliftable fragment", () => {
    expect(() => enforceDucGate(SYNTAX_ERROR, "broken", "reject")).toThrow(DucGateRejection);
  });

  it("admits a foreign-only atom (declared unknowns are not rejected)", () => {
    expect(() => enforceDucGate(FOREIGN, "read a file", "reject")).not.toThrow();
  });
});

describe("composition-edge resolution (WI-EXPLAIN-01, #1170)", () => {
  it("atomDefinedNames extracts top-level function/const/class names (bare or exported)", () => {
    expect(atomDefinedNames("function getLens(b64) { return b64; }")).toEqual(["getLens"]);
    expect(atomDefinedNames("export const lookup = [];")).toEqual(["lookup"]);
    expect(atomDefinedNames("export async function f() {}\nclass C {}")).toEqual(["f", "C"]);
    // a nested declaration is not a top-level binding
    expect(atomDefinedNames("function outer() { function inner() {} return inner; }")).toEqual([
      "outer",
    ]);
  });

  it("collectInternalSymbols unions every atom's defined names across the forest", () => {
    const forest = [
      "function getLens(b64) { return b64; }",
      "function byteLength(b64) { return getLens(b64); }",
    ];
    expect([...collectInternalSymbols(forest)].sort()).toEqual(["byteLength", "getLens"]);
  });

  it("classifies a sibling reference as a composition edge, not unexplained", () => {
    // `byteLength` calls sibling `getLens` — with getLens in the internal set it is
    // an internal composition edge, so unexplained is empty.
    const src = "export function byteLength(b64: string): number { return getLens(b64); }";
    const result = runDucConservationGate(src, new Set(["getLens"]));
    expect(result.unexplained).toEqual([]);
    expect(result.composition.map((u) => u.symbol)).toEqual(["getLens"]);
    // still recorded in the full unknown-support, flagged as composition
    expect(result.unknowns).toContainEqual({
      symbol: "getLens",
      reason: "free-identifier",
      composition: true,
    });
  });

  it("without an internal set, the same reference stays unexplained (pre-#1170 behavior)", () => {
    const src = "export function byteLength(b64: string): number { return getLens(b64); }";
    const result = runDucConservationGate(src);
    expect(result.unexplained.map((u) => u.symbol)).toEqual(["getLens"]);
    expect(result.composition).toEqual([]);
  });

  it("splits mixed references: sibling → composition, genuine free-id → unexplained", () => {
    // `getLens` is a sibling; `Arr` is a genuine external capture.
    const src =
      "export function toByteArray(b64: string): unknown { return new Arr(getLens(b64)); }";
    const result = runDucConservationGate(src, new Set(["getLens"]));
    expect(result.composition.map((u) => u.symbol)).toEqual(["getLens"]);
    expect(result.unexplained.map((u) => u.symbol)).toEqual(["Arr"]);
  });

  it("reject mode admits an atom whose only free references are composition edges", () => {
    const src = "export function byteLength(b64: string): number { return getLens(b64); }";
    expect(() =>
      enforceDucGate(src, "byte length", "reject", undefined, new Set(["getLens"])),
    ).not.toThrow();
  });

  it("reject mode still throws when a genuine free-id remains alongside a composition edge", () => {
    const src =
      "export function toByteArray(b64: string): unknown { return new Arr(getLens(b64)); }";
    expect(() =>
      enforceDucGate(src, "to byte array", "reject", undefined, new Set(["getLens"])),
    ).toThrow(DucGateRejection);
  });

  it("records the composition flag in serialized usupp provenance", () => {
    const src = "export function byteLength(b64: string): number { return getLens(b64); }";
    const { ducUsupp } = enforceDucGate(src, "byte length", "warn", () => {}, new Set(["getLens"]));
    const parsed = JSON.parse(ducUsupp as string) as { unknowns: { composition?: boolean }[] };
    expect(parsed.unknowns[0]?.composition).toBe(true);
  });
});

describe("ducGateModeFromEnv", () => {
  it("defaults to warn and only rejects on the explicit opt-in", () => {
    expect(ducGateModeFromEnv({} as NodeJS.ProcessEnv)).toBe("warn");
    expect(ducGateModeFromEnv({ YAKCC_DUC_GATE: "warn" } as NodeJS.ProcessEnv)).toBe("warn");
    expect(ducGateModeFromEnv({ YAKCC_DUC_GATE: "reject" } as NodeJS.ProcessEnv)).toBe("reject");
    expect(ducGateModeFromEnv({ YAKCC_DUC_GATE: "nonsense" } as NodeJS.ProcessEnv)).toBe("warn");
  });
});
