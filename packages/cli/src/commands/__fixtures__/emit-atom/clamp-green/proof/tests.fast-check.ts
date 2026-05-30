// Property tests for the clamp fixture — emit-atom happy-path (DEC-WI954-012)
// Runs as a standalone script: node --import tsx proof/tests.fast-check.ts
// Exit 0 on pass, non-zero (unhandled exception) on counterexample found.

import * as fc from "fast-check";
import { clamp } from "../impl.js";

// Property: result is always in [min, max]
fc.assert(
  fc.property(fc.integer(), fc.integer(), fc.integer(), (v, a, b) => {
    const [min, max] = a <= b ? [a, b] : [b, a];
    const r = clamp(v, min, max);
    return r >= min && r <= max;
  }),
);

// Property: idempotent — clamp(clamp(v,a,b),a,b) === clamp(v,a,b)
fc.assert(
  fc.property(fc.integer(), fc.integer(), fc.integer(), (v, a, b) => {
    const [min, max] = a <= b ? [a, b] : [b, a];
    return clamp(clamp(v, min, max), min, max) === clamp(v, min, max);
  }),
);

console.log("clamp property tests: ok");
