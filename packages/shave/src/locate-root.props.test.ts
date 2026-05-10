// SPDX-License-Identifier: MIT
// Vitest harness for locate-root.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { describe, it } from "vitest";
import * as Props from "./locate-root.props.js";

describe("locate-root.ts — Path A property corpus", () => {
  it("property: locateProjectRoot — fallback returns start when no workspace file found", async () => {
    await fc.assert(Props.prop_locateProjectRoot_fallback_returns_start, { numRuns: 10 });
  });

  it("property: locateProjectRoot — detects workspace file at start itself", async () => {
    await fc.assert(Props.prop_locateProjectRoot_detects_root_at_start, { numRuns: 10 });
  });

  it("property: locateProjectRoot — finds ancestor containing workspace file", async () => {
    await fc.assert(Props.prop_locateProjectRoot_finds_ancestor_with_workspace_file, {
      numRuns: 10,
    });
  });

  it("property: locateProjectRoot — result is always a string", async () => {
    await fc.assert(Props.prop_locateProjectRoot_returns_string, { numRuns: 10 });
  });

  it("property: locateProjectRoot + fallback — compound: result is ancestor of start", async () => {
    await fc.assert(Props.prop_locateProjectRoot_compound_result_is_ancestor_of_start, {
      numRuns: 10,
    });
  });
});
