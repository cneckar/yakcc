Implement a JSON Schema Draft-07 validator supporting the following keywords:
`type`, `required`, `properties`, `additionalProperties`, `enum`,
`minimum`, `maximum`, `minLength`, `maxLength`, `pattern`.

Export a **single class**:

```typescript
export interface ValidationResult {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
}

export class JsonSchemaValidator {
  /** Compile a schema (validate it on construction; throw TypeError if the schema itself is invalid). */
  constructor(schema: Record<string, unknown>);
  /** Validate `data` against the compiled schema. */
  validate(data: unknown): ValidationResult;
}
```

Constraints:
- No external libraries.
- `additionalProperties: false` must reject any property not listed under `properties`.
- `pattern` is a regex string; use `new RegExp(pattern)` for matching.
- `type` can be a string (`"string"`, `"number"`, `"integer"`, `"boolean"`, `"array"`, `"object"`, `"null"`)
  or an array of those.
- `errors` should include the JSON path to the failing field (e.g., `"$.name"`, `"$.address.zip"`).
- Nested `properties` must be validated recursively.

Test cases:
- Schema `{ type: "object", required: ["name"], properties: { name: { type: "string" } }, additionalProperties: false }`
  - `{ name: "Alice" }` → `{ valid: true, errors: [] }`
  - `{ name: 123 }` → `{ valid: false, errors: [{ path: "$.name", message: "expected string" }] }`
  - `{ name: "Alice", extra: 1 }` → `{ valid: false, errors: [{ path: "$.extra", message: "additional property not allowed" }] }`
  - `{}` → `{ valid: false, errors: [{ path: "$", message: "required property 'name' missing" }] }`
