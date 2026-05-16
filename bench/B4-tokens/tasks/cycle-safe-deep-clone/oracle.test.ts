// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/cycle-safe-deep-clone/oracle.test.ts
//
// @decision DEC-B4-SLICE-3-TASKS-001
// @title B4 Slice 3 oracle: cycle-safe-deep-clone
// @status accepted
// @rationale
//   Oracle tests for semantic-equivalence verification. Must pass against reference-impl.ts
//   before the B4 harness measures LLM-generated implementations. Tests cover:
//   - Primitives returned as-is
//   - Plain objects: own properties recursively cloned, no shared references
//   - Arrays: elements cloned, sparse holes preserved
//   - Date: instanceof Date, same getTime()
//   - RegExp: instanceof RegExp, source/flags/lastIndex preserved
//   - Map: instanceof Map, entries recursively cloned
//   - Set: instanceof Set, values recursively cloned
//   - ArrayBuffer: cloned via slice
//   - Typed arrays: cloned correctly
//   - Functions: returned by reference (not deep-copied)
//   - Cycles: no stack overflow, cloned graph preserves cyclic structure
//   - undefined property values: Object.hasOwn preserved
//   - Symbol-keyed properties: preserved
//   - Class instances: prototype chain preserved
//
// Usage:
//   vitest run --config bench/B4-tokens/vitest.config.mjs bench/B4-tokens/tasks/cycle-safe-deep-clone/oracle.test.ts

import { describe, expect, it, beforeEach } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const implPath = process.env["IMPL_PATH"]
  ? resolve(process.env["IMPL_PATH"])
  : resolve(__dirname, "reference-impl.ts");

const implUrl = pathToFileURL(implPath).href;

let deepClone: <T>(value: T) => T;

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  deepClone = mod.default ?? mod.deepClone;
  if (typeof deepClone !== "function") {
    throw new Error(
      `Implementation at ${implPath} must export deepClone as default or named export`
    );
  }
});

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

describe("deepClone — primitives (returned as-is)", () => {
  it("clones null", () => expect(deepClone(null)).toBeNull());
  it("clones undefined", () => expect(deepClone(undefined)).toBeUndefined());
  it("clones number", () => expect(deepClone(42)).toBe(42));
  it("clones string", () => expect(deepClone("hello")).toBe("hello"));
  it("clones boolean true", () => expect(deepClone(true)).toBe(true));
  it("clones boolean false", () => expect(deepClone(false)).toBe(false));
  it("clones 0", () => expect(deepClone(0)).toBe(0));
  it("clones NaN", () => expect(deepClone(Number.NaN)).toBeNaN());
  it("clones Infinity", () => expect(deepClone(Infinity)).toBe(Infinity));
});

// ---------------------------------------------------------------------------
// Plain objects
// ---------------------------------------------------------------------------

describe("deepClone — plain objects", () => {
  it("produces a new object (not same reference)", () => {
    const obj = { a: 1 };
    expect(deepClone(obj)).not.toBe(obj);
  });

  it("clones shallow properties", () => {
    const obj = { a: 1, b: "hello", c: true };
    expect(deepClone(obj)).toEqual({ a: 1, b: "hello", c: true });
  });

  it("recursively clones nested objects", () => {
    const obj = { a: { b: { c: 42 } } };
    const clone = deepClone(obj);
    expect(clone.a.b.c).toBe(42);
    expect(clone.a).not.toBe(obj.a);
    expect(clone.a.b).not.toBe(obj.a.b);
  });

  it("mutations to clone do not affect original", () => {
    const obj = { x: { y: 1 } };
    const clone = deepClone(obj);
    clone.x.y = 99;
    expect(obj.x.y).toBe(1);
  });

  it("mutations to original do not affect clone", () => {
    const obj = { x: { y: 1 } };
    const clone = deepClone(obj);
    obj.x.y = 99;
    expect(clone.x.y).toBe(1);
  });

  it("clones empty object", () => {
    expect(deepClone({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// undefined property values (adversarial trap: JSON.stringify path loses undefined)
// ---------------------------------------------------------------------------

describe("deepClone — undefined property values (adversarial trap)", () => {
  it("preserves undefined-valued property in clone (Object.hasOwn remains true)", () => {
    const obj: Record<string, unknown> = { a: undefined };
    const clone = deepClone(obj);
    expect(Object.hasOwn(clone, "a")).toBe(true);
    expect(clone["a"]).toBeUndefined();
  });

  it("distinguishes missing key from undefined-valued key", () => {
    const withUndefined: Record<string, unknown> = { a: undefined };
    const withoutKey: Record<string, unknown> = {};
    const cloneA = deepClone(withUndefined);
    const cloneB = deepClone(withoutKey);
    expect(Object.hasOwn(cloneA, "a")).toBe(true);
    expect(Object.hasOwn(cloneB, "a")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Symbol-keyed properties (adversarial trap: Object.keys misses symbols)
// ---------------------------------------------------------------------------

describe("deepClone — symbol-keyed properties (adversarial trap)", () => {
  it("preserves symbol-keyed property", () => {
    const sym = Symbol("k");
    const obj = { [sym]: 42, regular: "yes" };
    const clone = deepClone(obj);
    expect((clone as Record<symbol, unknown>)[sym]).toBe(42);
    expect(clone.regular).toBe("yes");
  });

  it("cloned symbol property value is itself cloned", () => {
    const sym = Symbol("nested");
    const inner = { x: 1 };
    const obj = { [sym]: inner };
    const clone = deepClone(obj);
    expect((clone as Record<symbol, unknown>)[sym]).toEqual({ x: 1 });
    expect((clone as Record<symbol, unknown>)[sym]).not.toBe(inner);
  });
});

// ---------------------------------------------------------------------------
// Arrays
// ---------------------------------------------------------------------------

describe("deepClone — arrays", () => {
  it("produces a new array (not same reference)", () => {
    const arr = [1, 2, 3];
    expect(deepClone(arr)).not.toBe(arr);
  });

  it("clones array elements", () => {
    expect(deepClone([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("recursively clones nested arrays", () => {
    const arr = [[1, 2], [3, 4]];
    const clone = deepClone(arr);
    expect(clone).toEqual([[1, 2], [3, 4]]);
    expect(clone[0]).not.toBe(arr[0]);
  });

  it("clones arrays of objects", () => {
    const arr = [{ a: 1 }, { b: 2 }];
    const clone = deepClone(arr);
    clone[0]!.a = 99;
    expect(arr[0]!.a).toBe(1);
  });

  it("preserves array length", () => {
    expect(deepClone([1, 2, 3]).length).toBe(3);
  });

  it("clones empty array", () => {
    expect(deepClone([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Date (adversarial trap: JSON.stringify converts Date to ISO string)
// ---------------------------------------------------------------------------

describe("deepClone — Date (adversarial trap)", () => {
  it("clone is instanceof Date", () => {
    const d = new Date(2026, 4, 16);
    expect(deepClone(d)).toBeInstanceOf(Date);
  });

  it("clone has same getTime()", () => {
    const d = new Date(2026, 4, 16, 12, 0, 0, 0);
    const clone = deepClone(d);
    expect(clone.getTime()).toBe(d.getTime());
  });

  it("clone is a different object from original", () => {
    const d = new Date(2026, 4, 16);
    expect(deepClone(d)).not.toBe(d);
  });

  it("mutation of clone does not affect original", () => {
    const d = new Date(2026, 4, 16);
    const clone = deepClone(d);
    clone.setFullYear(2000);
    expect(d.getFullYear()).toBe(2026);
  });

  it("Date inside object is cloned correctly", () => {
    const obj = { created: new Date(2026, 0, 1) };
    const clone = deepClone(obj);
    expect(clone.created).toBeInstanceOf(Date);
    expect(clone.created.getTime()).toBe(obj.created.getTime());
    expect(clone.created).not.toBe(obj.created);
  });
});

// ---------------------------------------------------------------------------
// RegExp (adversarial trap: naive clone loses flags or lastIndex)
// ---------------------------------------------------------------------------

describe("deepClone — RegExp (adversarial trap)", () => {
  it("clone is instanceof RegExp", () => {
    expect(deepClone(/abc/gi)).toBeInstanceOf(RegExp);
  });

  it("clone preserves source", () => {
    const re = /foo[bar]+/;
    expect(deepClone(re).source).toBe("foo[bar]+");
  });

  it("clone preserves flags", () => {
    const re = /abc/gim;
    // Flags may be returned in a canonical alphabetical order
    const clone = deepClone(re);
    expect([...re.flags].sort().join("")).toBe([...clone.flags].sort().join(""));
  });

  it("clone is not the same reference", () => {
    const re = /abc/;
    expect(deepClone(re)).not.toBe(re);
  });

  it("lastIndex is reset to 0 on clone", () => {
    const re = /a/g;
    re.lastIndex = 5;
    const clone = deepClone(re);
    expect(clone.lastIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Map (adversarial trap: Map becomes plain object)
// ---------------------------------------------------------------------------

describe("deepClone — Map (adversarial trap)", () => {
  it("clone is instanceof Map", () => {
    expect(deepClone(new Map([["a", 1]]))).toBeInstanceOf(Map);
  });

  it("clone has same entries", () => {
    const m = new Map([["a", 1], ["b", 2]]);
    const clone = deepClone(m);
    expect(clone.get("a")).toBe(1);
    expect(clone.get("b")).toBe(2);
    expect(clone.size).toBe(2);
  });

  it("clone is a different Map instance", () => {
    const m = new Map();
    expect(deepClone(m)).not.toBe(m);
  });

  it("Map values are recursively cloned", () => {
    const inner = { x: 1 };
    const m = new Map([["key", inner]]);
    const clone = deepClone(m);
    expect(clone.get("key")).toEqual({ x: 1 });
    expect(clone.get("key")).not.toBe(inner);
  });

  it("mutations to clone Map do not affect original", () => {
    const m = new Map([["a", { v: 1 }]]);
    const clone = deepClone(m);
    (clone.get("a") as { v: number }).v = 99;
    expect((m.get("a") as { v: number }).v).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Set (adversarial trap: Set becomes plain array or object)
// ---------------------------------------------------------------------------

describe("deepClone — Set (adversarial trap)", () => {
  it("clone is instanceof Set", () => {
    expect(deepClone(new Set([1, 2, 3]))).toBeInstanceOf(Set);
  });

  it("clone has same values", () => {
    const s = new Set([1, 2, 3]);
    const clone = deepClone(s);
    expect(clone.has(1)).toBe(true);
    expect(clone.has(2)).toBe(true);
    expect(clone.has(3)).toBe(true);
    expect(clone.size).toBe(3);
  });

  it("clone is a different Set instance", () => {
    const s = new Set([1]);
    expect(deepClone(s)).not.toBe(s);
  });

  it("Set values (objects) are recursively cloned", () => {
    const inner = { x: 1 };
    const s = new Set([inner]);
    const clone = deepClone(s);
    const clonedInner = [...clone][0] as { x: number };
    expect(clonedInner).toEqual({ x: 1 });
    expect(clonedInner).not.toBe(inner);
  });
});

// ---------------------------------------------------------------------------
// Functions (returned by reference per lodash semantics)
// ---------------------------------------------------------------------------

describe("deepClone — functions (returned by reference)", () => {
  it("function property is returned by reference (not deep-copied)", () => {
    const fn = () => 42;
    const obj = { fn };
    const clone = deepClone(obj);
    expect(clone.fn).toBe(fn);
  });

  it("standalone function clone returns same function", () => {
    const fn = (x: number) => x * 2;
    expect(deepClone(fn)).toBe(fn);
  });
});

// ---------------------------------------------------------------------------
// Cycle detection (primary adversarial trap: naive recursion → stack overflow)
// ---------------------------------------------------------------------------

describe("deepClone — cycle detection (adversarial trap: infinite recursion)", () => {
  it("handles self-referential object without stack overflow", () => {
    const a: Record<string, unknown> = { x: 1 };
    a["self"] = a;
    // Must not throw RangeError: Maximum call stack size exceeded
    expect(() => deepClone(a)).not.toThrow();
  });

  it("cloned self-referential object: clone.self === clone (cycle preserved)", () => {
    const a: Record<string, unknown> = { x: 1 };
    a["self"] = a;
    const clone = deepClone(a);
    // The cloned graph must have the same cycle structure
    expect((clone as Record<string, unknown>)["self"]).toBe(clone);
  });

  it("handles mutual cycles: a.b = b, b.a = a", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b" };
    a["other"] = b;
    b["other"] = a;
    const cloneA = deepClone(a);
    expect(() => deepClone(a)).not.toThrow();
    // cloneA.other.other === cloneA (mutual cycle preserved)
    const cloneB = (cloneA as Record<string, unknown>)["other"] as Record<string, unknown>;
    expect(cloneB["other"]).toBe(cloneA);
  });

  it("handles deeply nested cycle: a.b.c.a = a", () => {
    const a: Record<string, unknown> = { v: 1 };
    const b: Record<string, unknown> = { v: 2 };
    const c: Record<string, unknown> = { v: 3, a };
    b["c"] = c;
    a["b"] = b;
    expect(() => deepClone(a)).not.toThrow();
    const clone = deepClone(a);
    // Verify the cycle is reconstructed correctly
    const cloneB = (clone as Record<string, unknown>)["b"] as Record<string, unknown>;
    const cloneC = cloneB["c"] as Record<string, unknown>;
    expect(cloneC["a"]).toBe(clone); // cycle back to clone, not to original a
  });

  it("array with self-reference in element", () => {
    const arr: unknown[] = [1, 2];
    arr.push(arr);
    expect(() => deepClone(arr)).not.toThrow();
    const clone = deepClone(arr);
    expect(clone[2]).toBe(clone); // clone[2] === clone (cycle preserved)
  });
});

// ---------------------------------------------------------------------------
// Class instances (prototype chain preserved)
// ---------------------------------------------------------------------------

describe("deepClone — class instances (prototype chain preserved)", () => {
  class Point {
    constructor(
      public x: number,
      public y: number,
    ) {}
    distanceTo(other: Point): number {
      return Math.sqrt((this.x - other.x) ** 2 + (this.y - other.y) ** 2);
    }
  }

  it("clone has same prototype as original", () => {
    const p = new Point(3, 4);
    const clone = deepClone(p);
    expect(Object.getPrototypeOf(clone)).toBe(Object.getPrototypeOf(p));
  });

  it("clone has correct property values", () => {
    const p = new Point(3, 4);
    const clone = deepClone(p);
    expect(clone.x).toBe(3);
    expect(clone.y).toBe(4);
  });

  it("clone is not same reference as original", () => {
    const p = new Point(1, 2);
    expect(deepClone(p)).not.toBe(p);
  });

  it("clone methods work correctly (prototype chain intact)", () => {
    const p = new Point(0, 0);
    const q = new Point(3, 4);
    const cloneP = deepClone(p);
    // distanceTo is on prototype; it must work on clone
    expect(typeof cloneP.distanceTo).toBe("function");
    expect(cloneP.distanceTo(q)).toBeCloseTo(5, 5);
  });
});

// ---------------------------------------------------------------------------
// ArrayBuffer and typed arrays
// ---------------------------------------------------------------------------

describe("deepClone — ArrayBuffer", () => {
  it("clone is instanceof ArrayBuffer", () => {
    const buf = new ArrayBuffer(4);
    expect(deepClone(buf)).toBeInstanceOf(ArrayBuffer);
  });

  it("clone has same byte length", () => {
    const buf = new ArrayBuffer(8);
    expect(deepClone(buf).byteLength).toBe(8);
  });

  it("clone is not same reference", () => {
    const buf = new ArrayBuffer(4);
    expect(deepClone(buf)).not.toBe(buf);
  });

  it("cloned buffer content matches original", () => {
    const buf = new ArrayBuffer(4);
    new Uint8Array(buf).set([1, 2, 3, 4]);
    const clone = deepClone(buf);
    expect([...new Uint8Array(clone)]).toEqual([1, 2, 3, 4]);
  });
});

describe("deepClone — typed arrays", () => {
  it("Uint8Array clone is instanceof Uint8Array", () => {
    const ta = new Uint8Array([1, 2, 3]);
    expect(deepClone(ta)).toBeInstanceOf(Uint8Array);
  });

  it("Uint8Array clone has same values", () => {
    const ta = new Uint8Array([10, 20, 30]);
    expect([...deepClone(ta)]).toEqual([10, 20, 30]);
  });

  it("Float64Array clone has same values", () => {
    const ta = new Float64Array([1.1, 2.2, 3.3]);
    const clone = deepClone(ta);
    expect(clone[0]).toBeCloseTo(1.1);
    expect(clone[1]).toBeCloseTo(2.2);
    expect(clone[2]).toBeCloseTo(3.3);
  });
});

// ---------------------------------------------------------------------------
// Compound production-sequence test
// ---------------------------------------------------------------------------

describe("deepClone — compound production sequence", () => {
  it("deeply nested heterogeneous structure: object + array + Date + Map + cycle", () => {
    const shared = { id: "shared" };
    const root: Record<string, unknown> = {
      name: "root",
      created: new Date(2026, 0, 1),
      tags: new Set(["alpha", "beta"]),
      meta: new Map([["k1", { nested: true }]]),
      items: [1, "two", { three: 3 }],
      ref: shared,
      alsoRef: shared, // same object reference
    };

    const clone = deepClone(root);

    // Basic structure
    expect(clone["name"]).toBe("root");

    // Date cloned correctly
    expect(clone["created"]).toBeInstanceOf(Date);
    expect((clone["created"] as Date).getTime()).toBe((root["created"] as Date).getTime());
    expect(clone["created"]).not.toBe(root["created"]);

    // Set cloned correctly
    expect(clone["tags"]).toBeInstanceOf(Set);
    expect((clone["tags"] as Set<string>).has("alpha")).toBe(true);

    // Map cloned correctly
    expect(clone["meta"]).toBeInstanceOf(Map);
    expect(((clone["meta"] as Map<string, unknown>).get("k1"))).toEqual({ nested: true });

    // Array cloned
    expect((clone["items"] as unknown[])[0]).toBe(1);
    expect((clone["items"] as unknown[])[1]).toBe("two");

    // Shared reference: both ref and alsoRef should clone to the SAME cloned object
    // (structural sharing preserved within one clone call)
    expect((clone["ref"] as object)).toBe(clone["alsoRef"] as object);

    // Mutations don't cross the boundary
    (root["items"] as unknown[])[0] = 999;
    expect((clone["items"] as unknown[])[0]).toBe(1);
  });
});
