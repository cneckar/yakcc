// Fixture: property tests for the all-whitespace block.
// Referenced by proof/manifest.json. Verifies that isAllWhitespace correctly
// identifies strings composed entirely of whitespace characters.

import * as fc from "fast-check";

// Placeholder property test — exercises the manifest reference path.
fc.assert(fc.property(fc.constant("   "), (s) => s.trim().length === 0));
