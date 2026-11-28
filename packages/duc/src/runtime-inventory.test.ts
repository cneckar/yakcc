// SPDX-License-Identifier: Apache-2.0
/**
 * The native runtime's inventory (#1516): every section of runtime/* classified, the document
 * current, and the hand-written lines to replace only falling.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inventoryMarkdown, inventoryTotals, runtimeInventory } from "./runtime-inventory.js";

const here = dirname(fileURLToPath(import.meta.url));
const runtime = join(here, "../runtime");
const doc = join(here, "../../../docs/duc/runtime-inventory-1516.md");

/**
 * The lines to replace. A change may lower it (delete scaffolding as atoms replace it, then lower
 * this); none raises it: no built-in or engine feature is added to the runtime (#1361's direction,
 * 2026-11-27). 15,008 when the inventory was made (main at #1521); 15,219 when the leaves left
 * runtime/ for LLVM (native-leaves.ts, native-system.ts): 698 lines deleted, and 211 lines of
 * BigInt()'s and the C library's code that had sat in the leaves' sections counted as what they are;
 * 15,206 when BigInt's arithmetic became V8's own (src/bigint, shaved).
 */
const CEILING = 15_206;

describe("the native runtime's inventory (#1516)", () => {
  const sections = runtimeInventory(runtime);

  it("classifies every section of runtime/*, and names no section the runtime lacks", () => {
    expect(sections.length).toBeGreaterThan(0);
  });

  it("only falls: the hand-written lines to replace are at most the ceiling", () => {
    const { toReplace } = inventoryTotals(sections);
    expect(toReplace).toBeLessThanOrEqual(CEILING);
  });

  it("is the document docs/duc/runtime-inventory-1516.md", () => {
    const want = inventoryMarkdown(sections);
    if (process.env.YAKCC_UPDATE_INVENTORY === "1") writeFileSync(doc, want);
    expect(readFileSync(doc, "utf8")).toBe(want);
  });
});
