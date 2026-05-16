# Task: Cycle-Safe Deep Clone

Implement a TypeScript function that deep-clones a JavaScript value with full structural fidelity.

```typescript
export default function deepClone<T>(value: T): T;
```

## Requirements

### Supported types

The function must correctly handle all of the following:

1. **Primitives** (`null`, `undefined`, `boolean`, `number`, `string`, `bigint`, `symbol`): returned as-is (primitives are immutable, no deep copy needed).
2. **Plain objects** (`{}`): recursively clone own enumerable AND non-enumerable string-keyed properties, preserving property descriptors is out of scope — key-value copy is sufficient. Also preserve **symbol-keyed own properties**.
3. **Arrays** (`[]`): recursively clone elements. Sparse array holes are preserved.
4. **`Date`**: clone as `new Date(original.getTime())`. The clone must be `instanceof Date` and have the same `getTime()`.
5. **`RegExp`**: clone as `new RegExp(original.source, original.flags)`. The clone must be `instanceof RegExp`, with `.source` and `.flags` preserved. Reset `lastIndex` to 0 on the clone.
6. **`Map`**: clone as a new `Map` with recursively deep-cloned entries (both keys and values).
7. **`Set`**: clone as a new `Set` with recursively deep-cloned values.
8. **`ArrayBuffer`**: clone via `original.slice(0)`.
9. **Typed arrays** (`Int8Array`, `Uint8Array`, `Float32Array`, etc.): clone by slicing the underlying buffer.
10. **Functions**: return by reference (do NOT deep-copy functions). `clone.fn === original.fn` must hold.
11. **Class instances**: preserve prototype chain. Clone must satisfy `Object.getPrototypeOf(clone) === Object.getPrototypeOf(original)`.

### Cycle safety (primary adversarial trap)

If the input object graph contains a cycle (`a.self = a`), the function must NOT infinite-loop or stack-overflow. Instead, it must return a cloned graph with the same cyclic structure: if `original.x === original`, then `clone.x === clone`.

Use a `WeakMap<original, clone>` to track visited objects and detect cycles.

### `undefined` property values

`{a: undefined}` must be preserved: `Object.hasOwn(clone, "a")` must be `true` and `clone.a === undefined`.

## Export

Default export:

```typescript
export default deepClone;
```

## Notes

- Use only TypeScript / Node.js built-ins. No external libraries.
- The implementation must be a single `.ts` file.
- Lodash's `cloneDeep` is the reference behavior for this task. The hook's atom for this task is `cloneDeep.js` (which delegates to `_baseClone.js`). The implementation must match lodash's documented semantics for the types above.
- Error values (`new Error("msg")`): out of scope — you may return them by reference or attempt to clone their message. The oracle does not test `Error` cloning.
- `WeakMap` / `WeakSet` / `WeakRef`: out of scope — cannot be structurally cloned.
- `Promise`: out of scope — return by reference.
