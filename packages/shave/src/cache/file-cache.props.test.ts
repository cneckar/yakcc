// SPDX-License-Identifier: MIT
// Vitest harness for cache/file-cache.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { describe, it } from "vitest";
import * as Props from "./file-cache.props.js";

describe("cache/file-cache.ts — Path A property corpus", () => {
  it("property: readIntent — cache miss returns undefined (ENOENT path)", async () => {
    await fc.assert(Props.prop_readIntent_miss_returns_undefined);
  });

  it("property: readIntent — returns written value after matching writeIntent (round-trip)", async () => {
    await fc.assert(Props.prop_readIntent_returns_written_value);
  });

  it("property: readIntent — deterministic (two reads of same key return equal values)", async () => {
    await fc.assert(Props.prop_readIntent_is_deterministic);
  });

  it("property: readIntent — corrupt entry returns undefined and removes file (self-healing)", async () => {
    await fc.assert(Props.prop_readIntent_corrupt_entry_returns_undefined_and_deletes);
  });

  it("property: writeIntent — shard directory is first 3 hex chars of key", async () => {
    await fc.assert(Props.prop_writeIntent_shard_dir_is_key_prefix);
  });

  it("property: writeIntent — file path ends with '<key>.json' inside shard dir", async () => {
    await fc.assert(Props.prop_writeIntent_file_path_ends_with_key_json);
  });

  it("property: writeIntent — idempotent overwrite (second write of same key is readable)", async () => {
    await fc.assert(Props.prop_writeIntent_idempotent_overwrite);
  });

  it("property: writeIntent — preserves all IntentCard fields without mutation", async () => {
    await fc.assert(Props.prop_writeIntent_preserves_all_card_fields);
  });

  it("property: writeIntent — produces valid JSON on disk", async () => {
    await fc.assert(Props.prop_writeIntent_produces_valid_json_on_disk);
  });

  it("property: cachePaths — shard is always exactly 3 characters", async () => {
    await fc.assert(Props.prop_cachePaths_shard_is_always_3_chars);
  });

  it("property: writeIntent → readIntent — compound: full pipeline is round-trip faithful", async () => {
    await fc.assert(Props.prop_writeIntent_readIntent_compound_pipeline);
  });
});
