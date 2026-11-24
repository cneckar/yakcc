// SPDX-License-Identifier: MIT
// A small seeded generator (mulberry32) so generated inputs are the same on every build.
import { createHash } from "node:crypto";

export function rngFor(seedText) {
  let a = createHash("sha256").update(seedText).digest().readUInt32LE(0);
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n) };
}
