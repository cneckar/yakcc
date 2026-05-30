// Property tests for clamp-failing-tests fixture.
// The impl returns value unclamped, so the bounded property WILL fail.
// This file is used to verify that emit-atom exits 5 when tests fail (DEC-WI954-012).

import * as fc from "fast-check";
import { clamp } from "../impl.js";

// This assertion will fail: the broken impl returns value unchanged.
fc.assert(
  fc.property(fc.integer(), fc.integer(), fc.integer(), (v, a, b) => {
    const [min, max] = a <= b ? [a, b] : [b, a];
    const r = clamp(v, min, max);
    return r >= min && r <= max;
  }),
);

console.log("clamp property tests: ok");
