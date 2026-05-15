// SPDX-License-Identifier: MIT
//
// as-parity-runner.test.ts — unit tests for computeAscConcurrency + processAtomsInParallel
//
// @decision DEC-AS-CLOSER-PARITY-CONCURRENCY-001

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeAscConcurrency, processAtomsInParallel } from "./as-parity-runner.js";

// ---------------------------------------------------------------------------
// computeAscConcurrency
// ---------------------------------------------------------------------------

describe("computeAscConcurrency", () => {
  let origOverride: string | undefined;
  let origCI: string | undefined;

  beforeEach(() => {
    origOverride = process.env.YAKCC_AS_PARITY_CONCURRENCY;
    origCI = process.env.CI;
  });

  afterEach(() => {
    // Restore original env values exactly (undefined means "was not set").
    if (origOverride === undefined) {
      process.env.YAKCC_AS_PARITY_CONCURRENCY = undefined;
    } else {
      process.env.YAKCC_AS_PARITY_CONCURRENCY = origOverride;
    }
    if (origCI === undefined) {
      process.env.CI = undefined;
    } else {
      process.env.CI = origCI;
    }
  });

  it("returns ≤4 in CI mode (opts.ci=true)", () => {
    process.env.YAKCC_AS_PARITY_CONCURRENCY = undefined;
    process.env.CI = undefined;
    const n = computeAscConcurrency({ ci: true });
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(4);
  });

  it("returns ≤6 in dev mode (opts.ci=false)", () => {
    process.env.YAKCC_AS_PARITY_CONCURRENCY = undefined;
    process.env.CI = undefined;
    const n = computeAscConcurrency({ ci: false });
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(6);
  });

  it("detects CI=true from env var", () => {
    process.env.YAKCC_AS_PARITY_CONCURRENCY = undefined;
    process.env.CI = "true";
    const n = computeAscConcurrency();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(4);
  });

  it("detects CI=1 from env var", () => {
    process.env.YAKCC_AS_PARITY_CONCURRENCY = undefined;
    process.env.CI = "1";
    const n = computeAscConcurrency();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(4);
  });

  it("YAKCC_AS_PARITY_CONCURRENCY=1 returns 1 (rollback/serial path)", () => {
    process.env.YAKCC_AS_PARITY_CONCURRENCY = "1";
    process.env.CI = undefined;
    expect(computeAscConcurrency({ ci: false })).toBe(1);
    expect(computeAscConcurrency({ ci: true })).toBe(1);
  });

  it("YAKCC_AS_PARITY_CONCURRENCY=12 returns 12 (user over-provision)", () => {
    process.env.YAKCC_AS_PARITY_CONCURRENCY = "12";
    expect(computeAscConcurrency({ ci: true })).toBe(12);
    expect(computeAscConcurrency({ ci: false })).toBe(12);
  });

  it("YAKCC_AS_PARITY_CONCURRENCY=0 ignores invalid value and uses defaults", () => {
    process.env.YAKCC_AS_PARITY_CONCURRENCY = "0";
    process.env.CI = undefined;
    const n = computeAscConcurrency({ ci: true });
    // Falls through to default CI cap (4)
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(4);
  });

  it("YAKCC_AS_PARITY_CONCURRENCY=NaN ignores invalid value and uses defaults", () => {
    process.env.YAKCC_AS_PARITY_CONCURRENCY = "NaN";
    process.env.CI = undefined;
    const n = computeAscConcurrency({ ci: true });
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(4);
  });

  it("always returns ≥1", () => {
    process.env.YAKCC_AS_PARITY_CONCURRENCY = undefined;
    process.env.CI = undefined;
    const n = computeAscConcurrency({ ci: true });
    expect(n).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// processAtomsInParallel
// ---------------------------------------------------------------------------

describe("processAtomsInParallel", () => {
  it("empty items resolves to []", async () => {
    const result = await processAtomsInParallel([], async () => "x", 4);
    expect(result).toEqual([]);
  });

  it("returns results in input order (index-stable)", async () => {
    const items = [10, 20, 30, 40, 50];
    const result = await processAtomsInParallel(items, async (x, idx) => ({ val: x * 2, idx }), 3);
    expect(result).toEqual([
      { val: 20, idx: 0 },
      { val: 40, idx: 1 },
      { val: 60, idx: 2 },
      { val: 80, idx: 3 },
      { val: 100, idx: 4 },
    ]);
  });

  it("respects concurrency cap (peak in-flight ≤ concurrency)", async () => {
    const concurrency = 4;
    const itemCount = 100;
    let inFlight = 0;
    let peakInFlight = 0;

    const items = Array.from({ length: itemCount }, (_, i) => i);
    await processAtomsInParallel(
      items,
      async (item) => {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        // Simulate async work
        await new Promise<void>((r) => setTimeout(r, 1));
        inFlight--;
        return item;
      },
      concurrency,
    );

    expect(peakInFlight).toBeLessThanOrEqual(concurrency);
  });

  it("processes all items (100 items, concurrency=4)", async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const result = await processAtomsInParallel(items, async (x) => x * 3, 4);
    expect(result).toHaveLength(100);
    for (let i = 0; i < 100; i++) {
      expect(result[i]).toBe(i * 3);
    }
  });

  it("concurrency=1 produces results in input order (serial-equivalent)", async () => {
    const order: number[] = [];
    const items = [0, 1, 2, 3, 4];
    const results = await processAtomsInParallel(
      items,
      async (x) => {
        order.push(x);
        return x;
      },
      1,
    );
    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("worker throws on one item → processAtomsInParallel rejects", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    await expect(
      processAtomsInParallel(
        items,
        async (x) => {
          if (x === 5) throw new Error("boom at 5");
          return x;
        },
        4,
      ),
    ).rejects.toThrow("boom at 5");
  });

  it("concurrency clamped: concurrency > items.length → still resolves", async () => {
    const items = [1, 2, 3];
    const result = await processAtomsInParallel(items, async (x) => x + 10, 100);
    expect(result).toEqual([11, 12, 13]);
  });
});
