// SPDX-License-Identifier: MIT
// B12 self-test: the sandbox, the cards, the matching stages, the metrics, the seed set's
// integrity, and the committed results. No model API calls and no embedding model.
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { degenerate, docAbove, paramNames, probe, trivial, typeOfTagged } from "./cards.mjs";
import { confirmPrompt, requestText, scorePick, summarizePicks } from "./confirm.mjs";
import { sample } from "./generate-queries.mjs";
import {
  capPerPackage,
  decide,
  executionRerank,
  isTarget,
  normalizeType,
  rrf,
  runExamples,
  signatureScore,
} from "./match.mjs";
import { auroc, mrr, recallAt, summarizeConfig } from "./metrics.mjs";
import { extractJson, maskName, modelClient } from "./model.mjs";
import { FIXTURES, bareContext, callTagged, resolveCallable, taggedEqual } from "./sandbox.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bench = join(here, "..");
const seed = JSON.parse(readFileSync(join(bench, "queries", "seed.json"), "utf8"));

describe("sandbox", () => {
  it("calls an internal helper the module never exports", () => {
    const c = resolveCallable("ms-2.1.3/index.js", "parse");
    assert.equal(c.callable, true);
    assert.deepEqual(callTagged(c, ["2h"]), { ok: true, value: 7200000 });
  });
  it("compares Maps, Sets, Dates and bytes by value across the context boundary", () => {
    const c = resolveCallable("toposort-2.0.2/index.js", "makeOutgoingEdges");
    const r = callTagged(c, [[["a", "b"]]]);
    assert.deepEqual(r.value, {
      $map: [
        ["a", { $set: ["b"] }],
        ["b", { $set: [] }],
      ],
    });
    const d = resolveCallable("date-fns-4.1.0/addDays.cjs", "addDays");
    assert.deepEqual(callTagged(d, [{ $date: "2024-01-31T00:00:00.000Z" }, 1]).value, {
      $date: "2024-02-01T00:00:00.000Z",
    });
  });
  it("has no host globals, refuses built-ins, and bounds every call with a timeout", () => {
    const ctx = bareContext();
    assert.equal(vm.runInContext("typeof process + typeof require", ctx), "undefinedundefined");
    const loop = { context: ctx, fn: vm.runInContext("(function(){ for(;;){} })", ctx) };
    assert.deepEqual(callTagged(loop, []), { ok: false, error: "timeout" });
    const crypto = resolveCallable("nanoid-3.3.12/index.cjs", "nanoid");
    assert.equal(crypto.callable, false);
    assert.match(crypto.reason, /require\("crypto"\)/);
  });
  it("a class is not callable, and neither is a name that is not top level", () => {
    assert.equal(resolveCallable("semver-7.8.0/internal/lrucache.js", "LRUCache").reason, "class");
    assert.equal(resolveCallable("semver-7.8.0/classes/semver.js", "compareMain").callable, false);
  });
  it("numbers compare within a relative 1e-9", () => {
    assert.equal(taggedEqual(0.1 + 0.2, 0.3), true);
    assert.equal(taggedEqual(1, 1.001), false);
    assert.equal(taggedEqual({ $type: "undefined" }, { $type: "undefined" }), true);
  });
});

describe("cards", () => {
  it("reads parameter names and the JSDoc description above a definition", () => {
    assert.deepEqual(paramNames("function f(a, { b }, ...c) {}"), ["a", "_", "c"]);
    const ms = readFileSync(join(FIXTURES, "ms-2.1.3/index.js"), "utf8");
    assert.equal(docAbove(ms, 113), "Short format for `ms`.");
    assert.equal(docAbove("const a = 1;\nfunction f() {}", 2), null);
  });
  it("probing records the types and calls that work", () => {
    const c = resolveCallable("fastest-levenshtein-1.0.16/esm/mod.js", "distance");
    const p = probe(c, 2);
    assert.deepEqual(p.observed.returns, ["number"]);
    assert.ok(p.examples.length > 0);
    assert.equal(p.deterministic, true);
  });
  it("degenerate and trivial results", () => {
    assert.equal(degenerate({ $type: "undefined" }), true);
    assert.equal(degenerate(["a", { $type: "undefined" }]), true);
    assert.equal(degenerate("NaNms"), true);
    assert.equal(degenerate({ $map: [["a", { $set: [{ $type: "undefined" }] }]] }), true);
    assert.equal(degenerate([1, 2]), false);
    assert.equal(trivial([]), true);
    assert.equal(trivial({}), true);
    assert.equal(trivial("x"), false);
    assert.equal(typeOfTagged({ $bytes: [1] }), "bytes");
  });
});

describe("matching stages", () => {
  const card = (id, pkg, extra = {}) => ({
    id,
    pkg,
    name: id,
    sourceFile: `${pkg}/x.js`,
    ...extra,
  });
  it("fuses rankings, and caps a package", () => {
    assert.deepEqual(
      rrf([
        ["a", "b", "c"],
        ["c", "a"],
      ]).slice(0, 2),
      ["a", "c"],
    );
    const pkgOf = (id) => id[0];
    assert.deepEqual(capPerPackage(["p1", "p2", "q1", "p3"], pkgOf, 2), ["p1", "p2", "q1"]);
  });
  it("normalizes the types a model writes", () => {
    assert.equal(normalizeType("string[]"), "array");
    assert.equal(normalizeType("Uint8Array"), "bytes");
    assert.equal(normalizeType("(arg) => result"), "function");
    assert.equal(normalizeType("Map<string, Set<string>>"), "map");
    assert.equal(normalizeType("-1 | 0 | 1"), null);
  });
  it("signature score: too few parameters is 0, exact arity and observed types score highest", () => {
    const q = {
      inputs: [
        { name: "a", type: "string" },
        { name: "b", type: "string" },
      ],
      output: "number",
    };
    assert.equal(signatureScore(card("f", "p", { params: ["a"] }), q), 0);
    const good = card("g", "p", {
      params: ["a", "b"],
      observed: { params: [["string"], ["string"]], returns: ["number"] },
    });
    const bad = card("h", "p", {
      params: ["a", "b"],
      observed: { params: [["array"], ["number"]], returns: ["string"] },
    });
    assert.equal(signatureScore(good, q), 1);
    assert.equal(signatureScore(bad, q), 0.5);
    assert.equal(signatureScore(card("i", "p", { params: ["a"] }), { inputs: [] }), null);
  });
  it("execution moves a candidate that reproduces every example to the front", () => {
    const dist = {
      id: "d",
      pkg: "fastest-levenshtein-1.0.16",
      sourceFile: "fastest-levenshtein-1.0.16/esm/mod.js",
      name: "distance",
      callable: true,
    };
    const closest = { ...dist, id: "c", name: "closest" };
    const nonCallable = { id: "n", callable: false, reason: "class" };
    const cards = { d: dist, c: closest, n: nonCallable };
    const q = {
      examples: [
        { args: ["kitten", "sitting"], returns: 3 },
        { args: ["", "ab"], returns: 2 },
      ],
    };
    const { ordered, results } = executionRerank(["c", "n", "d"], (id) => cards[id], q);
    assert.deepEqual(ordered, ["d", "n", "c"]);
    assert.equal(decide("d", results, q).accept, true);
    assert.equal(decide("n", results, q).accept, false);
    assert.equal(decide("d", results, { examples: q.examples.slice(0, 1) }).accept, false);
  });
  it("a target with file '*' matches the name in any file of the package", () => {
    const q = { targets: ["uuid-11.1.1:*#validate"] };
    assert.equal(
      isTarget(
        card("validate", "uuid-11.1.1", { sourceFile: "uuid-11.1.1/dist/cjs/validate.js" }),
        q,
      ),
      true,
    );
    assert.equal(isTarget(card("validate", "validator-13.15.35"), q), false);
  });
});

describe("metrics", () => {
  it("AUROC: perfect separation is 1, reversed is 0, ties count half", () => {
    assert.equal(auroc([0.9, 0.8, 0.1], [true, true, false]), 1);
    assert.equal(auroc([0.1, 0.9], [true, false]), 0);
    assert.equal(auroc([0.5, 0.5], [true, false]), 0.5);
    assert.equal(auroc([1], [true]), null);
  });
  it("recall@k and MRR over positives; negatives do not count", () => {
    const rows = [
      { positive: true, targetRank: 1 },
      { positive: true, targetRank: 4 },
      { positive: true, targetRank: null },
      { positive: false, targetRank: null },
    ];
    assert.equal(recallAt(rows, 1), 1 / 3);
    assert.equal(recallAt(rows, 5), 2 / 3);
    assert.equal(mrr(rows), (1 + 0.25) / 3);
  });
  it("the decision metrics count wrong reuse on negatives", () => {
    const s = summarizeConfig([
      {
        positive: true,
        targetRank: 1,
        accept: true,
        acceptUnique: true,
        passingCount: 1,
        top1Correct: true,
        confidence: 3,
      },
      {
        positive: false,
        targetRank: null,
        accept: true,
        acceptUnique: false,
        passingCount: 2,
        top1Correct: false,
        confidence: 2,
      },
    ]);
    assert.equal(s.acceptPrecision, 0.5);
    assert.equal(s.falseAcceptRate, 1);
    assert.equal(s.uniqueFalseAccept, 0);
    assert.equal(s.ambiguous, 1);
  });
});

describe("seed queries", () => {
  it("are labelled as a seed set, with unique ids and the fields the pipeline reads", () => {
    assert.equal(seed.set, "seed");
    const ids = seed.queries.map((q) => q.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const q of seed.queries) {
      assert.ok(q.need.length > 10, q.id);
      assert.ok(
        Array.isArray(q.inputs) && Array.isArray(q.examples) && Array.isArray(q.targets),
        q.id,
      );
    }
    assert.ok(seed.queries.filter((q) => q.targets.length === 0).length >= 5);
  });
  it("no need names its target's identifier", () => {
    for (const q of seed.queries)
      for (const t of q.targets) {
        const name = t.split("#")[1];
        // Compound identifiers (camelCase, underscores, digits) would be a leak; plain words
        // such as "parse" or "version" are ordinary English.
        if (/[A-Z_$\d]/.test(name.slice(1)))
          assert.equal(q.need.includes(name), false, `${q.id}: ${name}`);
      }
  });
  it("every callable target reproduces its own query's examples", () => {
    for (const q of seed.queries) {
      if (q.examples.length === 0) continue;
      for (const t of q.targets) {
        const [pkg, rest] = t.split(":");
        const [file, name] = rest.split("#");
        if (file === "*") continue; // checked through the eval's isTarget
        const card = { pkg, name, sourceFile: `${pkg}/${file}`, callable: true };
        const r = runExamples(card, q.examples);
        if (!r.executable) continue;
        if (q.id === "parse-iso-date" && name === "parseDate") continue; // different interface, by design
        assert.equal(r.passed, r.total, `${q.id}: ${t}`);
      }
    }
  });
});

describe("model-backed steps (no calls)", () => {
  it("refuse to run without a key (ANTHROPIC_API_KEY or CLAUDE_API_KEY)", async () => {
    const saved = {};
    for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"]) {
      saved[k] = process.env[k];
      // Assigning undefined would store the string "undefined" in process.env.
      Reflect.deleteProperty(process.env, k);
    }
    try {
      await assert.rejects(modelClient(), /ANTHROPIC_API_KEY is not set/);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
  });
  it("mask a definition's own name, and read a JSON reply", () => {
    assert.equal(
      maskName("function fmtShort(ms) { return fmtShort2(ms) }", "fmtShort"),
      "function fn(ms) { return fmtShort2(ms) }",
    );
    assert.deepEqual(extractJson('here:\n```json\n{"need": "x"}\n```'), { need: "x" });
    assert.equal(extractJson("no json"), null);
    // Prose with braces before the answer (seen in a live reply).
    assert.deepEqual(extractJson('They return {} objects.\n\n{"pick": 0, "reason": "none"}'), {
      pick: 0,
      reason: "none",
    });
    assert.deepEqual(extractJson('{"a": {"b": 1}}'), { a: { b: 1 } });
  });
  it("sample spreads across packages and skips what cannot be checked", () => {
    const mk = (pkg, i, extra = {}) => ({
      pkg,
      name: `fn${i}`,
      callable: true,
      deterministic: true,
      examples: [1],
      ...extra,
    });
    const cards = [mk("a", 1), mk("a", 2), mk("a", 3), mk("b", 1), mk("b", 2, { callable: false })];
    assert.deepEqual(
      sample(cards, 3).map((c) => `${c.pkg}${c.name}`),
      ["afn1", "bfn1", "afn2"],
    );
  });
});

describe("committed results", () => {
  const file = join(bench, "results", "eval-seed.json");
  it("cover the seed set with every configuration", { skip: !existsSync(file) }, () => {
    const r = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(r.set, "seed");
    assert.equal(r.queries, seed.queries.length);
    for (const name of ["registry-spec", "card-hybrid+examples", "+execution", "exec-all"]) {
      assert.ok(r.summary[name], name);
      assert.equal(r.rows[name].length, seed.queries.length);
    }
  });
});

describe("confirm step (no calls)", () => {
  const dist = {
    id: "d",
    pkg: "fastest-levenshtein-1.0.16",
    sourceFile: "fastest-levenshtein-1.0.16/esm/mod.js",
    name: "distance",
    params: ["a", "b"],
    doc: null,
    examples: [{ args: ["kitten", "sitting"], returns: 3 }],
  };
  const other = { ...dist, id: "o", name: "closest", examples: [] };
  const q = {
    need: "Count single-character edits between two strings.",
    inputs: [{ name: "a", type: "string" }],
    output: "number",
    examples: [{ args: ["a", "b"], returns: 1 }],
    targets: ["fastest-levenshtein-1.0.16:esm/mod.js#distance"],
  };
  it("the request carries no code and no examples; candidates show their observed calls", () => {
    const p = confirmPrompt(q, [other, dist], {});
    assert.equal(requestText(q).includes("f("), false);
    assert.match(p, /2\. distance\(a, b\) from fastest-levenshtein/);
    assert.match(p, /distance\("kitten", "sitting"\) = 3/);
    assert.match(p, /could not be run on sample inputs/);
  });
  it("scores picks: right, wrong reuse, missed, correct none", () => {
    assert.equal(scorePick(q, [other, dist], 2).outcome, "right");
    assert.equal(scorePick(q, [other, dist], 1).outcome, "wrong-reuse");
    assert.equal(scorePick(q, [other, dist], 0).outcome, "missed");
    assert.equal(scorePick(q, [other], 0).outcome, "correct-none");
    assert.equal(scorePick(q, [other], 3).outcome, "invalid");
    const s = summarizePicks([
      { positive: true, reachable: true, outcome: "right" },
      { positive: true, reachable: false, outcome: "wrong-reuse" },
      { positive: false, reachable: false, outcome: "correct-none" },
    ]);
    assert.equal(s.rightOfPositives, 0.5);
    assert.equal(s.rightWhenShown, 1);
    assert.equal(s.reusePrecision, 0.5);
    assert.equal(s.correctNoneOnNegatives, 1);
  });
});
