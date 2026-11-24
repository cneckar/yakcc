// SPDX-License-Identifier: MIT
// B14 self-test: every task's held-out test passes its reference glue (with the module bound)
// and rejects a stub; scratch references pass without the module; scoring isolation; prompts
// never carry the held-out test; the arms' control flow with a scripted client.
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tasks } from "../tasks.mjs";
import {
  clientView,
  confirmPrompt,
  gluePrompt,
  needPrompt,
  parsePick,
  routePrompt,
  runReuse,
  runScratch,
  scoreSolution,
  scratchPrompt,
  summarize,
} from "./lib.mjs";

const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));

describe("held-out tests", () => {
  for (const t of tasks) {
    it(`${t.id}: the reference glue passes with the module bound`, () => {
      assert.deepEqual(scoreSolution(t, t.referenceGlue, t.lib), { pass: true, error: null });
    });
    it(`${t.id}: a stub fails`, () => {
      assert.equal(scoreSolution(t, "export function solve() { return null; }").pass, false);
    });
    if (t.referenceScratch)
      it(`${t.id}: the scratch reference passes without the module`, () => {
        assert.equal(scoreSolution(t, t.referenceScratch).pass, true);
      });
  }
  it("glue that relies on lib fails when the module is not bound (the scratch arm cannot cheat)", () => {
    const t = byId["best-compatible-version"];
    assert.match(scoreSolution(t, t.referenceGlue).error, /lib is not defined/);
  });
  it("the scoring context has no host globals, and a hang is bounded", () => {
    const t = byId["build-order"];
    assert.equal(
      scoreSolution(
        t,
        "export function solve() { if (typeof process !== 'undefined') return ['leak']; throw new Error('no'); }",
      ).pass,
      false,
    );
    assert.match(scoreSolution(t, "export function solve() { for (;;) {} }").error, /timed out/);
  });
});

describe("prompts", () => {
  it("never carry the held-out cases or check, and the client view has none", () => {
    for (const t of tasks) {
      const prompts = [
        scratchPrompt(t),
        needPrompt(t),
        confirmPrompt(t, "need", [{ text: "a › b" }]),
        gluePrompt(t, "f", "function f() {}"),
        routePrompt(t),
      ];
      for (const p of prompts) {
        if (t.check) assert.equal(p.includes(t.check), false);
        for (const c of t.cases ?? [])
          assert.equal(
            p.includes(JSON.stringify(c.returns)) && JSON.stringify(c.returns).length > 12,
            false,
            t.id,
          );
      }
      assert.deepEqual(Object.keys(clientView(t)).sort(), [
        "id",
        "lib",
        "referenceGlue",
        "referenceScratch",
        "spec",
      ]);
    }
  });
  it("reads a pick from prose with braces before the answer", () => {
    assert.equal(parsePick('It returns {} here. {"pick": 2}'), 2);
    assert.equal(parsePick("no answer"), null);
  });
});

describe("arms (scripted client)", () => {
  const t = byId["best-compatible-version"];
  const entry = {
    id: "e1",
    sourceFile: t.lib.file,
    name: t.lib.name,
    text: "semver › maxSatisfying(versions, range)",
  };
  const other = { id: "e0", sourceFile: "x/y.js", name: "y", text: "x › y()" };
  const scripted = (replies) => {
    const prompts = [];
    return {
      prompts,
      async complete(p) {
        prompts.push(p);
        return { text: replies[prompts.length - 1], inputTokens: 100, outputTokens: 10 };
      },
    };
  };
  const search = async () => [other, entry];

  it("reuse: names a need, picks the target, writes glue that the scorer binds to the module", async () => {
    const c = scripted([
      "highest version matching a range",
      '{"pick": 2}',
      `\`\`\`ts\n${t.referenceGlue}\n\`\`\``,
    ]);
    const r = await runReuse({
      task: t,
      client: c,
      search,
      rootSourceOf: () => "function maxSatisfying() {}",
    });
    assert.equal(r.pass, true);
    assert.equal(r.turns, 3);
    assert.equal(r.inputTokens, 300);
    assert.equal(r.targetShown, true);
    assert.equal(r.pickedTarget, true);
    assert.match(c.prompts[2], /lib\.maxSatisfying/);
  });
  it("reuse: a pick of 0 falls back to writing it, without lib", async () => {
    const c = scripted(["need", '{"pick": 0}', `\`\`\`ts\n${t.referenceGlue}\n\`\`\``]);
    const r = await runReuse({ task: t, client: c, search, rootSourceOf: () => "" });
    assert.equal(r.picked, null);
    assert.equal(r.pass, false); // glue without the module bound fails
    assert.match(c.prompts[2], /^Task: /);
  });
  it("reuse: NONE skips the search and writes it", async () => {
    const c = scripted(["NONE", "```ts\nexport function solve() { return null; }\n```"]);
    const r = await runReuse({
      task: t,
      client: c,
      search: async () => assert.fail("searched"),
      rootSourceOf: () => "",
    });
    assert.equal(r.turns, 2);
  });
  it("routed: a reply with code is the solution, in one call, with no search", async () => {
    const s = byId["build-order"];
    const c = scripted([`\`\`\`ts\n${s.referenceScratch}\n\`\`\``]);
    const r = await runReuse({
      task: s,
      client: c,
      search: async () => assert.fail("searched"),
      rootSourceOf: () => "",
      route: true,
    });
    assert.equal(r.arm, "routed");
    assert.equal(r.routedTo, "write");
    assert.equal(r.turns, 1);
    assert.equal(r.pass, true);
    assert.match(c.prompts[0], /about 15 lines/);
    assert.match(routePrompt(s, 20), /about 20 lines/);
  });
  it("routed: a reply without code is the need, and the reuse path continues", async () => {
    const c = scripted([
      "highest version matching a range",
      '{"pick": 2}',
      `\`\`\`ts\n${t.referenceGlue}\n\`\`\``,
    ]);
    const r = await runReuse({
      task: t,
      client: c,
      search,
      rootSourceOf: () => "function maxSatisfying() {}",
      route: true,
    });
    assert.equal(r.routedTo, "search");
    assert.equal(r.turns, 3);
    assert.equal(r.pass, true);
    assert.equal(r.pickedTarget, true);
  });
  it("scratch: one call, scored without lib", async () => {
    const s = byId["build-order"];
    const r = await runScratch({
      task: s,
      client: scripted([`\`\`\`ts\n${s.referenceScratch}\n\`\`\``]),
    });
    assert.equal(r.pass, true);
    assert.equal(r.turns, 1);
  });
  it("summaries price tokens per arm and count reuse", () => {
    const s = summarize(
      [
        { arm: "scratch", pass: true, inputTokens: 1e6, outputTokens: 0, turns: 1 },
        {
          arm: "reuse",
          pass: true,
          inputTokens: 0,
          outputTokens: 1e6,
          turns: 3,
          picked: "x",
          targetShown: true,
          pickedTarget: true,
        },
      ],
      [1, 5],
    );
    assert.equal(s.scratch.meanDollars, 1);
    assert.equal(s.reuse.meanDollars, 5);
    assert.equal(s.reuse.reuseRate, 1);
    const r = summarize(
      [
        { arm: "routed", pass: true, inputTokens: 1, outputTokens: 1, turns: 1, routedTo: "write" },
        {
          arm: "routed",
          pass: true,
          inputTokens: 1,
          outputTokens: 1,
          turns: 3,
          routedTo: "search",
          picked: "x",
        },
      ],
      [1, 5],
    );
    assert.equal(r.routed.routedToWrite, 0.5);
    assert.equal(r.routed.reuseRate, 0.5);
  });
});
