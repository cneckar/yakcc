// SPDX-License-Identifier: MIT
// Vitest harness for cache/types.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { describe, it } from "vitest";
import * as Props from "./types.props.js";

describe("cache/types.ts — Path A property corpus", () => {
  it("property: CacheKey — has required string fields", () => {
    fc.assert(Props.prop_CacheKey_has_required_string_fields);
  });

  it("property: CacheKey — sourceHash is a 64-char hex string", () => {
    fc.assert(Props.prop_CacheKey_sourceHash_is_64_char_hex);
  });

  it("property: CacheEntry — has required fields with correct types", () => {
    fc.assert(Props.prop_CacheEntry_has_required_fields);
  });

  it("property: CacheEntry — cacheVersion is always the literal 1", () => {
    fc.assert(Props.prop_CacheEntry_cacheVersion_is_literal_1);
  });

  it("property: CacheEntry — cachedAt is a non-negative finite number", () => {
    fc.assert(Props.prop_CacheEntry_cachedAt_is_non_negative_finite);
  });

  it("property: CacheEntry — card.schemaVersion is always 1", () => {
    fc.assert(Props.prop_CacheEntry_card_schemaVersion_is_1);
  });

  it("property: CacheKey + CacheEntry — compound: sourceHash alignment invariant", () => {
    fc.assert(Props.prop_CacheKey_CacheEntry_compound_sourceHash_alignment);
  });
});
