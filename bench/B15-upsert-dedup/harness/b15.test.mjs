// SPDX-License-Identifier: MIT
// B15 self-test: the upsert check's pieces on hand-written functions. A rewrite of a function
// is equivalent to it; an off-by-one is near or different, with the input it differs on; a
// function that returns nothing useful is inconclusive; behavior search finds a stored twin
// whose text says nothing about it.
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { probeArgs } from "../../B12-need-to-code/harness/cards.mjs";
import {
  compareRuns,
  fitsType,
  kindsOf,
  probeInputs,
  runInputs,
  standaloneCallable,
  timeCalls,
  uniqueInputs,
  upsertCheck,
  verdict,
} from "./dedup.mjs";
import { fnName, implPrompt } from "./write-impls.mjs";
import { summarize } from "./run.mjs";

const fn = (code) => {
  const c = standaloneCallable(code);
  assert.equal(c.callable, true, c.reason);
  return c;
};
const reverseLoop = fn(
  "export function rev(s: string) { let o = ''; for (let i = s.length - 1; i >= 0; i--) o += s[i]; return o; }",
);
const reverseSplit = fn("export function r(s) { return String(s).split('').reverse().join(''); }");
const upper = fn("export function up(s) { return String(s).toUpperCase(); }");
const sumTo = fn("export function sum(n) { let t = 0; for (let i = 1; i <= n; i++) t += i; return t; }");
const sumClosed = fn("export function s(n) { return n >= 1 ? Math.floor(n) * (Math.floor(n) + 1) / 2 : 0; }");
const sumOffByOne = fn("export function s(n) { let t = 0; for (let i = 1; i < n; i++) t += i; return t; }");
const nothing = fn("export function f() { return undefined; }");

const cmp = (a, b, types = ["string"]) => {
  const inputs = probeInputs(1, types);
  return compareRuns(inputs, runInputs(a, inputs), runInputs(b, inputs));
};

describe("verdicts", () => {
  it("two rewrites of string reversal are equivalent", () => {
    assert.equal(verdict(cmp(reverseLoop, reverseSplit)), "equivalent");
  });
  it("different behavior is different, with counterexamples", () => {
    const c = cmp(reverseLoop, upper);
    assert.equal(verdict(c), "different");
    assert.ok(c.counterexamples.length > 0);
  });
  it("an off-by-one is not equivalent, and the differing input is reported", () => {
    const inputs = [[1], [2], [3], [4], [10], [100]];
    const c = compareRuns(inputs, runInputs(sumTo, inputs), runInputs(sumOffByOne, inputs));
    assert.notEqual(verdict(c), "equivalent");
    assert.deepEqual(c.counterexamples[0].args, [1]);
  });
  it("loop and closed form agree on positive integers", () => {
    const inputs = [[1], [2], [3], [10], [100], [0]];
    assert.equal(
      verdict(compareRuns(inputs, runInputs(sumTo, inputs), runInputs(sumClosed, inputs))),
      "equivalent",
    );
  });
  it("probes stay inside the declared types", () => {
    assert.ok(probeInputs(1, ["string"]).every(([v]) => typeof v === "string"));
    assert.equal(probeInputs(1, ["unknown"]).length, probeArgs(1).length);
    assert.deepEqual([...kindsOf("string[] | number")].sort(), ["array", "number", "string"]);
    assert.deepEqual([...kindsOf("[string, string][]")], ["array"]);
    assert.equal(fitsType([["a", "b"]], "[string, string][]"), true);
    assert.equal(fitsType([1, 2, 3], "[string, string][]"), false);
    assert.equal(fitsType([], "number[]"), true);
  });
  it("functions that return nothing useful are inconclusive, not equivalent", () => {
    assert.equal(verdict(cmp(nothing, nothing)), "inconclusive");
  });
  it("near: holds the new block's examples, differs on a minority of other inputs", () => {
    const all = { comparable: 10, agree: 9, informative: 8, distinct: 5, counterexamples: [] };
    assert.equal(verdict(all, { comparable: 3, agree: 3 }), "near");
    assert.equal(verdict(all, { comparable: 3, agree: 2 }), "different");
  });
});

describe("sandbox", () => {
  it("a hang is bounded and the input is not comparable", () => {
    const hang = fn("export function h(s) { for (;;) {} }");
    const c = compareRuns([["a"]], runInputs(hang, [["a"]]), runInputs(reverseLoop, [["a"]]));
    assert.equal(c.comparable, 0);
  });
  it("new code has no host globals", () => {
    const leak = fn("export function l() { return typeof process + typeof require; }");
    assert.deepEqual(runInputs(leak, [[]])[0], { ok: true, value: "undefinedundefined" });
  });
  it("times a call", () => {
    assert.ok(timeCalls(reverseLoop, [["hello"]], 5) > 0);
  });
  it("dedupes inputs", () => {
    assert.equal(uniqueInputs([[1], [1], ["1"]]).length, 2);
  });
});

describe("upsertCheck", () => {
  const atom = (id, callable) => ({
    id,
    card: { examples: [] },
    callable,
    fingerprint: runInputs(callable, probeInputs(1, ["string"])),
  });
  const atoms = [atom("upper", upper), atom("reverse", reverseSplit), atom("sum", sumTo)];
  it("behavior finds the stored twin first, even when text search misses it", () => {
    const r = upsertCheck({
      newCallable: reverseLoop,
      arity: 1,
      paramTypes: ["string"],
      newExamples: [{ args: ["abc"] }],
      atoms,
      textIds: ["upper"],
      k: 1,
    });
    assert.equal(r.behaviorIds[0], "reverse");
    assert.equal(r.neighbors[0].id, "reverse");
    assert.equal(r.neighbors[0].verdict, "equivalent");
    assert.equal(r.neighbors[0].fromBehavior, true);
    assert.ok(r.neighbors[0].timing.ratio > 0);
    assert.equal(r.neighbors.find((n) => n.id === "upper").verdict, "different");
  });
});

describe("generator and summary", () => {
  it("names and prompts", () => {
    assert.equal(fnName("duration-to-ms"), "durationToMs");
    assert.equal(fnName("1-x"), "f1X");
    const p = implPrompt({
      id: "a-b",
      need: "Do it.",
      inputs: [{ name: "x", type: "string" }],
      output: "number",
      examples: [{ args: ["q"], returns: 1 }],
    });
    assert.match(p, /export function aB\(x: string\): number/);
    assert.match(p, /aB\("q"\) → 1/);
  });
  it("summarizes recall, verdicts and mutants", () => {
    const s = summarize(
      [
        {
          query: "a",
          passesOwnExamples: true,
          textRank: 2,
          behaviorRank: 1,
          targetVerdict: "equivalent",
          targetTiming: { ratio: 0.5 },
          otherEquivalent: [],
          topIsTarget: true,
          mutants: ["different", "equivalent"],
        },
        { query: "b", skipped: "x" },
      ],
      5,
    );
    assert.equal(s.scored, 1);
    assert.equal(s.targetFound.union, 1);
    assert.equal(s.mutants.falseEquivalent, 0.5);
    assert.equal(s.speed.newFaster, 1);
  });
});
