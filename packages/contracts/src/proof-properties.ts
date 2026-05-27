// SPDX-License-Identifier: MIT
/**
 * Language-neutral property spec.
 *
 * @decision DEC-POLYGLOT-PROOF-IR-001
 * @title proof/properties.json is the single source of truth for property tests
 * @status decided (ADR Q4 — option c)
 * @rationale
 *   Per-language property test files (tests.fast-check.ts, tests.hypothesis.py)
 *   are DERIVED from a language-neutral PropertySpec. The same spec emits both;
 *   neither hand-translated re-emission (option a, no verification) nor a TS
 *   test runner running inside Python projects (option b, unwanted runtime dep)
 *   was acceptable. Single source of truth is the load-bearing constraint
 *   (Sacred Practice #12).
 * @scope Used by:
 *   - @yakcc/contracts proof-emitters/{fast-check,hypothesis}.ts
 *   - @yakcc/compile-py (#783) when lowering atoms to Python
 *   - future @yakcc/compile-go / @yakcc/compile-rs
 */

// ---------------------------------------------------------------------------
// Generator definitions — language-neutral fast-check / hypothesis abstractions
// ---------------------------------------------------------------------------

export type GeneratorDef =
  | { kind: "integer"; min?: number | undefined; max?: number | undefined }
  | { kind: "float"; min?: number | undefined; max?: number | undefined }
  | { kind: "string"; minLength?: number | undefined; maxLength?: number | undefined }
  | { kind: "boolean" }
  | { kind: "array"; items: GeneratorDef; minLength?: number | undefined; maxLength?: number | undefined }
  | { kind: "record"; fields: Readonly<Record<string, GeneratorDef>> }
  | { kind: "tuple"; items: readonly GeneratorDef[] }
  | { kind: "oneof"; options: readonly GeneratorDef[] };

// ---------------------------------------------------------------------------
// Assertion definitions — language-neutral postconditions
// ---------------------------------------------------------------------------

/**
 * The kinds of structured assertions supported by the spec.
 *
 * For all comparison assertions, `expected` is a value literal or a reference
 * to another property input by name. `custom_ir` carries a TS-subset IR
 * expression that must be re-evaluated against the function's output and
 * inputs — emitters translate it to their language's equivalent expression
 * (fast-check: TS literal; hypothesis: Python literal via a small adapter).
 */
export type AssertionDef =
  | { kind: "eq"; expected: AssertionValue }
  | { kind: "neq"; expected: AssertionValue }
  | { kind: "lt"; expected: AssertionValue }
  | { kind: "lte"; expected: AssertionValue }
  | { kind: "gt"; expected: AssertionValue }
  | { kind: "gte"; expected: AssertionValue }
  | { kind: "throws"; errorClass?: string | undefined }
  | { kind: "not_throws" }
  | { kind: "custom_ir"; predicate: string; description?: string | undefined };

/**
 * A value carried in a structured assertion. Either a JSON-literal value or
 * a reference to one of the property's input parameters by name.
 *
 * Refs let assertions like `output === input.x + input.y` be expressed
 * without escaping into custom_ir.
 */
export type AssertionValue =
  | { kind: "literal"; value: number | string | boolean | null }
  | { kind: "input_ref"; name: string };

// ---------------------------------------------------------------------------
// PropertyDef + PropertySpec
// ---------------------------------------------------------------------------

export interface InputDef {
  readonly name: string;
  readonly generator: GeneratorDef;
}

export interface PropertyDef {
  readonly name: string;
  readonly inputs: readonly InputDef[];
  readonly assertion: AssertionDef;
}

export interface PropertySpec {
  readonly schemaVersion: 1;
  readonly properties: readonly PropertyDef[];
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

/**
 * Validate and narrow an unknown value to PropertySpec.
 *
 * Throws TypeError with a descriptive message on invalid input. Used both as
 * a runtime guard when loading proof/properties.json and as the schema
 * contract that emitters rely on.
 */
export function validatePropertySpec(value: unknown): PropertySpec {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("validatePropertySpec: expected a non-null object");
  }
  const obj = value as Record<string, unknown>;

  if (obj.schemaVersion !== 1) {
    throw new TypeError(
      `validatePropertySpec: schemaVersion must be 1, got ${String(obj.schemaVersion)}`,
    );
  }

  if (!Array.isArray(obj.properties)) {
    throw new TypeError('validatePropertySpec: field "properties" must be an array');
  }

  for (let i = 0; i < obj.properties.length; i++) {
    validatePropertyDef(obj.properties[i], `properties[${i}]`);
  }

  return obj as unknown as PropertySpec;
}

function validatePropertyDef(value: unknown, path: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`validatePropertySpec: ${path} must be a non-null object`);
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.length === 0) {
    throw new TypeError(`validatePropertySpec: ${path}.name must be a non-empty string`);
  }
  if (!Array.isArray(obj.inputs)) {
    throw new TypeError(`validatePropertySpec: ${path}.inputs must be an array`);
  }
  for (let i = 0; i < obj.inputs.length; i++) {
    const inp = obj.inputs[i];
    if (inp === null || typeof inp !== "object") {
      throw new TypeError(`validatePropertySpec: ${path}.inputs[${i}] must be an object`);
    }
    const inpObj = inp as Record<string, unknown>;
    if (typeof inpObj.name !== "string" || inpObj.name.length === 0) {
      throw new TypeError(
        `validatePropertySpec: ${path}.inputs[${i}].name must be a non-empty string`,
      );
    }
    validateGenerator(inpObj.generator, `${path}.inputs[${i}].generator`);
  }
  validateAssertion(obj.assertion, `${path}.assertion`);
}

const GENERATOR_KINDS = new Set<string>([
  "integer",
  "float",
  "string",
  "boolean",
  "array",
  "record",
  "tuple",
  "oneof",
]);

function validateGenerator(value: unknown, path: string): void {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`validatePropertySpec: ${path} must be an object`);
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.kind !== "string" || !GENERATOR_KINDS.has(obj.kind)) {
    throw new TypeError(
      `validatePropertySpec: ${path}.kind must be one of ${[...GENERATOR_KINDS].join("/")}, got "${String(obj.kind)}"`,
    );
  }
  if (obj.kind === "array") {
    if (obj.items === undefined) {
      throw new TypeError(`validatePropertySpec: ${path}.items is required for array generator`);
    }
    validateGenerator(obj.items, `${path}.items`);
  } else if (obj.kind === "record") {
    if (obj.fields === null || typeof obj.fields !== "object" || Array.isArray(obj.fields)) {
      throw new TypeError(`validatePropertySpec: ${path}.fields must be a non-null object`);
    }
    for (const [k, v] of Object.entries(obj.fields as Record<string, unknown>)) {
      validateGenerator(v, `${path}.fields.${k}`);
    }
  } else if (obj.kind === "tuple" || obj.kind === "oneof") {
    const key = obj.kind === "tuple" ? "items" : "options";
    const items = obj[key];
    if (!Array.isArray(items)) {
      throw new TypeError(`validatePropertySpec: ${path}.${key} must be an array`);
    }
    for (let i = 0; i < items.length; i++) {
      validateGenerator(items[i], `${path}.${key}[${i}]`);
    }
  }
}

const STRUCTURED_ASSERTION_KINDS = new Set<string>([
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
]);

function validateAssertion(value: unknown, path: string): void {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`validatePropertySpec: ${path} must be an object`);
  }
  const obj = value as Record<string, unknown>;
  const kind = obj.kind;
  if (typeof kind !== "string") {
    throw new TypeError(`validatePropertySpec: ${path}.kind must be a string`);
  }
  if (STRUCTURED_ASSERTION_KINDS.has(kind)) {
    validateAssertionValue(obj.expected, `${path}.expected`);
    return;
  }
  if (kind === "throws" || kind === "not_throws") {
    return;
  }
  if (kind === "custom_ir") {
    if (typeof obj.predicate !== "string" || obj.predicate.length === 0) {
      throw new TypeError(
        `validatePropertySpec: ${path}.predicate must be a non-empty string for custom_ir assertion`,
      );
    }
    return;
  }
  throw new TypeError(`validatePropertySpec: ${path}.kind "${kind}" is not a recognized assertion kind`);
}

function validateAssertionValue(value: unknown, path: string): void {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`validatePropertySpec: ${path} must be an object`);
  }
  const obj = value as Record<string, unknown>;
  if (obj.kind === "literal") {
    const t = typeof obj.value;
    if (obj.value !== null && t !== "number" && t !== "string" && t !== "boolean") {
      throw new TypeError(
        `validatePropertySpec: ${path}.value must be a JSON literal (number/string/boolean/null)`,
      );
    }
    return;
  }
  if (obj.kind === "input_ref") {
    if (typeof obj.name !== "string" || obj.name.length === 0) {
      throw new TypeError(`validatePropertySpec: ${path}.name must be a non-empty string`);
    }
    return;
  }
  throw new TypeError(`validatePropertySpec: ${path}.kind must be "literal" or "input_ref"`);
}
