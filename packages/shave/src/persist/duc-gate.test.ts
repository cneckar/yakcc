// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import {
  DucGateRejection,
  type DucGateResult,
  atomDefinedNames,
  collectInternalSymbols,
  ducGateModeFromEnv,
  enforceDucGate,
  externalSurfaceOf,
  moduleBindingsOf,
  runDucConservationGate,
} from "./duc-gate.js";
import { enclosingBindingsOf } from "./module-bindings.js";

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
      reason: "unlinked-reference",
      module: "node:fs",
    });
    expect(result.unexplained).toEqual([]);
  });

  it("records an ambient global as a known unknown", () => {
    const result = runDucConservationGate(AMBIENT);
    expect(result.unknowns).toContainEqual({ symbol: "Math", reason: "platform-primitive" });
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

  it("admits a closed atom with no warning; the sidecar records an empty usupp and its attestation", () => {
    const { warn, messages } = withWarnings();
    const { ducUsupp } = enforceDucGate(CLOSED, "add", "warn", warn);
    expect(messages).toEqual([]);
    const parsed = JSON.parse(ducUsupp as string) as {
      unknowns: unknown[];
      attestations: { duc_influence: { kind: string; matrix: boolean[][] } };
    };
    expect(parsed.unknowns).toEqual([]);
    expect(parsed.attestations.duc_influence.kind).toBe("duc_influence");
    expect(parsed.attestations.duc_influence.matrix).toEqual([[true], [true]]);
  });

  it("an unliftable fragment has no attestation in its sidecar", () => {
    const { ducUsupp } = enforceDucGate(SYNTAX_ERROR, "broken", "warn", () => {});
    const parsed = JSON.parse(ducUsupp as string) as { attestations?: unknown };
    expect(parsed.attestations).toBeUndefined();
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
  it("defaults to reject; only an explicit warn admits a problem (DEC-DUC-GATE-REJECT-001)", () => {
    expect(ducGateModeFromEnv({} as NodeJS.ProcessEnv)).toBe("reject");
    expect(ducGateModeFromEnv({ YAKCC_DUC_GATE: "warn" } as NodeJS.ProcessEnv)).toBe("warn");
    expect(ducGateModeFromEnv({ YAKCC_DUC_GATE: "reject" } as NodeJS.ProcessEnv)).toBe("reject");
    // A typo fails closed.
    expect(ducGateModeFromEnv({ YAKCC_DUC_GATE: "nonsense" } as NodeJS.ProcessEnv)).toBe("reject");
  });
});

describe("module-scope captures (DEC-DUC-MODULE-CAPTURE-001, #1171)", () => {
  const MODULE = [
    "const TABLE = [1, 2, 3];",
    "var MUTABLE_TABLE = [];",
    "let COUNTER = 1;",
    "const COMPUTED = build();",
    "const OBJ = { a: 1, b: [2] };",
    "const WITH_METHOD = { f() { return 1; } };",
    "export function grow() { MUTABLE_TABLE.push(4); COUNTER++; }",
    "export function read(i: number): number { return TABLE[i]; }",
  ].join("\n");

  it("classifies const literals pure and everything else mutable", () => {
    const b = moduleBindingsOf(MODULE);
    expect(b.get("TABLE")?.binding).toBe("pure");
    expect(b.get("OBJ")?.binding).toBe("pure");
    expect(b.get("MUTABLE_TABLE")?.binding).toBe("mutable"); // var
    expect(b.get("COUNTER")?.binding).toBe("mutable"); // let
    expect(b.get("COMPUTED")?.binding).toBe("mutable"); // call initializer
    expect(b.get("WITH_METHOD")?.binding).toBe("pure"); // a method that reads nothing, with no call or hand-off site
  });

  it("a var or let literal that is never mutated is pure (the rule is mutation, not the keyword)", () => {
    expect(moduleBindingsOf("var T = [1, 2];").get("T")?.binding).toBe("pure");
    expect(moduleBindingsOf("let T = 'x';").get("T")?.binding).toBe("pure");
  });

  it("a top-level function is pure when everything it reads is pure, and captured as such", () => {
    const b = moduleBindingsOf("const T = [1];\nfunction lookup(i: number) { return T[i]; }");
    expect(b.get("lookup")?.binding).toBe("pure");
    expect(b.get("lookup")?.declHash).toMatch(/^[0-9a-f]{64}$/);
    const result = runDucConservationGate(
      "function f(i: number) { return lookup(i); }",
      new Set(),
      b,
    );
    expect(result.unexplained).toEqual([]);
    expect(result.captures.map((c) => c.symbol)).toEqual(["lookup"]);
  });

  it("a function that reads a mutable binding is mutable, transitively", () => {
    const b = moduleBindingsOf(
      "let M = 0;\nfunction bump() { M++; }\nfunction a() { return b(); }\nfunction b() { return M; }",
    );
    expect(b.get("b")?.binding).toBe("mutable");
    expect(b.get("a")?.binding).toBe("mutable"); // a reaches b, which reaches mutable M
  });

  it("mutually recursive functions with no impure read are pure", () => {
    const b = moduleBindingsOf(
      "function a(n: number): number { return n ? b(n - 1) : 0; }\nfunction b(n: number): number { return a(n); }",
    );
    expect(b.get("a")?.binding).toBe("pure");
    expect(b.get("b")?.binding).toBe("pure");
  });

  it("a function that is mutated in its module is not pure", () => {
    const b = moduleBindingsOf("function g() { return 1; }\ng = () => 2;");
    expect(b.get("g")?.binding).toBe("mutable");
  });

  it("a function reading a foreign import is pure (the read is explained by the import)", () => {
    const b = moduleBindingsOf(
      'import { readFileSync } from "node:fs";\nfunction r(p: string) { return readFileSync(p); }',
    );
    expect(b.get("r")?.binding).toBe("pure");
  });

  it("records a dead unresolved use, not only ones that reach an observation", () => {
    const result = runDucConservationGate("function f(a: number) { dead(); return a; }");
    expect(result.unexplained.map((u) => u.symbol)).toContain("dead");
  });

  it("a non-global regex and a function passed as a callback stay pure; a global regex does not", () => {
    const b = moduleBindingsOf(
      [
        "var hasTilde = /~/;",
        "var escapeMatcher = /~[01]/g;",
        "function replacer(m: string) { return m; }",
        "export function untilde(s: string) {",
        "  if (!hasTilde.test(s)) return s;",
        "  return s.replace(escapeMatcher, replacer);",
        "}",
      ].join("\n"),
    );
    expect(b.get("hasTilde")?.binding).toBe("pure"); // .test() on a non-global regex is inert
    expect(b.get("replacer")?.binding).toBe("pure"); // passed as a callback: a function is not mutated by that
    expect(b.get("escapeMatcher")?.binding).toBe("mutable"); // a global regex carries lastIndex state
  });

  it("a binding mutated from inside a function, aliased, or handed off is not pure", () => {
    expect(moduleBindingsOf("const T = [];\nfunction g() { T[0] = 1; }").get("T")?.binding).toBe(
      "mutable",
    );
    expect(moduleBindingsOf("const T = [];\nfunction g() { T.push(1); }").get("T")?.binding).toBe(
      "mutable",
    );
    expect(moduleBindingsOf("const T = [];\nconst U = T;").get("T")?.binding).toBe("mutable"); // alias
    expect(moduleBindingsOf("const T = [];\nf(T);").get("T")?.binding).toBe("mutable"); // hand-off
    expect(moduleBindingsOf("const T = {a:1};\nfunction g() { T.a++; }").get("T")?.binding).toBe(
      "mutable",
    );
  });

  it("a binding filled by top-level writes during module initialization is pure (init closure)", () => {
    // base64-js shape: a table built by a loop at module top level, then read by functions.
    const b = moduleBindingsOf(
      [
        "var lookup = [];",
        "var code = 'ABCD';",
        "for (var i = 0; i < code.length; i++) { lookup[i] = code[i]; }",
        "lookup.push('z');",
        "export function read(k) { return lookup[k]; }",
      ].join("\n"),
    );
    expect(b.get("lookup")?.binding).toBe("pure");
    expect(b.get("code")?.binding).toBe("pure");
  });

  it("a top-level write that reads an unexplained name does not make the binding pure", () => {
    const b = moduleBindingsOf(
      "var T = [];\nT[0] = secretFetch();\nexport function r(i) { return T[i]; }",
    );
    expect(b.get("T")?.binding).toBe("mutable");
  });

  it("a typed-array initializer is pure: its reads are ambient builtins", () => {
    const b = moduleBindingsOf("var A = typeof Uint8Array !== 'undefined' ? Uint8Array : Array;");
    expect(b.get("A")?.binding).toBe("pure");
  });

  it("plain reads do not disqualify a pure const", () => {
    const b = moduleBindingsOf("const T = [1, 2];\nexport const x = T[0] + T.length;");
    expect(b.get("T")?.binding).toBe("pure");
  });

  it("gives every binding a stable declaration hash", () => {
    const a = moduleBindingsOf(MODULE).get("TABLE")?.declHash;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(moduleBindingsOf(MODULE).get("TABLE")?.declHash).toBe(a);
  });

  it("a free read of a pure module constant is a recorded capture, not unexplained", () => {
    const bindings = moduleBindingsOf(MODULE);
    const src = "function pick(i: number): number { return TABLE[i]; }";
    const result = runDucConservationGate(src, new Set(), bindings);
    expect(result.unexplained).toEqual([]);
    expect(result.captures.map((c) => c.symbol)).toEqual(["TABLE"]);
    expect(result.captures[0]?.declHash).toBe(bindings.get("TABLE")?.declHash);
  });

  it("a free read of a mutable module binding is recorded module state (#1266)", () => {
    const bindings = moduleBindingsOf(MODULE);
    const src = "function pick(i: number): number { return MUTABLE_TABLE[i]; }";
    const result = runDucConservationGate(src, new Set(), bindings);
    expect(result.unexplained).toEqual([]);
    expect(result.captures).toEqual([]);
    expect(result.moduleState.map((u) => u.symbol)).toEqual(["MUTABLE_TABLE"]);
    expect(result.moduleState[0]?.declHash).toBe(bindings.get("MUTABLE_TABLE")?.declHash);
  });

  it("reject mode admits an atom whose only free reference is a pure capture", () => {
    const bindings = moduleBindingsOf(MODULE);
    const src = "function pick(i: number): number { return TABLE[i]; }";
    expect(() =>
      enforceDucGate(src, "pick", "reject", undefined, new Set(), bindings),
    ).not.toThrow();
  });

  it("reject mode admits an atom that reads module state, and the sidecar records it (#1266)", () => {
    const bindings = moduleBindingsOf(MODULE);
    const src = "function pick(i: number): number { return COUNTER + i; }";
    const { ducUsupp } = enforceDucGate(src, "pick", "reject", undefined, new Set(), bindings);
    const surface = externalSurfaceOf(ducUsupp);
    expect(surface?.moduleState.map((m) => m.symbol)).toEqual(["COUNTER"]);
    expect(surface?.unexplained).toEqual([]);
  });

  it("reject mode still rejects a free name the module does not declare", () => {
    const bindings = moduleBindingsOf(MODULE);
    const src = "function pick(i: number): number { return NOT_DECLARED + i; }";
    expect(() => enforceDucGate(src, "pick", "reject", undefined, new Set(), bindings)).toThrow(
      DucGateRejection,
    );
  });

  it("records the capture and its declaration hash in the sidecar", () => {
    const bindings = moduleBindingsOf(MODULE);
    const src = "function pick(i: number): number { return TABLE[i]; }";
    const { ducUsupp } = enforceDucGate(src, "pick", "warn", () => {}, new Set(), bindings);
    const parsed = JSON.parse(ducUsupp as string) as {
      captures: { symbol: string; declHash: string }[];
    };
    expect(parsed.captures).toEqual([
      { symbol: "TABLE", declHash: bindings.get("TABLE")?.declHash },
    ]);
  });

  it("a composition edge takes precedence over a module binding of the same name", () => {
    const bindings = moduleBindingsOf("const sib = [1];");
    const result = runDucConservationGate(
      "function f(): number { return sib; }",
      new Set(["sib"]),
      bindings,
    );
    expect(result.composition.map((u) => u.symbol)).toEqual(["sib"]);
    expect(result.captures).toEqual([]);
  });
});

describe("external surface from the sidecar (WI-EXPLAIN-03, #1172)", () => {
  it("lists the explained residual: foreign imports with their module, and ambient reads", () => {
    const { ducUsupp } = enforceDucGate(
      'import { readFileSync } from "node:fs";\nexport function f(p: string): string { return Math.max(0, readFileSync(p).length) + ""; }',
      "read",
      "warn",
      () => {},
    );
    const surface = externalSurfaceOf(ducUsupp);
    expect(surface?.foreign).toEqual([{ symbol: "readFileSync", module: "node:fs" }]);
    expect(surface?.ambient).toEqual(["Math"]);
    expect(surface?.unexplained).toEqual([]);
  });

  it("separates captures, compositions, and the unexplained remainder", () => {
    const bindings = moduleBindingsOf("const TABLE = [1];");
    const { ducUsupp } = enforceDucGate(
      "function f(i: number) { return sib(TABLE[i]) + DANGLING; }",
      "f",
      "warn",
      () => {},
      new Set(["sib"]),
      bindings,
    );
    const surface = externalSurfaceOf(ducUsupp);
    expect(surface?.captures.map((c) => c.symbol)).toEqual(["TABLE"]);
    expect(surface?.compositions).toEqual(["sib"]);
    expect(surface?.unexplained).toEqual(["DANGLING"]);
  });

  it("an atom with no unknowns has an empty surface; a missing sidecar has none", () => {
    const { ducUsupp } = enforceDucGate(
      "export function f(a: number) { return a; }",
      "f",
      "warn",
      () => {},
    );
    expect(externalSurfaceOf(ducUsupp)).toEqual({
      foreign: [],
      ambient: [],
      captures: [],
      moduleState: [],
      moduleScope: [],
      requires: [],
      compositions: [],
      unexplained: [],
    });
    expect(externalSurfaceOf(null)).toBeNull();
    expect(externalSurfaceOf("not json")).toBeNull();
  });
});

describe("report wording is structural, not feasibility (WI-GUARD A4, #1257)", () => {
  it("the gate warning states a structural finding and does not claim feasibility", () => {
    const messages: string[] = [];
    enforceDucGate("export function f(x: number): number { return helper(x); }", "f", "warn", (m) =>
      messages.push(m),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("unresolved references with no declared source");
    expect(messages[0]).toContain("structural finding, not a feasibility claim");
    expect(messages[0]).not.toMatch(/exploit|vulnerab|will be reached/i);
  });
});

// Pinned behaviour for two open items on the module-binding classifier. These record
// what the classifier does today; they do not change it. See #1266 (mutable module
// state has no capture policy) and #1267 (the initialization-closure window).
describe("module-binding classification pins (#1266 mutable state, #1267 init window)", () => {
  it("#1266: a binding written from a function after its initializer stays mutable", () => {
    const b = moduleBindingsOf("const T = [];\nexport function grow() { T.push(1); }");
    expect(b.get("T")?.binding).toBe("mutable");
  });
  it("#1266: a counter bumped inside a function stays mutable", () => {
    const b = moduleBindingsOf("let C = 0;\nexport function bump() { C++; }");
    expect(b.get("C")?.binding).toBe("mutable");
  });
  it("#1267: an initializer that reads a later-declared binding is conservatively mutable", () => {
    const b = moduleBindingsOf("const A = B + 1;\nconst B = 2;\nexport const out = A;");
    expect(b.get("A")?.binding).toBe("mutable"); // read before init within the module
    expect(b.get("B")?.binding).toBe("pure");
  });
  it("#1267: an initializer that reads an imported name is conservatively mutable (cycle window)", () => {
    const b = moduleBindingsOf(
      "import { x } from './other.js';\nconst A = x + 1;\nexport const out = A;",
    );
    expect(b.get("A")?.binding).toBe("mutable");
  });
  it("#1267: a call to a module-local pure function in an initializer is pure", () => {
    const b = moduleBindingsOf("function mk() { return 3; }\nconst A = mk();");
    expect(b.get("A")?.binding).toBe("pure");
  });
});

describe("primitive initializers are inert under hand-off (ms unit constants)", () => {
  it("an arithmetic initializer over a pure constant stays pure when passed to a call", () => {
    const b = moduleBindingsOf("var s = 1000;\nvar m = s * 60;\nexport const r = g(m);");
    expect(b.get("m")?.binding).toBe("pure");
    expect(b.get("s")?.binding).toBe("pure");
  });
  it("a chain of primitive arithmetic is pure", () => {
    const b = moduleBindingsOf("const A = 2;\nconst B = A * A + 1;\nexport const r = g(B);");
    expect(b.get("B")?.binding).toBe("pure");
  });
  it("a primitive that is written later stays mutable", () => {
    const b = moduleBindingsOf("let C = 1 + 1;\nexport function bump() { C++; }");
    expect(b.get("C")?.binding).toBe("mutable");
  });
  it("an object initializer is still mutable under hand-off", () => {
    const b = moduleBindingsOf("const O = [];\nexport const r = g(O);");
    expect(b.get("O")?.binding).toBe("mutable");
  });
});

describe("CommonJS module scope (#1173, DEC-DUC-MODULE-SCOPE-001)", () => {
  const bindings = moduleBindingsOf("const T = 1;\nexports.x = T;");
  it("in a module, exports, module and literal requires are the module's, with its dependencies", () => {
    const src =
      'const jws = require("jws");\nconst t = require("./lib/timespan");\nmodule.exports = function (a) { return jws(t(a)); };\nexports.y = 1;';
    const { ducUsupp, result } = enforceDucGate(src, "m", "reject", undefined, new Set(), bindings);
    expect(result.unexplained).toEqual([]);
    expect(result.moduleScope.map((u) => u.symbol).sort()).toEqual([
      "exports",
      "module",
      "require",
    ]);
    const surface = externalSurfaceOf(ducUsupp);
    expect(surface?.requires).toEqual(["jws", "./lib/timespan"]);
    expect(surface?.moduleScope.sort()).toEqual(["exports", "module", "require"]);
  });
  it("a require with a computed specifier stays unexplained", () => {
    const src = "function load(name) { return require(name); }";
    const result = runDucConservationGate(src, new Set(), bindings);
    expect(result.unexplained.map((u) => u.symbol)).toEqual(["require"]);
  });
  it("without a module, the names are unexplained as before", () => {
    const result = runDucConservationGate('exports.y = require("x");');
    expect(result.unexplained.map((u) => u.symbol).sort()).toEqual(["exports", "require"]);
  });
});

describe("CommonJS imports and destructured declarations bind module names (#1173)", () => {
  it("a destructured require binds each name as an import", () => {
    const b = moduleBindingsOf(
      'const { FLAG_LOOSE, safeRe: re } = require("../internal/constants");\nconst ms = require("ms");',
    );
    expect(b.get("FLAG_LOOSE")?.binding).toBe("pure");
    expect(b.get("re")?.binding).toBe("pure");
    expect(b.get("ms")?.binding).toBe("pure");
    const src = "function f(o) { return (o.loose && FLAG_LOOSE) || re; }";
    expect(runDucConservationGate(src, new Set(), b).unexplained).toEqual([]);
  });
  it("a destructuring declaration binds each of its names", () => {
    const b = moduleBindingsOf("const { a, b: [c] } = { a: 1, b: [2] };\nexports.x = a;");
    expect(b.has("a")).toBe(true);
    expect(b.has("c")).toBe(true);
  });
});

describe("feature detection and lift fidelity (#1173)", () => {
  it("a name the atom only probes for with typeof is explained, not a hole", () => {
    const umd =
      "function wrap (factory) { if (typeof define === 'function' && define.amd) define([], factory); else return factory(); }";
    const r = runDucConservationGate(umd);
    expect(r.unexplained).toEqual([]);
    expect(r.unknowns.find((u) => u.symbol === "define")?.probe).toBe(true);
  });
  it("a probe must test that the name is present: a test for its absence explains nothing", () => {
    const wrong =
      "function f () { if (typeof define === 'undefined') return define.amd; return 1 }";
    expect(runDucConservationGate(wrong).unexplained.map((u) => u.symbol)).toEqual(["define"]);
  });
  it("a read inside a try is not a probe: the catch would hide a real hole", () => {
    const hidden = "function f (x) { try { return helper(x) } catch (e) { return null } }";
    expect(runDucConservationGate(hidden).unexplained.map((u) => u.symbol)).toEqual(["helper"]);
  });
  it("a web global is a platform primitive of the web target, not unexplained", () => {
    const r = runDucConservationGate(
      "function rand (n) { var a = new Uint32Array(n); (self.crypto || self.msCrypto).getRandomValues(a); return a }",
    );
    expect(r.unexplained).toEqual([]);
  });
  it("every lift is checked for fidelity, and a faithful one holds", () => {
    const r = runDucConservationGate("function f (a) { return helper(a) + K }");
    expect(r.fidelity).toEqual({ holds: true, missing: [], extra: [] });
  });
});

describe("a fragment sliced from a function body reads its enclosing scope (#1297)", () => {
  const MODULE = [
    "export async function renameWithRetry(src: string, dst: string): Promise<void> {",
    "  for (let attempt = 0; attempt < 3; attempt++) {",
    "    try {",
    "      await rename(src, dst);",
    "      return;",
    "    } catch (err) {",
    "      const last = attempt === 2;",
    "      if (last) throw err;",
    "    }",
    "  }",
    "}",
  ].join("\n");
  const fragment = "      const last = attempt === 2;";
  const start = MODULE.indexOf(fragment);
  const range = { start, end: start + fragment.length };

  it("enclosingBindingsOf: the parameters, the loop's variable, the catch's, the block's own", () => {
    const names = enclosingBindingsOf(MODULE, range);
    for (const n of ["src", "dst", "attempt", "err", "last"]) expect(names.has(n)).toBe(true);
    // A module's top level is not an enclosing scope: its bindings are the module's.
    expect(names.has("renameWithRetry")).toBe(false);
    expect(enclosingBindingsOf(MODULE, { start: 0, end: MODULE.length }).size).toBe(0);
  });

  it("the gate records a read of an enclosing binding, and rejects nothing for it", () => {
    const src = "await rename(src, dst);";
    const callStart = MODULE.indexOf(src);
    const enclosing = enclosingBindingsOf(MODULE, {
      start: callStart,
      end: callStart + src.length,
    });
    const result = runDucConservationGate(src, new Set(["rename"]), undefined, enclosing);
    expect(result.unexplained).toEqual([]);
    expect(result.enclosing.map((u) => u.symbol).sort()).toEqual(["dst", "src"]);
    const { ducUsupp } = enforceDucGate(
      src,
      "frag",
      "reject",
      () => {},
      new Set(["rename"]),
      undefined,
      enclosing,
    );
    expect(JSON.parse(ducUsupp as string).enclosing.sort()).toEqual(["dst", "src"]);
  });

  it("without the enclosing scope, the same reads stay unexplained", () => {
    const result = runDucConservationGate("await rename(src, dst);", new Set(["rename"]));
    expect(result.unexplained.map((u) => u.symbol).sort()).toEqual(["dst", "src"]);
  });
});

describe("TypeScript's types are not reads (#1297)", () => {
  it("a type alias, an interface, type-only and re-export lists, and type positions are closed", () => {
    for (const src of [
      'export type GateMode = "warn" | "reject";',
      "export interface CacheKey { readonly sourceHash: string; readonly model: Model }",
      'export type { A, B } from "./types.js";',
      'export { parse, Parser } from "./api.js";',
      "export function f(r: Record<string, Hash>): Tree { return r as unknown as Tree; }",
      "export class A implements Shape { area(): Area { return 1 as Area; } }",
    ]) {
      const result = runDucConservationGate(src);
      expect([src, result.unexplained]).toEqual([src, []]);
      expect([src, result.fidelity?.holds]).toEqual([src, true]);
    }
  });
});
