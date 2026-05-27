import { describe, expect, it } from "vitest";
import {
  type PropertySpec,
  validatePropertySpec,
} from "./proof-properties.js";

const MIN_VALID: PropertySpec = {
  schemaVersion: 1,
  properties: [
    {
      name: "identity",
      inputs: [{ name: "x", generator: { kind: "integer" } }],
      assertion: { kind: "eq", expected: { kind: "input_ref", name: "x" } },
    },
  ],
};

describe("validatePropertySpec", () => {
  it("accepts a minimal valid spec", () => {
    expect(validatePropertySpec(MIN_VALID)).toEqual(MIN_VALID);
  });

  it("accepts every generator kind", () => {
    const spec: PropertySpec = {
      schemaVersion: 1,
      properties: [
        {
          name: "all-gens",
          inputs: [
            { name: "i", generator: { kind: "integer", min: 0, max: 10 } },
            { name: "f", generator: { kind: "float" } },
            { name: "s", generator: { kind: "string", maxLength: 5 } },
            { name: "b", generator: { kind: "boolean" } },
            { name: "a", generator: { kind: "array", items: { kind: "integer" } } },
            {
              name: "r",
              generator: { kind: "record", fields: { x: { kind: "integer" } } },
            },
            {
              name: "t",
              generator: { kind: "tuple", items: [{ kind: "string" }, { kind: "boolean" }] },
            },
            {
              name: "o",
              generator: {
                kind: "oneof",
                options: [{ kind: "integer" }, { kind: "string" }],
              },
            },
          ],
          assertion: { kind: "not_throws" },
        },
      ],
    };
    expect(validatePropertySpec(spec)).toEqual(spec);
  });

  it("accepts every structured assertion kind", () => {
    for (const kind of ["eq", "neq", "lt", "lte", "gt", "gte"] as const) {
      const spec: PropertySpec = {
        schemaVersion: 1,
        properties: [
          {
            name: kind,
            inputs: [{ name: "x", generator: { kind: "integer" } }],
            assertion: { kind, expected: { kind: "literal", value: 0 } },
          },
        ],
      };
      expect(validatePropertySpec(spec)).toEqual(spec);
    }
  });

  it("accepts throws/not_throws/custom_ir", () => {
    const spec: PropertySpec = {
      schemaVersion: 1,
      properties: [
        {
          name: "t",
          inputs: [],
          assertion: { kind: "throws", errorClass: "TypeError" },
        },
        { name: "nt", inputs: [], assertion: { kind: "not_throws" } },
        {
          name: "c",
          inputs: [{ name: "x", generator: { kind: "integer" } }],
          assertion: { kind: "custom_ir", predicate: "_out >= x" },
        },
      ],
    };
    expect(validatePropertySpec(spec)).toEqual(spec);
  });

  it("rejects schemaVersion other than 1", () => {
    expect(() => validatePropertySpec({ schemaVersion: 2, properties: [] })).toThrow(
      /schemaVersion must be 1/,
    );
  });

  it("rejects non-object input", () => {
    expect(() => validatePropertySpec(null)).toThrow(/non-null object/);
    expect(() => validatePropertySpec(42)).toThrow(/non-null object/);
    expect(() => validatePropertySpec([])).toThrow(/non-null object/);
  });

  it("rejects missing properties array", () => {
    expect(() => validatePropertySpec({ schemaVersion: 1 })).toThrow(/must be an array/);
  });

  it("rejects empty property name", () => {
    expect(() =>
      validatePropertySpec({
        schemaVersion: 1,
        properties: [
          { name: "", inputs: [], assertion: { kind: "not_throws" } },
        ],
      }),
    ).toThrow(/non-empty string/);
  });

  it("rejects unknown generator kind", () => {
    expect(() =>
      validatePropertySpec({
        schemaVersion: 1,
        properties: [
          {
            name: "p",
            inputs: [{ name: "x", generator: { kind: "bigint" } }],
            assertion: { kind: "not_throws" },
          },
        ],
      }),
    ).toThrow(/must be one of/);
  });

  it("rejects unknown assertion kind", () => {
    expect(() =>
      validatePropertySpec({
        schemaVersion: 1,
        properties: [
          {
            name: "p",
            inputs: [],
            assertion: { kind: "always-true" },
          },
        ],
      }),
    ).toThrow(/not a recognized assertion kind/);
  });

  it("rejects custom_ir with empty predicate", () => {
    expect(() =>
      validatePropertySpec({
        schemaVersion: 1,
        properties: [
          {
            name: "p",
            inputs: [],
            assertion: { kind: "custom_ir", predicate: "" },
          },
        ],
      }),
    ).toThrow(/non-empty string/);
  });

  it("rejects array generator missing items", () => {
    expect(() =>
      validatePropertySpec({
        schemaVersion: 1,
        properties: [
          {
            name: "p",
            inputs: [{ name: "x", generator: { kind: "array" } }],
            assertion: { kind: "not_throws" },
          },
        ],
      }),
    ).toThrow(/items is required/);
  });
});
