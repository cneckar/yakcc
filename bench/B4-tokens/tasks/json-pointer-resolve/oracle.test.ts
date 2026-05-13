// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/json-pointer-resolve/oracle.test.ts
//
// @decision DEC-V0-B4-TASKS-EXPAND-001
// @title B4 Slice 2 oracle: JSON Pointer resolve (RFC 6901)
// @status accepted
// @rationale
//   Oracle tests for semantic-equivalence verification. Must pass against reference-impl.ts
//   before Slice 2 measures LLM-generated implementations. Tests cover: empty pointer,
//   simple object/array traversal, escape sequence correctness (especially ~01 edge case),
//   "-" token rejection, invalid pointer format, missing keys, and primitive traversal errors.
//   The ~01 decode-order test is the key adversarial discriminator.
//
// Usage:
//   vitest run --config bench/B4-tokens/vitest.config.mjs bench/B4-tokens/tasks/json-pointer-resolve/oracle.test.ts

import { describe, expect, it, beforeEach } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const implPath = process.env["IMPL_PATH"]
  ? resolve(process.env["IMPL_PATH"])
  : resolve(__dirname, "reference-impl.ts");

const implUrl = pathToFileURL(implPath).href;

let jsonPointerResolve: (doc: unknown, pointer: string) => unknown;

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  jsonPointerResolve = mod.jsonPointerResolve ?? mod.default;
  if (typeof jsonPointerResolve !== "function") {
    throw new Error(
      `Implementation at ${implPath} must export jsonPointerResolve as a named or default export function`
    );
  }
});

// RFC 6901 example document (from Appendix A of the RFC)
const RFC_DOC = {
  "foo": ["bar", "baz"],
  "": 0,
  "a/b": 1,
  "c%d": 2,
  "e^f": 3,
  "g|h": 4,
  "i\j": 5,
  'k"l': 6,
  " ": 7,
  "m~n": 8,
};

describe("jsonPointerResolve — empty pointer (whole document)", () => {
  it("empty string returns the whole document", () => {
    expect(jsonPointerResolve(RFC_DOC, "")).toBe(RFC_DOC);
  });

  it("empty string on primitive: returns the primitive", () => {
    expect(jsonPointerResolve(42, "")).toBe(42);
  });

  it("empty string on null: returns null", () => {
    expect(jsonPointerResolve(null, "")).toBeNull();
  });

  it("empty string on array: returns the array", () => {
    const arr = [1, 2, 3];
    expect(jsonPointerResolve(arr, "")).toBe(arr);
  });
});

describe("jsonPointerResolve — RFC 6901 Appendix A examples", () => {
  it('/foo => ["bar","baz"]', () => {
    expect(jsonPointerResolve(RFC_DOC, "/foo")).toEqual(["bar", "baz"]);
  });

  it("/foo/0 => bar", () => {
    expect(jsonPointerResolve(RFC_DOC, "/foo/0")).toBe("bar");
  });

  it("/foo/1 => baz", () => {
    expect(jsonPointerResolve(RFC_DOC, "/foo/1")).toBe("baz");
  });

  it("/ => 0 (empty-string key)", () => {
    // "/" splits into ["", ""] — the second token is "" which is the key ""
    expect(jsonPointerResolve(RFC_DOC, "/")).toBe(0);
  });

  it("/a~1b => 1 (tilde-one decodes to slash)", () => {
    expect(jsonPointerResolve(RFC_DOC, "/a~1b")).toBe(1);
  });

  it("/m~0n => 8 (tilde-zero decodes to tilde)", () => {
    expect(jsonPointerResolve(RFC_DOC, "/m~0n")).toBe(8);
  });
});

describe("jsonPointerResolve — escape sequence correctness", () => {
  it("~1 decodes to /", () => {
    const doc = { "a/b": 42 };
    expect(jsonPointerResolve(doc, "/a~1b")).toBe(42);
  });

  it("~0 decodes to ~", () => {
    const doc = { "a~b": 99 };
    expect(jsonPointerResolve(doc, "/a~0b")).toBe(99);
  });

  it("~01 decodes to ~1 (NOT /): decode ~1 first, then ~0", () => {
    // RFC decode order: replace ~1 first: "~01" has no ~1 substring.
    // Then replace ~0: "~01" => "~1". So ~01 => literal "~1" key.
    // Wrong order (apply ~0 first): "~01" => "/" (WRONG).
    const doc = { "~1": "correct" };
    expect(jsonPointerResolve(doc, "/~01")).toBe("correct");
  });

  it("~10 decodes to /0 (not ~0)", () => {
    // ~10: apply ~1 first => "/0", then ~0 has no match. Result: "/0" as key.
    const doc = { "/0": "slash-zero" };
    expect(jsonPointerResolve(doc, "/~10")).toBe("slash-zero");
  });

  it("multiple escapes in one token", () => {
    const doc = { "a/b~c": "found" };
    // Token "a~1b~0c" => apply ~1=>/ first: "a/b~0c" => apply ~0=>~: "a/b~c"
    expect(jsonPointerResolve(doc, "/a~1b~0c")).toBe("found");
  });

  it("invalid escape ~2 throws Error", () => {
    expect(() => jsonPointerResolve({}, "/a~2b")).toThrow();
  });

  it("trailing ~ throws Error", () => {
    expect(() => jsonPointerResolve({}, "/a~")).toThrow();
  });
});

describe("jsonPointerResolve — array indexing", () => {
  const arr = [10, 20, 30];

  it("integer index 0: first element", () => {
    expect(jsonPointerResolve(arr, "/0")).toBe(10);
  });

  it("integer index 2: last element", () => {
    expect(jsonPointerResolve(arr, "/2")).toBe(30);
  });

  it("out-of-bounds index throws", () => {
    expect(() => jsonPointerResolve(arr, "/3")).toThrow();
  });

  it("- token throws (end-of-array is out of bounds)", () => {
    expect(() => jsonPointerResolve(arr, "/-")).toThrow();
  });

  it("non-integer token on array throws", () => {
    expect(() => jsonPointerResolve(arr, "/foo")).toThrow();
  });

  it("leading-zero index throws (except '0')", () => {
    expect(() => jsonPointerResolve(arr, "/01")).toThrow();
  });

  it("index 0 is valid", () => {
    expect(jsonPointerResolve(arr, "/0")).toBe(10);
  });

  it("nested array access", () => {
    const nested = [[1, 2], [3, 4], [5, 6]];
    expect(jsonPointerResolve(nested, "/1/0")).toBe(3);
    expect(jsonPointerResolve(nested, "/2/1")).toBe(6);
  });
});

describe("jsonPointerResolve — object traversal", () => {
  it("nested object traversal", () => {
    const doc = { a: { b: { c: 42 } } };
    expect(jsonPointerResolve(doc, "/a/b/c")).toBe(42);
  });

  it("missing key throws", () => {
    const doc = { a: 1 };
    expect(() => jsonPointerResolve(doc, "/b")).toThrow();
  });

  it("null value at key: returns null (not error)", () => {
    const doc = { key: null };
    expect(jsonPointerResolve(doc, "/key")).toBeNull();
  });

  it("false value at key: returns false (not error)", () => {
    const doc = { flag: false };
    expect(jsonPointerResolve(doc, "/flag")).toBe(false);
  });

  it("zero value at key: returns 0 (not error)", () => {
    const doc = { count: 0 };
    expect(jsonPointerResolve(doc, "/count")).toBe(0);
  });
});

describe("jsonPointerResolve — error conditions", () => {
  it("pointer not starting with / (non-empty) throws", () => {
    expect(() => jsonPointerResolve({}, "foo")).toThrow();
  });

  it("traversing into string primitive throws", () => {
    const doc = { a: "hello" };
    expect(() => jsonPointerResolve(doc, "/a/0")).toThrow();
  });

  it("traversing into number primitive throws", () => {
    const doc = { n: 42 };
    expect(() => jsonPointerResolve(doc, "/n/foo")).toThrow();
  });

  it("traversing into null throws", () => {
    const doc = { n: null };
    expect(() => jsonPointerResolve(doc, "/n/foo")).toThrow();
  });
});

describe("jsonPointerResolve — mixed object/array documents", () => {
  it("object containing array: resolve through array index", () => {
    const doc = { users: [{ name: "Alice" }, { name: "Bob" }] };
    expect(jsonPointerResolve(doc, "/users/0/name")).toBe("Alice");
    expect(jsonPointerResolve(doc, "/users/1/name")).toBe("Bob");
  });

  it("array containing objects: deep traversal", () => {
    const doc = [{ x: { y: 99 } }];
    expect(jsonPointerResolve(doc, "/0/x/y")).toBe(99);
  });
});
