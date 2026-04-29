// Fixture: property tests for the digit-of block.
// Referenced by proof/manifest.json. Contains fast-check property tests
// that verify digitOf maps '0'-'9' to 0-9 correctly.

import * as fc from "fast-check";
import { digitOf } from "../impl.js";

fc.assert(fc.property(fc.integer({ min: 0, max: 9 }), (n) => digitOf(String(n)) === n));
