// SPDX-License-Identifier: MIT
//
// @decision DEC-BENCH-B2-VALIDATOR-001
// @title JSON Schema 2020-12 validator implemented as a Yakcc atom
// @status accepted
// @rationale
//   B2 bloat benchmark requires an AJV-equivalent validator implemented in the
//   Yakcc IR strict-subset so that bundle-size comparison is apples-to-apples.
//   This file is the single-atom "coarse" granularity implementation; the
//   fine-grained decomposition (one atom per keyword category) is planned for
//   B2 Slice 2 once application-layer corpus atoms are in the registry.
//
//   Strict-subset compliance: no `any` types, no `eval`, no `new Function`,
//   no `Object.getPrototypeOf`/`Reflect.*`/`__proto__`, no `with` statements,
//   no top-level mutable state, no untyped imports. `Object.keys()`,
//   `Array.isArray()`, `Object.entries()` are NOT in the forbidden list.

// ---------------------------------------------------------------------------
// Core JSON value types (no `any`)
// ---------------------------------------------------------------------------

export type JsonPrimitive = null | boolean | number | string;
export type JsonObject = { readonly [k: string]: JsonValue };
export type JsonArray = readonly JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

export type SchemaObject = { readonly [k: string]: JsonValue };
export type Schema = boolean | SchemaObject;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface ValidationError {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
}

// ---------------------------------------------------------------------------
// Internal annotation tracking
// ---------------------------------------------------------------------------

interface Annotations {
  evaluatedProps: Set<string>;
  evaluatedItemCount: number; // items [0..n) evaluated
}

function mergeAnnotations(a: Annotations, b: Annotations): Annotations {
  const merged: Annotations = {
    evaluatedProps: new Set(a.evaluatedProps),
    evaluatedItemCount: Math.max(a.evaluatedItemCount, b.evaluatedItemCount),
  };
  for (const k of b.evaluatedProps) merged.evaluatedProps.add(k);
  return merged;
}

function emptyAnnotations(): Annotations {
  return { evaluatedProps: new Set(), evaluatedItemCount: 0 };
}

// ---------------------------------------------------------------------------
// Internal validation context
// ---------------------------------------------------------------------------

interface Context {
  readonly rootSchema: Schema;
  readonly anchors: ReadonlyMap<string, Schema>;
  readonly dynamicScope: readonly Schema[];
}

interface ApplyResult {
  readonly valid: boolean;
  readonly errors: ValidationError[];
  readonly annotations: Annotations;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isJsonObject(v: JsonValue): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isJsonArray(v: JsonValue): v is JsonArray {
  return Array.isArray(v);
}

function jsonDeepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const ai = a[i];
      const bi = b[i];
      if (ai === undefined || bi === undefined) return false;
      if (!jsonDeepEqual(ai, bi)) return false;
    }
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) return false;
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as JsonObject;
    const bo = b as JsonObject;
    const aKeys = Object.keys(ao);
    const bKeys = Object.keys(bo);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
      const av = ao[k];
      const bv = bo[k];
      if (av === undefined || bv === undefined) return false;
      if (!jsonDeepEqual(av, bv)) return false;
    }
    return true;
  }
  return false;
}

function makeError(
  instancePath: string,
  schemaPath: string,
  keyword: string,
  message: string,
): ValidationError {
  return { instancePath, schemaPath, keyword, message };
}

function schemaAt(schemaPath: string, ...segments: string[]): string {
  return schemaPath + "/" + segments.join("/");
}

// ---------------------------------------------------------------------------
// Anchor/ID scanning — pre-builds a map from anchor/id → Schema
// ---------------------------------------------------------------------------

function scanAnchors(schema: Schema, base: string, out: Map<string, Schema>): void {
  if (typeof schema !== "object") return;
  const s = schema as SchemaObject;

  const id = s["$id"];
  if (typeof id === "string" && id.length > 0) {
    out.set(id, schema);
  }
  const anchor = s["$anchor"];
  if (typeof anchor === "string" && anchor.length > 0) {
    out.set(anchor, schema);
    // Also store with # prefix for $ref resolution
    out.set("#" + anchor, schema);
  }
  const dynAnchor = s["$dynamicAnchor"];
  if (typeof dynAnchor === "string" && dynAnchor.length > 0) {
    out.set("dynamicAnchor:" + dynAnchor, schema);
  }

  const defs = s["$defs"];
  if (typeof defs === "object" && defs !== null && !Array.isArray(defs)) {
    const defsObj = defs as SchemaObject;
    for (const key of Object.keys(defsObj)) {
      const def = defsObj[key];
      if (def !== undefined && def !== null) {
        out.set("#/$defs/" + key, def as Schema);
        scanAnchors(def as Schema, base, out);
      }
    }
  }

  // Scan applicator keywords
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const arr = s[keyword];
    if (Array.isArray(arr)) {
      for (const sub of arr) {
        if (sub !== null && sub !== undefined) scanAnchors(sub as Schema, base, out);
      }
    }
  }
  for (const keyword of ["not", "if", "then", "else", "contains", "additionalProperties", "items", "propertyNames", "unevaluatedProperties", "unevaluatedItems"]) {
    const sub = s[keyword];
    if (sub !== null && sub !== undefined) scanAnchors(sub as Schema, base, out);
  }
  const properties = s["properties"];
  if (typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
    const props = properties as SchemaObject;
    for (const k of Object.keys(props)) {
      const sub = props[k];
      if (sub !== null && sub !== undefined) scanAnchors(sub as Schema, base, out);
    }
  }
  const patternProps = s["patternProperties"];
  if (typeof patternProps === "object" && patternProps !== null && !Array.isArray(patternProps)) {
    const pp = patternProps as SchemaObject;
    for (const k of Object.keys(pp)) {
      const sub = pp[k];
      if (sub !== null && sub !== undefined) scanAnchors(sub as Schema, base, out);
    }
  }
  const depSchemas = s["dependentSchemas"];
  if (typeof depSchemas === "object" && depSchemas !== null && !Array.isArray(depSchemas)) {
    const ds = depSchemas as SchemaObject;
    for (const k of Object.keys(ds)) {
      const sub = ds[k];
      if (sub !== null && sub !== undefined) scanAnchors(sub as Schema, base, out);
    }
  }
  const prefixItems = s["prefixItems"];
  if (Array.isArray(prefixItems)) {
    for (const sub of prefixItems) {
      if (sub !== null && sub !== undefined) scanAnchors(sub as Schema, base, out);
    }
  }
}

function resolveRef(ref: string, ctx: Context): Schema | null {
  // Direct anchor lookup
  const anchor = ctx.anchors.get(ref);
  if (anchor !== undefined) return anchor;

  // Fragment-only refs: #, #/..., #anchor
  if (ref === "#") return ctx.rootSchema;
  if (ref.startsWith("#/")) {
    const parts = ref.slice(2).split("/");
    let cur: JsonValue = ctx.rootSchema as JsonValue;
    for (const part of parts) {
      const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isJsonObject(cur)) return null;
      const next = (cur as JsonObject)[decoded];
      if (next === undefined) return null;
      cur = next;
    }
    return cur as Schema;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Core validation dispatch
// ---------------------------------------------------------------------------

function applySchema(
  schema: Schema,
  instance: JsonValue,
  ctx: Context,
  instancePath: string,
  schemaPath: string,
  errors: ValidationError[],
): Annotations {
  if (typeof schema === "boolean") {
    if (!schema) {
      errors.push(makeError(instancePath, schemaPath, "false schema", "schema is false"));
    }
    return instance === null
      ? emptyAnnotations()
      : emptyAnnotations();
  }

  const s = schema as SchemaObject;
  const annotations: Annotations = emptyAnnotations();

  // $ref
  const ref = s["$ref"];
  if (typeof ref === "string") {
    const resolved = resolveRef(ref, ctx);
    if (resolved !== null) {
      const refAnnotations = applySchema(
        resolved,
        instance,
        ctx,
        instancePath,
        schemaAt(schemaPath, "$ref"),
        errors,
      );
      annotations.evaluatedProps = new Set([...annotations.evaluatedProps, ...refAnnotations.evaluatedProps]);
      annotations.evaluatedItemCount = Math.max(annotations.evaluatedItemCount, refAnnotations.evaluatedItemCount);
    } else {
      errors.push(makeError(instancePath, schemaPath, "$ref", `Unresolvable $ref: ${ref}`));
    }
    // In 2020-12, $ref doesn't suppress sibling keywords
  }

  // $dynamicRef
  const dynamicRef = s["$dynamicRef"];
  if (typeof dynamicRef === "string" && dynamicRef.startsWith("#")) {
    const anchorName = dynamicRef.slice(1);
    // Walk dynamic scope from innermost to find a $dynamicAnchor match
    let target: Schema | null = null;
    for (let i = ctx.dynamicScope.length - 1; i >= 0; i--) {
      const scopeSchema = ctx.dynamicScope[i];
      if (typeof scopeSchema === "object" && scopeSchema !== null) {
        const da = (scopeSchema as SchemaObject)["$dynamicAnchor"];
        if (da === anchorName) {
          target = scopeSchema;
          break;
        }
      }
    }
    if (target === null) {
      // Fall back to static resolution
      target = ctx.anchors.get("dynamicAnchor:" + anchorName) ?? null;
    }
    if (target !== null) {
      const dynAnnotations = applySchema(target, instance, ctx, instancePath, schemaAt(schemaPath, "$dynamicRef"), errors);
      annotations.evaluatedProps = new Set([...annotations.evaluatedProps, ...dynAnnotations.evaluatedProps]);
      annotations.evaluatedItemCount = Math.max(annotations.evaluatedItemCount, dynAnnotations.evaluatedItemCount);
    }
  }

  // type
  const typeKw = s["type"];
  if (typeKw !== undefined) {
    const sp = schemaAt(schemaPath, "type");
    if (typeof typeKw === "string") {
      if (!checkType(typeKw, instance)) {
        errors.push(makeError(instancePath, sp, "type", `Expected type ${typeKw}, got ${jsonType(instance)}`));
      }
    } else if (Array.isArray(typeKw)) {
      const types = typeKw as readonly JsonValue[];
      const ok = types.some((t) => typeof t === "string" && checkType(t, instance));
      if (!ok) {
        errors.push(makeError(instancePath, sp, "type", `Expected one of [${types.join(",")}], got ${jsonType(instance)}`));
      }
    }
  }

  // const
  const constKw = s["const"];
  if (constKw !== undefined) {
    if (!jsonDeepEqual(instance, constKw as JsonValue)) {
      errors.push(makeError(instancePath, schemaAt(schemaPath, "const"), "const", "Value does not match const"));
    }
  }

  // enum
  const enumKw = s["enum"];
  if (Array.isArray(enumKw)) {
    const found = (enumKw as readonly JsonValue[]).some((v) => jsonDeepEqual(instance, v));
    if (!found) {
      errors.push(makeError(instancePath, schemaAt(schemaPath, "enum"), "enum", "Value is not in enum"));
    }
  }

  // --- Numeric keywords ---
  if (typeof instance === "number") {
    const multipleOf = s["multipleOf"];
    if (typeof multipleOf === "number" && multipleOf > 0) {
      const quotient = instance / multipleOf;
      if (Math.abs(Math.round(quotient) - quotient) > 1e-10) {
        errors.push(makeError(instancePath, schemaAt(schemaPath, "multipleOf"), "multipleOf", `${instance} is not a multiple of ${multipleOf}`));
      }
    }

    const maximum = s["maximum"];
    if (typeof maximum === "number" && instance > maximum) {
      errors.push(makeError(instancePath, schemaAt(schemaPath, "maximum"), "maximum", `${instance} > ${maximum}`));
    }
    const exclusiveMaximum = s["exclusiveMaximum"];
    if (typeof exclusiveMaximum === "number" && instance >= exclusiveMaximum) {
      errors.push(makeError(instancePath, schemaAt(schemaPath, "exclusiveMaximum"), "exclusiveMaximum", `${instance} >= ${exclusiveMaximum}`));
    }
    const minimum = s["minimum"];
    if (typeof minimum === "number" && instance < minimum) {
      errors.push(makeError(instancePath, schemaAt(schemaPath, "minimum"), "minimum", `${instance} < ${minimum}`));
    }
    const exclusiveMinimum = s["exclusiveMinimum"];
    if (typeof exclusiveMinimum === "number" && instance <= exclusiveMinimum) {
      errors.push(makeError(instancePath, schemaAt(schemaPath, "exclusiveMinimum"), "exclusiveMinimum", `${instance} <= ${exclusiveMinimum}`));
    }
  }

  // --- String keywords ---
  if (typeof instance === "string") {
    const maxLength = s["maxLength"];
    if (typeof maxLength === "number") {
      // Use Unicode code point count (not byte count)
      const codePoints = [...instance].length;
      if (codePoints > maxLength) {
        errors.push(makeError(instancePath, schemaAt(schemaPath, "maxLength"), "maxLength", `String length ${codePoints} > maxLength ${maxLength}`));
      }
    }
    const minLength = s["minLength"];
    if (typeof minLength === "number") {
      const codePoints = [...instance].length;
      if (codePoints < minLength) {
        errors.push(makeError(instancePath, schemaAt(schemaPath, "minLength"), "minLength", `String length ${codePoints} < minLength ${minLength}`));
      }
    }
    const pattern = s["pattern"];
    if (typeof pattern === "string") {
      const re = new RegExp(pattern, "u");
      if (!re.test(instance)) {
        errors.push(makeError(instancePath, schemaAt(schemaPath, "pattern"), "pattern", `String does not match pattern ${pattern}`));
      }
    }
  }

  // --- Array keywords ---
  if (isJsonArray(instance)) {
    const arr = instance;

    const maxItems = s["maxItems"];
    if (typeof maxItems === "number" && arr.length > maxItems) {
      errors.push(makeError(instancePath, schemaAt(schemaPath, "maxItems"), "maxItems", `Array length ${arr.length} > maxItems ${maxItems}`));
    }
    const minItems = s["minItems"];
    if (typeof minItems === "number" && arr.length < minItems) {
      errors.push(makeError(instancePath, schemaAt(schemaPath, "minItems"), "minItems", `Array length ${arr.length} < minItems ${minItems}`));
    }

    // uniqueItems
    const uniqueItems = s["uniqueItems"];
    if (uniqueItems === true) {
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const vi = arr[i];
          const vj = arr[j];
          if (vi !== undefined && vj !== undefined && jsonDeepEqual(vi, vj)) {
            errors.push(makeError(instancePath, schemaAt(schemaPath, "uniqueItems"), "uniqueItems", `Duplicate items at indices ${i} and ${j}`));
            break;
          }
        }
      }
    }

    // prefixItems (2020-12: validates items by index)
    const prefixItems = s["prefixItems"];
    let prefixCount = 0;
    if (Array.isArray(prefixItems)) {
      const prefixSchemas = prefixItems as readonly JsonValue[];
      prefixCount = Math.min(prefixSchemas.length, arr.length);
      for (let i = 0; i < prefixCount; i++) {
        const itemSchema = prefixSchemas[i];
        const item = arr[i];
        if (itemSchema !== undefined && item !== undefined) {
          applySchema(
            itemSchema as Schema,
            item,
            ctx,
            `${instancePath}/${i}`,
            schemaAt(schemaPath, "prefixItems", String(i)),
            errors,
          );
        }
      }
      annotations.evaluatedItemCount = Math.max(annotations.evaluatedItemCount, prefixCount);
    }

    // items (2020-12: validates items beyond prefixItems)
    const itemsKw = s["items"];
    if (itemsKw !== undefined && itemsKw !== null) {
      for (let i = prefixCount; i < arr.length; i++) {
        const item = arr[i];
        if (item !== undefined) {
          applySchema(
            itemsKw as Schema,
            item,
            ctx,
            `${instancePath}/${i}`,
            schemaAt(schemaPath, "items"),
            errors,
          );
        }
      }
      if (arr.length > prefixCount) {
        annotations.evaluatedItemCount = arr.length;
      }
    }

    // contains
    const containsKw = s["contains"];
    if (containsKw !== undefined && containsKw !== null) {
      const containsSchema = containsKw as Schema;
      const maxContains = s["maxContains"];
      const minContains = s["minContains"];
      const minC = typeof minContains === "number" ? minContains : 1;
      const maxC = typeof maxContains === "number" ? maxContains : Number.POSITIVE_INFINITY;

      let matchCount = 0;
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        if (item !== undefined) {
          const subErrors: ValidationError[] = [];
          applySchema(containsSchema, item, ctx, `${instancePath}/${i}`, schemaAt(schemaPath, "contains"), subErrors);
          if (subErrors.length === 0) matchCount++;
        }
      }

      if (matchCount < minC) {
        errors.push(makeError(instancePath, schemaAt(schemaPath, "contains"), "contains", `contains matched ${matchCount} items, minimum is ${minC}`));
      }
      if (matchCount > maxC) {
        errors.push(makeError(instancePath, schemaAt(schemaPath, "maxContains"), "maxContains", `contains matched ${matchCount} items, maximum is ${maxC}`));
      }
    }
  }

  // --- Object keywords ---
  if (isJsonObject(instance)) {
    const obj = instance;
    const objKeys = Object.keys(obj);

    const maxProperties = s["maxProperties"];
    if (typeof maxProperties === "number" && objKeys.length > maxProperties) {
      errors.push(makeError(instancePath, schemaAt(schemaPath, "maxProperties"), "maxProperties", `Object has ${objKeys.length} properties, max is ${maxProperties}`));
    }
    const minProperties = s["minProperties"];
    if (typeof minProperties === "number" && objKeys.length < minProperties) {
      errors.push(makeError(instancePath, schemaAt(schemaPath, "minProperties"), "minProperties", `Object has ${objKeys.length} properties, min is ${minProperties}`));
    }

    // required
    const requiredKw = s["required"];
    if (Array.isArray(requiredKw)) {
      for (const req of requiredKw as readonly JsonValue[]) {
        if (typeof req === "string" && !Object.prototype.hasOwnProperty.call(obj, req)) {
          errors.push(makeError(instancePath, schemaAt(schemaPath, "required"), "required", `Required property "${req}" is missing`));
        }
      }
    }

    // dependentRequired
    const depRequired = s["dependentRequired"];
    if (typeof depRequired === "object" && depRequired !== null && !Array.isArray(depRequired)) {
      const dr = depRequired as SchemaObject;
      for (const key of Object.keys(dr)) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          const deps = dr[key];
          if (Array.isArray(deps)) {
            for (const dep of deps as readonly JsonValue[]) {
              if (typeof dep === "string" && !Object.prototype.hasOwnProperty.call(obj, dep)) {
                errors.push(makeError(instancePath, schemaAt(schemaPath, "dependentRequired", key), "dependentRequired", `Property "${dep}" is required when "${key}" is present`));
              }
            }
          }
        }
      }
    }

    // properties, patternProperties, additionalProperties
    const propertiesKw = s["properties"];
    const patternPropsKw = s["patternProperties"];
    const additionalPropsKw = s["additionalProperties"];

    const evaluatedByProperties = new Set<string>();
    const evaluatedByPatternProps = new Set<string>();

    if (typeof propertiesKw === "object" && propertiesKw !== null && !Array.isArray(propertiesKw)) {
      const propsMap = propertiesKw as SchemaObject;
      for (const key of Object.keys(propsMap)) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          const propSchema = propsMap[key];
          const propValue = obj[key];
          if (propSchema !== undefined && propValue !== undefined) {
            applySchema(
              propSchema as Schema,
              propValue,
              ctx,
              `${instancePath}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
              schemaAt(schemaPath, "properties", key),
              errors,
            );
          }
          evaluatedByProperties.add(key);
        }
      }
    }

    if (typeof patternPropsKw === "object" && patternPropsKw !== null && !Array.isArray(patternPropsKw)) {
      const pp = patternPropsKw as SchemaObject;
      for (const pattern of Object.keys(pp)) {
        const re = new RegExp(pattern, "u");
        const patternSchema = pp[pattern];
        if (patternSchema !== undefined) {
          for (const key of objKeys) {
            if (re.test(key)) {
              const propValue = obj[key];
              if (propValue !== undefined) {
                applySchema(
                  patternSchema as Schema,
                  propValue,
                  ctx,
                  `${instancePath}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
                  schemaAt(schemaPath, "patternProperties", pattern),
                  errors,
                );
              }
              evaluatedByPatternProps.add(key);
            }
          }
        }
      }
    }

    const evaluatedHere = new Set([...evaluatedByProperties, ...evaluatedByPatternProps]);
    for (const k of evaluatedHere) annotations.evaluatedProps.add(k);

    if (additionalPropsKw !== undefined && additionalPropsKw !== null) {
      for (const key of objKeys) {
        if (!evaluatedByProperties.has(key) && !evaluatedByPatternProps.has(key)) {
          annotations.evaluatedProps.add(key);
          const propValue = obj[key];
          if (propValue !== undefined) {
            applySchema(
              additionalPropsKw as Schema,
              propValue,
              ctx,
              `${instancePath}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
              schemaAt(schemaPath, "additionalProperties"),
              errors,
            );
          }
        }
      }
    }

    // propertyNames
    const propertyNamesKw = s["propertyNames"];
    if (propertyNamesKw !== undefined && propertyNamesKw !== null) {
      for (const key of objKeys) {
        applySchema(
          propertyNamesKw as Schema,
          key,
          ctx,
          `${instancePath}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
          schemaAt(schemaPath, "propertyNames"),
          errors,
        );
      }
    }

    // dependentSchemas
    const depSchemas = s["dependentSchemas"];
    if (typeof depSchemas === "object" && depSchemas !== null && !Array.isArray(depSchemas)) {
      const ds = depSchemas as SchemaObject;
      for (const key of Object.keys(ds)) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          const depSchema = ds[key];
          if (depSchema !== undefined) {
            const depAnnotations = applySchema(
              depSchema as Schema,
              instance,
              ctx,
              instancePath,
              schemaAt(schemaPath, "dependentSchemas", key),
              errors,
            );
            for (const p of depAnnotations.evaluatedProps) annotations.evaluatedProps.add(p);
          }
        }
      }
    }
  }

  // --- Logic keywords ---

  // not
  const notKw = s["not"];
  if (notKw !== undefined && notKw !== null) {
    const notErrors: ValidationError[] = [];
    applySchema(notKw as Schema, instance, ctx, instancePath, schemaAt(schemaPath, "not"), notErrors);
    if (notErrors.length === 0) {
      errors.push(makeError(instancePath, schemaAt(schemaPath, "not"), "not", "Schema must not be valid"));
    }
  }

  // allOf
  const allOf = s["allOf"];
  if (Array.isArray(allOf)) {
    for (let i = 0; i < (allOf as readonly JsonValue[]).length; i++) {
      const subSchema = (allOf as readonly JsonValue[])[i];
      if (subSchema !== undefined) {
        const subAnnotations = applySchema(
          subSchema as Schema,
          instance,
          ctx,
          instancePath,
          schemaAt(schemaPath, "allOf", String(i)),
          errors,
        );
        const merged = mergeAnnotations(annotations, subAnnotations);
        annotations.evaluatedProps = merged.evaluatedProps;
        annotations.evaluatedItemCount = merged.evaluatedItemCount;
      }
    }
  }

  // anyOf
  const anyOf = s["anyOf"];
  if (Array.isArray(anyOf)) {
    const anyOfArr = anyOf as readonly JsonValue[];
    let anyValid = false;
    const anyErrors: ValidationError[] = [];
    for (let i = 0; i < anyOfArr.length; i++) {
      const subSchema = anyOfArr[i];
      if (subSchema !== undefined) {
        const branchErrors: ValidationError[] = [];
        const branchAnnotations = applySchema(
          subSchema as Schema,
          instance,
          ctx,
          instancePath,
          schemaAt(schemaPath, "anyOf", String(i)),
          branchErrors,
        );
        if (branchErrors.length === 0) {
          anyValid = true;
          const merged = mergeAnnotations(annotations, branchAnnotations);
          annotations.evaluatedProps = merged.evaluatedProps;
          annotations.evaluatedItemCount = merged.evaluatedItemCount;
        } else {
          for (const e of branchErrors) anyErrors.push(e);
        }
      }
    }
    if (!anyValid) {
      errors.push(makeError(instancePath, schemaAt(schemaPath, "anyOf"), "anyOf", "No schema in anyOf matched"));
      for (const e of anyErrors) errors.push(e);
    }
  }

  // oneOf
  const oneOf = s["oneOf"];
  if (Array.isArray(oneOf)) {
    const oneOfArr = oneOf as readonly JsonValue[];
    let validCount = 0;
    let validBranchAnnotations: Annotations = emptyAnnotations();
    const allBranchErrors: ValidationError[][] = [];
    for (let i = 0; i < oneOfArr.length; i++) {
      const subSchema = oneOfArr[i];
      if (subSchema !== undefined) {
        const branchErrors: ValidationError[] = [];
        const branchAnnotations = applySchema(
          subSchema as Schema,
          instance,
          ctx,
          instancePath,
          schemaAt(schemaPath, "oneOf", String(i)),
          branchErrors,
        );
        allBranchErrors.push(branchErrors);
        if (branchErrors.length === 0) {
          validCount++;
          validBranchAnnotations = mergeAnnotations(validBranchAnnotations, branchAnnotations);
        }
      }
    }
    if (validCount !== 1) {
      errors.push(makeError(instancePath, schemaAt(schemaPath, "oneOf"), "oneOf", `Expected exactly 1 schema to match in oneOf, got ${validCount}`));
    } else {
      const merged = mergeAnnotations(annotations, validBranchAnnotations);
      annotations.evaluatedProps = merged.evaluatedProps;
      annotations.evaluatedItemCount = merged.evaluatedItemCount;
    }
  }

  // if / then / else
  const ifKw = s["if"];
  if (ifKw !== undefined && ifKw !== null) {
    const ifErrors: ValidationError[] = [];
    const ifAnnotations = applySchema(
      ifKw as Schema,
      instance,
      ctx,
      instancePath,
      schemaAt(schemaPath, "if"),
      ifErrors,
    );
    const ifPassed = ifErrors.length === 0;
    if (ifPassed) {
      const merged = mergeAnnotations(annotations, ifAnnotations);
      annotations.evaluatedProps = merged.evaluatedProps;
      annotations.evaluatedItemCount = merged.evaluatedItemCount;
      const thenKw = s["then"];
      if (thenKw !== undefined && thenKw !== null) {
        const thenAnnotations = applySchema(
          thenKw as Schema,
          instance,
          ctx,
          instancePath,
          schemaAt(schemaPath, "then"),
          errors,
        );
        const m2 = mergeAnnotations(annotations, thenAnnotations);
        annotations.evaluatedProps = m2.evaluatedProps;
        annotations.evaluatedItemCount = m2.evaluatedItemCount;
      }
    } else {
      const elseKw = s["else"];
      if (elseKw !== undefined && elseKw !== null) {
        const elseAnnotations = applySchema(
          elseKw as Schema,
          instance,
          ctx,
          instancePath,
          schemaAt(schemaPath, "else"),
          errors,
        );
        const m2 = mergeAnnotations(annotations, elseAnnotations);
        annotations.evaluatedProps = m2.evaluatedProps;
        annotations.evaluatedItemCount = m2.evaluatedItemCount;
      }
    }
  }

  // unevaluatedProperties
  const unevalProps = s["unevaluatedProperties"];
  if (unevalProps !== undefined && unevalProps !== null && isJsonObject(instance)) {
    const obj = instance;
    for (const key of Object.keys(obj)) {
      if (!annotations.evaluatedProps.has(key)) {
        const propValue = obj[key];
        if (propValue !== undefined) {
          applySchema(
            unevalProps as Schema,
            propValue,
            ctx,
            `${instancePath}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
            schemaAt(schemaPath, "unevaluatedProperties"),
            errors,
          );
        }
      }
    }
  }

  // unevaluatedItems
  const unevalItems = s["unevaluatedItems"];
  if (unevalItems !== undefined && unevalItems !== null && isJsonArray(instance)) {
    const arr = instance;
    for (let i = annotations.evaluatedItemCount; i < arr.length; i++) {
      const item = arr[i];
      if (item !== undefined) {
        applySchema(
          unevalItems as Schema,
          item,
          ctx,
          `${instancePath}/${i}`,
          schemaAt(schemaPath, "unevaluatedItems"),
          errors,
        );
      }
    }
  }

  return annotations;
}

// ---------------------------------------------------------------------------
// Type checking
// ---------------------------------------------------------------------------

function jsonType(v: JsonValue): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  return "object";
}

function checkType(typeName: string, v: JsonValue): boolean {
  switch (typeName) {
    case "null": return v === null;
    case "boolean": return typeof v === "boolean";
    case "integer": return typeof v === "number" && Number.isInteger(v) && Number.isFinite(v);
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "string": return typeof v === "string";
    case "array": return Array.isArray(v);
    case "object": return typeof v === "object" && v !== null && !Array.isArray(v);
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a JSON value against a JSON Schema 2020-12 schema.
 *
 * @param schema - The JSON Schema (boolean or object).
 * @param instance - The JSON value to validate.
 * @returns Validation result with valid flag and list of errors.
 */
export function validate(schema: Schema, instance: JsonValue): ValidationResult {
  const anchors = new Map<string, Schema>();
  scanAnchors(schema, "", anchors);

  const ctx: Context = {
    rootSchema: schema,
    anchors,
    dynamicScope: [schema],
  };

  const errors: ValidationError[] = [];
  applySchema(schema, instance, ctx, "", "#", errors);
  return { valid: errors.length === 0, errors };
}
