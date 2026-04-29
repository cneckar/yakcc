// Fixture: property tests for the add-numbers block.
// Referenced by proof/manifest.json. Verifies the commutative property
// of addNumbers via fast-check.

import * as fc from "fast-check";
import { addNumbers } from "../impl.js";

fc.assert(fc.property(fc.float(), fc.float(), (a, b) => addNumbers(a, b) === addNumbers(b, a)));
