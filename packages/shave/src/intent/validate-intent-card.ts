// SPDX-License-Identifier: MIT
// @decision DEC-CONTINUOUS-SHAVE-022: validateIntentCard is a loud, exact
// validator — it rejects unknown top-level fields and sub-object fields rather
// than silently ignoring them. This protects against schema drift: if the model
// returns an extra field (e.g. from a future prompt change), the validator
// surfaces the mismatch immediately rather than silently persisting an invalid
// entry to cache.
// Status: decided (MASTER_PLAN.md DEC-CONTINUOUS-SHAVE-022)
// Rationale: Silent acceptance of unknown fields is how schema drift goes
// undetected for months. Loud rejection keeps the IntentCard contract
// enforceable and cache entries trustworthy.

import { IntentCardSchemaError } from "../errors.js";
import type { IntentCard, IntentParam } from "./types.js";

// ---------------------------------------------------------------------------
// Allowed field sets — single source of truth for the schema shape.
// Any field not in these sets causes immediate rejection.
// ---------------------------------------------------------------------------

const INTENT_CARD_ALLOWED_KEYS = new Set<string>([
  "schemaVersion",
  "behavior",
  "inputs",
  "outputs",
  "preconditions",
  "postconditions",
  "notes",
  "modelVersion",
  "promptVersion",
  "sourceHash",
  "extractedAt",
]);

const INTENT_PARAM_ALLOWED_KEYS = new Set<string>(["name", "typeHint", "description"]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function fail(detail: string): never {
  throw new IntentCardSchemaError(detail);
}

function requireString(value: unknown, fieldPath: string): string {
  if (typeof value !== "string") {
    fail(`field "${fieldPath}" must be a string, got ${typeof value}`);
  }
  return value;
}

function requireArray(value: unknown, fieldPath: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(`field "${fieldPath}" must be an array, got ${typeof value}`);
  }
  return value as unknown[];
}

function requireStringArray(value: unknown, fieldPath: string): string[] {
  const arr = requireArray(value, fieldPath);
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== "string") {
      fail(`field "${fieldPath}[${i}]" must be a string, got ${typeof arr[i]}`);
    }
  }
  return arr as string[];
}

function validateIntentParam(value: unknown, fieldPath: string): IntentParam {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`field "${fieldPath}" must be a plain object`);
  }
  const obj = value as Record<string, unknown>;

  // Reject unknown keys
  for (const key of Object.keys(obj)) {
    if (!INTENT_PARAM_ALLOWED_KEYS.has(key)) {
      fail(`field "${fieldPath}" has unknown key "${key}"`);
    }
  }

  const name = requireString(obj.name, `${fieldPath}.name`);
  const typeHint = requireString(obj.typeHint, `${fieldPath}.typeHint`);
  const description = requireString(obj.description, `${fieldPath}.description`);

  return { name, typeHint, description };
}

function validateIntentParamArray(value: unknown, fieldPath: string): IntentParam[] {
  const arr = requireArray(value, fieldPath);
  return arr.map((item, i) => validateIntentParam(item, `${fieldPath}[${i}]`));
}

// ---------------------------------------------------------------------------
// Public validator
// ---------------------------------------------------------------------------

/**
 * Validate an unknown value against the IntentCard schema.
 *
 * Throws IntentCardSchemaError with a specific field-level message on any
 * violation, including:
 *   - Not a plain object
 *   - Missing required fields
 *   - Wrong types (string where array expected, etc.)
 *   - schemaVersion !== 1
 *   - behavior empty, contains newline, or > 200 chars
 *   - sourceHash not exactly 64 lowercase hex characters
 *   - Unknown top-level fields
 *   - inputs/outputs items missing required keys or having extra keys
 *
 * Returns the value typed as IntentCard on success. Does not clone or
 * transform the input — it is returned as-is after validation.
 *
 * @param value - The raw value to validate (typically parsed JSON).
 * @returns The validated value typed as IntentCard.
 */
export function validateIntentCard(value: unknown): IntentCard {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("value must be a plain object");
  }

  const obj = value as Record<string, unknown>;

  // Reject unknown top-level keys.
  for (const key of Object.keys(obj)) {
    if (!INTENT_CARD_ALLOWED_KEYS.has(key)) {
      fail(`unknown top-level field "${key}"`);
    }
  }

  // schemaVersion
  if (obj.schemaVersion !== 1) {
    fail(`field "schemaVersion" must be 1, got ${JSON.stringify(obj.schemaVersion)}`);
  }

  // behavior — non-empty, no newlines, ≤ 200 chars
  const behavior = requireString(obj.behavior, "behavior");
  if (behavior.length === 0) {
    fail('field "behavior" must not be empty');
  }
  if (/[\n\r]/.test(behavior)) {
    fail('field "behavior" must not contain newline characters');
  }
  if (behavior.length > 200) {
    fail(`field "behavior" must be ≤200 characters, got ${behavior.length}`);
  }

  // inputs / outputs — arrays of IntentParam
  const inputs = validateIntentParamArray(obj.inputs, "inputs");
  const outputs = validateIntentParamArray(obj.outputs, "outputs");

  // preconditions / postconditions / notes — arrays of strings
  const preconditions = requireStringArray(obj.preconditions, "preconditions");
  const postconditions = requireStringArray(obj.postconditions, "postconditions");
  const notes = requireStringArray(obj.notes, "notes");

  // modelVersion
  const modelVersion = requireString(obj.modelVersion, "modelVersion");

  // promptVersion
  const promptVersion = requireString(obj.promptVersion, "promptVersion");

  // sourceHash — exactly 64 lowercase hex characters
  const sourceHash = requireString(obj.sourceHash, "sourceHash");
  if (!/^[0-9a-f]{64}$/.test(sourceHash)) {
    fail(
      `field "sourceHash" must be 64 lowercase hex characters, got "${sourceHash.slice(0, 16)}${sourceHash.length > 16 ? "…" : ""}" (length ${sourceHash.length})`,
    );
  }

  // extractedAt — must be a non-empty string (ISO-8601 format not strictly
  // enforced here, but presence is required)
  const extractedAt = requireString(obj.extractedAt, "extractedAt");
  if (extractedAt.length === 0) {
    fail('field "extractedAt" must not be empty');
  }

  return {
    schemaVersion: 1,
    behavior,
    inputs,
    outputs,
    preconditions,
    postconditions,
    notes,
    modelVersion,
    promptVersion,
    sourceHash,
    extractedAt,
  };
}
