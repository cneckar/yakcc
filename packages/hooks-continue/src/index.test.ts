/**
 * index.test.ts — re-export smoke test for @yakcc/hooks-continue
 *
 * Verifies that @yakcc/hooks-continue re-exports the same symbols as
 * @yakcc/hooks-cline (DEC-CLI-HOOK-INTERCEPT-CONTINUE-PKG-001).
 *
 * This is the "one-liner" test referenced in WI-753 §5 Required Tests item 5:
 *   "assert `import { createHook } from "@yakcc/hooks-continue"` resolves to
 *    the same symbol as `import { createHook } from "@yakcc/hooks-cline"`."
 */

import { describe, expect, it } from "vitest";
import * as continueExports from "@yakcc/hooks-continue";
import * as clineExports from "@yakcc/hooks-cline";

describe("@yakcc/hooks-continue re-export parity", () => {
  it("exports the same named symbols as @yakcc/hooks-cline", () => {
    const continueKeys = Object.keys(continueExports).sort();
    const clineKeys = Object.keys(clineExports).sort();
    expect(continueKeys).toEqual(clineKeys);
  });

  it("each exported symbol is referentially identical to the cline export", () => {
    for (const key of Object.keys(clineExports)) {
      expect(continueExports[key as keyof typeof continueExports]).toBe(
        clineExports[key as keyof typeof clineExports],
      );
    }
  });
});
