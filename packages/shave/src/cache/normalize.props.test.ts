// SPDX-License-Identifier: MIT
// Vitest harness for cache/normalize.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { describe, it } from "vitest";
import * as Props from "./normalize.props.js";

describe("cache/normalize.ts — Path A property corpus", () => {
  it("property: normalizeSource — no \\r\\n in output", () => {
    fc.assert(Props.prop_normalizeSource_no_crlf_in_output);
  });

  it("property: normalizeSource — no leading/trailing whitespace in output", () => {
    fc.assert(Props.prop_normalizeSource_no_leading_trailing_whitespace);
  });

  it("property: normalizeSource — idempotent", () => {
    fc.assert(Props.prop_normalizeSource_idempotent);
  });

  it("property: normalizeSource — preserves inner LF separators", () => {
    fc.assert(Props.prop_normalizeSource_preserves_inner_lf);
  });

  it("property: normalizeSource — CRLF replaced by LF only (no orphan CR)", () => {
    fc.assert(Props.prop_normalizeSource_crlf_replaced_by_lf_only);
  });

  it("property: normalizeSource — compound: CRLF and LF inputs produce identical normalized form", () => {
    fc.assert(Props.prop_normalizeSource_compound_crlf_lf_equivalence);
  });
});
