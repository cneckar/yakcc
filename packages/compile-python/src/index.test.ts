// SPDX-License-Identifier: MIT
import type { BlockTripletRow } from "@yakcc/registry";
import type { BlockMerkleRoot, CanonicalAstHash, SpecHash } from "@yakcc/registry";
import { describe, expect, it } from "vitest";
import { classMethToSnake, compileToPython, toSnakeCase } from "./index.js";

// ---------------------------------------------------------------------------
// Minimal BlockTripletRow stub for tests
// ---------------------------------------------------------------------------

function makeRow(
  implSource: string,
  artifacts: Map<string, Uint8Array> = new Map(),
): BlockTripletRow {
  return {
    blockMerkleRoot: "dead" as BlockMerkleRoot,
    specHash: "dead" as SpecHash,
    specCanonicalBytes: new Uint8Array(),
    implSource,
    proofManifestJson: "{}",
    level: "L0",
    createdAt: 0,
    canonicalAstHash: "dead" as CanonicalAstHash,
    artifacts,
  };
}

// ---------------------------------------------------------------------------
// Helper to extract the first meaningful Python lines (skip imports)
// ---------------------------------------------------------------------------

function extractBody(source: string): string[] {
  return source.split("\n").filter((l) => l.trim().length > 0);
}

// ---------------------------------------------------------------------------
// 1. toSnakeCase unit tests
// ---------------------------------------------------------------------------

describe("toSnakeCase", () => {
  it("converts camelCase to snake_case", () => {
    expect(toSnakeCase("digitOrThrow")).toBe("digit_or_throw");
    expect(toSnakeCase("eofCheck")).toBe("eof_check");
    expect(toSnakeCase("peekChar")).toBe("peek_char");
    expect(toSnakeCase("commaSeparatedIntegers")).toBe("comma_separated_integers");
  });

  it("leaves already-snake identifiers unchanged", () => {
    expect(toSnakeCase("pos")).toBe("pos");
    expect(toSnakeCase("value")).toBe("value");
    expect(toSnakeCase("digit")).toBe("digit");
  });

  it("handles consecutive capitals (acronyms)", () => {
    expect(toSnakeCase("parseJSON")).toBe("parse_json");
    expect(toSnakeCase("toHTML")).toBe("to_html");
  });
});

// ---------------------------------------------------------------------------
// 2. digit — basic function with throw
// ---------------------------------------------------------------------------

describe("compileToPython — digit", () => {
  const src = `
export function digit(s: string): number {
  if (s.length !== 1 || s < "0" || s > "9") {
    throw new RangeError(\`Not a digit: \${JSON.stringify(s)}\`);
  }
  return s.charCodeAt(0) - 48;
}`;

  it("emits a def with correct signature", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("def digit(s: str) -> float:");
  });

  it("lowers charCodeAt(0) to ord()", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("ord(s)");
  });

  it("lowers throw to raise", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("raise RangeError");
  });

  it("lowers JSON.stringify to repr", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("repr(s)");
  });

  it("emits number→float warning", () => {
    const { warnings } = compileToPython(makeRow(src));
    expect(warnings.some((w) => w.kind === "number-to-float")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. eofCheck — void return, RangeError and SyntaxError
// ---------------------------------------------------------------------------

describe("compileToPython — eofCheck", () => {
  const src = `
export function eofCheck(input: string, position: number): void {
  if (position > input.length) {
    throw new RangeError(\`Position \${position} overruns input of length \${input.length}\`);
  }
  if (position < input.length) {
    throw new SyntaxError(
      \`Expected end of input at position \${position} but found \${JSON.stringify(input.slice(position))}\`,
    );
  }
}`;

  it("emits correct signature with None return", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("def eof_check(input: str, position: float) -> None:");
  });

  it("lowers len(input) for .length access", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("len(input)");
  });

  it("lowers template literal to f-string", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain('f"');
  });
});

// ---------------------------------------------------------------------------
// 4. peekChar — T | null return type
// ---------------------------------------------------------------------------

describe("compileToPython — peekChar", () => {
  const src = `
export function peekChar(input: string, position: number): string | null {
  if (position < 0) {
    throw new RangeError(\`Position \${position} is negative\`);
  }
  if (position >= input.length) {
    return null;
  }
  return input[position] as string;
}`;

  it("emits Optional[str] return type", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("Optional[str]");
    expect(source).toContain("from typing import Optional");
  });

  it("lowers null to None", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("return None");
  });

  it("lowers element access", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("input[position]");
  });
});

// ---------------------------------------------------------------------------
// 5. Simple map() → list comprehension
// ---------------------------------------------------------------------------

describe("compileToPython — map comprehension", () => {
  const src = `
export function doubleAll(xs: number[]): number[] {
  return xs.map((x) => x * 2);
}`;

  it("lowers map to list comprehension", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("[x * 2 for x in xs]");
  });

  it("uses list[float] for number[]", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("list[float]");
  });
});

// ---------------------------------------------------------------------------
// 6. filter() → list comprehension
// ---------------------------------------------------------------------------

describe("compileToPython — filter comprehension", () => {
  const src = `
export function positives(xs: number[]): number[] {
  return xs.filter((x) => x > 0);
}`;

  it("lowers filter to list comprehension with if", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("[x for x in xs if x > 0]");
  });
});

// ---------------------------------------------------------------------------
// 7. reduce() → functools.reduce
// ---------------------------------------------------------------------------

describe("compileToPython — reduce", () => {
  const src = `
export function sumAll(xs: number[]): number {
  return xs.reduce((acc, x) => acc + x, 0);
}`;

  it("lowers reduce to functools.reduce", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("functools.reduce");
    expect(source).toContain("import functools");
  });

  it("emits lambda with correct body", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("lambda acc, x: acc + x");
  });
});

// ---------------------------------------------------------------------------
// 8. Ternary expression
// ---------------------------------------------------------------------------

describe("compileToPython — ternary", () => {
  const src = `
export function absVal(x: number): number {
  return x < 0 ? -x : x;
}`;

  it("lowers ternary to Python conditional expression", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("if x < 0 else");
  });
});

// ---------------------------------------------------------------------------
// 9. Record<string, V> → dict[str, V]
// ---------------------------------------------------------------------------

describe("compileToPython — Record type", () => {
  const src = `
export function countChars(s: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    const prev = (result[c] ?? 0) as number;
    result[c] = prev + 1;
  }
  return result;
}`;

  it("lowers Record<string, number> to dict[str, float]", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("dict[str, float]");
  });
});

// ---------------------------------------------------------------------------
// 10. While loop with push → append
// ---------------------------------------------------------------------------

describe("compileToPython — while + push", () => {
  const src = `
export function collectDigits(input: string, pos: number): number[] {
  const values: number[] = [];
  let p = pos;
  while (p < input.length) {
    const c = input[p] as string;
    if (c < "0" || c > "9") break;
    values.push(c.charCodeAt(0) - 48);
    p++;
  }
  return values;
}`;

  it("lowers push to append", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("values.append");
  });

  it("lowers while loop", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("while p < len(input):");
  });

  it("lowers break", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("break");
  });
});

// ---------------------------------------------------------------------------
// 11. boolean operators
// ---------------------------------------------------------------------------

describe("compileToPython — boolean operators", () => {
  const src = `
export function both(a: boolean, b: boolean): boolean {
  return a && b;
}`;

  it("lowers && to and", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("a and b");
  });
});

describe("compileToPython — logical or", () => {
  const src = `
export function either(a: boolean, b: boolean): boolean {
  return a || b;
}`;

  it("lowers || to or", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("a or b");
  });
});

// ---------------------------------------------------------------------------
// 12. readonly tuple return
// ---------------------------------------------------------------------------

describe("compileToPython — readonly tuple", () => {
  const src = `
export function digitOrThrow(input: string, position: number): readonly [number, number] {
  if (position < 0) {
    throw new RangeError(\`Position \${position} is negative\`);
  }
  const c = input[position] as string;
  if (c < "0" || c > "9") {
    throw new SyntaxError(\`Expected digit at position \${position} but found \${JSON.stringify(c)}\`);
  }
  return [c.charCodeAt(0) - 48, position + 1] as const;
}`;

  it("emits tuple return type", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("tuple[float, float]");
  });

  it("converts function name to snake_case", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("def digit_or_throw(");
  });
});

// ---------------------------------------------------------------------------
// 13. hypothesis test emission when proof/properties.json present
// ---------------------------------------------------------------------------

describe("compileToPython — hypothesis test emission", () => {
  const propertiesJson = JSON.stringify({
    schemaVersion: 1,
    properties: [
      {
        name: "non-negative output",
        inputs: [{ name: "x", generator: { kind: "float", min: 0, max: 100 } }],
        assertion: { kind: "gte", expected: { kind: "literal", value: 0 } },
      },
    ],
  });

  const src = `
export function half(x: number): number {
  return x / 2;
}`;

  it("emits hypothesis test when proof/properties.json present", () => {
    const artifacts = new Map([
      ["proof/properties.json", new TextEncoder().encode(propertiesJson)],
    ]);
    const { testSource } = compileToPython(makeRow(src, artifacts));
    expect(testSource).toContain("from hypothesis import given");
    expect(testSource).toContain("def test_half_");
    expect(testSource).toContain("assert");
  });

  it("returns empty testSource when no proof/properties.json", () => {
    const { testSource } = compileToPython(makeRow(src));
    expect(testSource).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 14. !== lowered to !=
// ---------------------------------------------------------------------------

describe("compileToPython — strict inequality", () => {
  const src = `
export function notOne(x: number): boolean {
  return x !== 1;
}`;

  it("lowers !== to !=", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("!=");
    expect(source).not.toContain("!==");
  });
});

// ---------------------------------------------------------------------------
// 15. true/false literals
// ---------------------------------------------------------------------------

describe("compileToPython — boolean literals", () => {
  const src = `
export function alwaysTrue(): boolean {
  return true;
}`;

  it("lowers true to True", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("return True");
  });
});

// ---------------------------------------------------------------------------
// #915 — Inverse type map: TS type names → Python types
// ---------------------------------------------------------------------------

describe("compileToPython — #915 Uint8Array → bytes", () => {
  const src = `
export function toBytes(s: Uint8Array): Uint8Array {
  return s;
}`;

  it("lowers Uint8Array parameter type to bytes", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("s: bytes");
  });

  it("lowers Uint8Array return type to bytes", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("-> bytes");
  });
});

describe("compileToPython — #915 Callable type", () => {
  const src = `
export function applyFn(fn: (a: string, b: number) => boolean): boolean {
  return fn("x", 1);
}`;

  it("lowers function type to Callable[[...], R]", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("Callable[[str, float], bool]");
  });

  it("adds Callable import to preamble when Callable is used", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("from typing import Callable");
  });
});

describe("compileToPython — #915 Uint8Array in union (Optional[bytes])", () => {
  const src = `
export function maybeBytes(s: Uint8Array | null): Uint8Array | null {
  return s;
}`;

  it("lowers Uint8Array | null to Optional[bytes]", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("Optional[bytes]");
  });
});

// ---------------------------------------------------------------------------
// #916 — Destructured for-of: [k, v] → bare tuple target
// ---------------------------------------------------------------------------

describe("compileToPython — #916 destructured for-of no brackets", () => {
  const src = `
export function invertKeys(d: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) {
    result[v] = k;
  }
  return result;
}`;

  it("emits 'for k, v in' without brackets around target", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("for k, v in");
    expect(source).not.toContain("for [k, v] in");
  });
});

describe("compileToPython — #916 map with destructured arrow → dict comprehension", () => {
  const src = `
export function invert(d: Record<string, string>): Record<string, string> {
  return Object.fromEntries(d.entries().map(([k, v]) => [v, k]));
}`;

  it("map with destructured [k,v] arrow emits for k, v in (no brackets)", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).not.toContain("for [k, v] in");
    expect(source).not.toContain("for [k, v]");
  });
});

// ---------------------------------------------------------------------------
// #917 — === null / !== null → is None / is not None
// ---------------------------------------------------------------------------

describe("compileToPython — #917 === null → is None", () => {
  const src = `
export function isNull(x: string | null): boolean {
  return x === null;
}`;

  it("lowers '=== null' to 'is None'", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("is None");
    expect(source).not.toContain("== None");
  });
});

describe("compileToPython — #917 !== null → is not None", () => {
  const src = `
export function notNull(x: string | null): boolean {
  return x !== null;
}`;

  it("lowers '!== null' to 'is not None'", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("is not None");
    expect(source).not.toContain("!= None");
  });
});

describe("compileToPython — #917 === non-null is unchanged", () => {
  const src = `
export function sameStr(a: string, b: string): boolean {
  return a === b;
}`;

  it("lowers '=== non-null' to '==' (not 'is')", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("a == b");
    expect(source).not.toContain("a is b");
  });
});

describe("compileToPython — #917 null on left side → is None", () => {
  const src = `
export function nullLeft(x: string | null): boolean {
  return null === x;
}`;

  it("lowers 'null ===' to 'is None' (null on left)", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("is None");
    expect(source).not.toContain("== None");
  });
});

// ---------------------------------------------------------------------------
// Compound interaction: #915 + #916 + #917 bs4 _invert round-trip pattern
// ---------------------------------------------------------------------------

describe("compileToPython — compound bs4 _invert round-trip pattern", () => {
  // Mirrors the _invert function from beautifulsoup4 as raised to TS-subset IR
  const src = `
export function invertMap(d: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v !== null) {
      result[v as string] = k;
    }
  }
  return result;
}`;

  it("emits 'for k, v in' without brackets (cross-boundary: #916 + #915)", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("for k, v in");
    expect(source).not.toContain("for [k, v] in");
  });

  it("emits 'is not None' for !== null check (#917)", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("is not None");
    expect(source).not.toContain("!= None");
  });

  it("emits dict[str, Any] for Record<string, unknown> (#915)", () => {
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("dict[str, Any]");
  });
});

// ---------------------------------------------------------------------------
// #941: classMethToSnake — compile-python reverse mapping for class/method identifiers
// ---------------------------------------------------------------------------
// classMethToSnake splits "ClassName_methodName" (the shave-python encoding) back
// to "ClassName.method_name" on the compile (Python output) side.
//
// Detection rule: identifier matches ^([A-Z][A-Za-z0-9]*)_([a-z][A-Za-z0-9]*)$
// — UpperCamelCase LHS, single underscore separator, lowerCamelCase RHS.
// Plain snake / leading-underscore identifiers pass through toSnakeCase unchanged.
// ---------------------------------------------------------------------------

describe("#941: classMethToSnake — class/method boundary splitting", () => {
  it("splits UpperCamelCase_lowerCamelCase at class/method boundary", () => {
    // "EntitySubstitution_substituteXml" → "EntitySubstitution.substitute_xml"
    expect(classMethToSnake("EntitySubstitution_substituteXml")).toBe(
      "EntitySubstitution.substitute_xml",
    );
  });

  it("splits Tag_fromMarkup → Tag.from_markup", () => {
    expect(classMethToSnake("Tag_fromMarkup")).toBe("Tag.from_markup");
  });

  it("leaves plain camelCase (no underscore) as snake_case", () => {
    // "substituteXml" → "substitute_xml" — no class boundary
    expect(classMethToSnake("substituteXml")).toBe("substitute_xml");
  });

  it("leaves already-snake module-level names unchanged", () => {
    expect(classMethToSnake("normalize_tag")).toBe("normalize_tag");
    expect(classMethToSnake("get_attr")).toBe("get_attr");
  });

  it("passes leading-underscore names through toSnakeCase (private fn, not class)", () => {
    // "_invert" → "_invert" (already snake, leading underscore → plain)
    expect(classMethToSnake("_invert")).toBe("_invert");
    // "_chardetDammit" → "_chardet_dammit" (leading underscore → toSnakeCase, not class boundary)
    expect(classMethToSnake("_chardetDammit")).toBe("_chardet_dammit");
  });

  it("round-trips the shave-python encoding end-to-end", () => {
    // shave encodes "EntitySubstitution.substitute_xml" as "EntitySubstitution_substituteXml";
    // compile decodes back with classMethToSnake.
    expect(classMethToSnake("EntitySubstitution_substituteXml")).toBe(
      "EntitySubstitution.substitute_xml",
    );
    // Another real bs4 classmethod
    expect(classMethToSnake("Tag_fromMarkup")).toBe("Tag.from_markup");
  });

  it("compound interaction: lowerFunctionDecl keeps underscore form on def line (#946)", () => {
    // #946: Python `def` declarations reject dotted names — `def A.b(…)` is a SyntaxError.
    // The def line must use the snake_case underscore form; only call sites split to dotted.
    // This crosses compileToPython → lowerFunctionDecl → toSnakeCase (def) / classMethToSnake (calls).
    const src = `
export function EntitySubstitution_substituteXml(cls: typeof EntitySubstitution, value: string): string {
  return value;
}`;
    const { source } = compileToPython(makeRow(src));
    // def line: must use underscore form (valid Python, avoids SyntaxError)
    expect(source).toContain("def entity_substitution_substitute_xml(");
    // Must NOT contain the dotted form on the def line (that would be a SyntaxError)
    expect(source).not.toContain("def EntitySubstitution.substitute_xml(");
  });
});

// ---------------------------------------------------------------------------
// #960: typeof X type annotation → type[X] (Python class-type annotation)
// ---------------------------------------------------------------------------
// TS `typeof EntitySubstitution` in type position means "the class itself".
// Python's idiomatic annotation is `type[EntitySubstitution]`.
// The old code fell through to the string-literal fallback, emitting
// `"typeof EntitySubstitution"` (a forward-reference string) which is not
// valid Python type syntax.
// ---------------------------------------------------------------------------

describe("#960: typeof X type annotation → type[X]", () => {
  it("lowers typeof SimpleClass → type[SimpleClass] as parameter annotation", () => {
    const src = `
export function factory(cls: typeof Foo): Foo {
  return new Foo();
}`;
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("cls: type[Foo]");
    // Must NOT emit the raw string fallback (the bug)
    expect(source).not.toContain('"typeof Foo"');
    expect(source).not.toContain("typeof Foo");
  });

  it("lowers typeof with combined params — bs4 EntitySubstitution case (#960)", () => {
    // Production sequence: shave-python emits cls: typeof EntitySubstitution;
    // compile-python must lower it to type[EntitySubstitution].
    const src = `
export function EntitySubstitution_substituteXml(cls: typeof EntitySubstitution, value: string, makeUniversalSubstitutions: boolean): string {
  return value;
}`;
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("cls: type[EntitySubstitution]");
    expect(source).toContain("value: str");
    expect(source).toContain("make_universal_substitutions: bool");
    // No string-literal leak
    expect(source).not.toContain('"typeof');
  });

  it("lowers typeof with dotted qualifier — typeof Module.Foo → type[Module.Foo]", () => {
    // typeof on a qualified name: translate the full dotted path verbatim.
    const src = `
export function make(cls: typeof bs4.Tag): bs4.Tag {
  return new bs4.Tag();
}`;
    const { source } = compileToPython(makeRow(src));
    expect(source).toContain("cls: type[bs4.Tag]");
    expect(source).not.toContain('"typeof');
  });

  it("compound interaction: typeof cls annotation + correct def name (end-to-end #960 + #946)", () => {
    // Production sequence: shave emits ClassName_methodName with typeof param →
    // compile emits def with underscore name AND type[X] annotation.
    // This is the exact bs4 EntitySubstitution.substitute_xml round-trip.
    const src = `
export function EntitySubstitution_substituteXml(cls: typeof EntitySubstitution, value: string): string {
  return value;
}`;
    const { source } = compileToPython(makeRow(src));
    // def name uses underscore form (not dotted — SyntaxError guard from #946)
    expect(source).toContain("def entity_substitution_substitute_xml(");
    // cls annotation must be type[...] not "typeof ..."
    expect(source).toContain("cls: type[EntitySubstitution]");
    expect(source).not.toContain('"typeof');
    // return annotation: string lowers to str
    expect(source).toContain("-> str:");
  });
});
