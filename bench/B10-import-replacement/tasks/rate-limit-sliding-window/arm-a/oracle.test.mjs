// SPDX-License-Identifier: MIT
// T-A-3: rate-limit-sliding-window oracle
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let pThrottle;
try {
  // p-throttle is ESM; use dynamic import
  const pThrottlePath = join(__dirname, "../../../../node_modules/p-throttle/index.js");
  pThrottle = (await import(pathToFileURL(pThrottlePath).href)).default;
} catch { pThrottle = null; }

const { rateLimitSlidingWindow } = await import(pathToFileURL(join(__dirname, "fine.mjs")).href);

describe("T-A-3: rate-limit-sliding-window oracle", () => {
  it("throttled function invokes and returns result (20 calls)", async () => {
    let callCount = 0;
    const fn = async (x) => { callCount++; return x * 2; };
    const throttled = rateLimitSlidingWindow(fn, 5, 100);
    const results = await Promise.all(Array.from({length: 20}, (_, i) => throttled(i)));
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(results[i], i * 2);
    }
    assert.strictEqual(callCount, 20);
  });

  it("throws on invalid limit", () => {
    assert.throws(() => rateLimitSlidingWindow(() => {}, 0, 100), TypeError);
    assert.throws(() => rateLimitSlidingWindow(() => {}, -1, 100), TypeError);
  });
});
