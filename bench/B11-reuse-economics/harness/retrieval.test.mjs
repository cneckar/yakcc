// SPDX-License-Identifier: MIT
// Tests for the real-retrieval slices (retrieval/production.json, harness/retrieve.mjs) and
// the slice source the runner uses. They read the committed retrieval file and the fixture
// source; they need no embedding model. Regenerate the file with harness/retrieve.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { FIXTURES } from "./build-tasks.mjs";
import { buildPrompt, loadTasks } from "./lib.mjs";
import { covers } from "./retrieve.mjs";
import { ARMS, RETRIEVAL_FILE, runAll, withSliceSource } from "./run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const tasks = loadTasks(join(here, "..", "tasks"));
const retrieval = JSON.parse(readFileSync(RETRIEVAL_FILE, "utf8"));
const retrieved = withSliceSource(tasks, "retrieved", retrieval);
const byId = Object.fromEntries(retrieved.map((t) => [t.id, t]));
const asDef = (c) => ({
  pkg: c.sourcePkg,
  name: c.name,
  sourceFile: c.citation.sourceFile,
  lineStart: c.citation.lineStart,
  lineEnd: c.citation.lineEnd,
});

describe("retrieved slices (registry retrieval over the corpus)", () => {
  it("cover every task, k candidates each, from the production spec path", () => {
    assert.equal(retrieval.variant, "production");
    assert.equal(retrieval.model, "Xenova/bge-small-en-v1.5");
    for (const t of tasks) {
      const r = retrieval.tasks[t.id];
      assert.ok(r, t.id);
      assert.ok(r.slice.length > 0 && r.slice.length <= retrieval.k, t.id);
    }
  });

  it("every candidate's text is the cited fixture lines, unchanged", () => {
    for (const [id, r] of Object.entries(retrieval.tasks)) {
      for (const c of r.slice) {
        const file = readFileSync(join(FIXTURES, c.citation.sourceFile), "utf8").split("\n");
        const span = file.slice(c.citation.lineStart - 1, c.citation.lineEnd).join("\n");
        assert.ok(span.includes(c.text), `${id}/${c.id}: citation lines do not hold the text`);
        assert.equal(c.sourcePkg, c.citation.sourceFile.split("/")[0]);
        assert.match(c.citation.merkleRoot, /^[0-9a-f]{64}$/);
      }
    }
  });

  it("scores are the registry's combined score, in [0, 1], and each hit names its channel", () => {
    for (const r of Object.values(retrieval.tasks)) {
      for (const c of r.slice) {
        assert.ok(c.score >= 0 && c.score <= 1);
        assert.ok(["knn", "lexical", "both"].includes(c.channel));
      }
    }
  });

  it("the reported recall matches the slices it was computed from", () => {
    let inSlice = 0;
    for (const t of tasks) {
      const r = retrieval.tasks[t.id];
      for (const n of r.needed) {
        const [pkg, rest] = n.atom.split(":");
        const [file, name] = rest.split("#");
        const span = t.slice.find(
          (c) => c.ref?.file === `${pkg}/${file}` && c.ref?.name === name,
        )?.citation;
        const hit = r.slice.findIndex((c) => covers(asDef(c), n.atom, span));
        assert.equal(hit < 0 ? null : hit + 1, n.sliceRank, `${t.id}: ${n.atom}`);
        if (hit >= 0) inSlice++;
      }
    }
    assert.equal(inSlice, retrieval.summary.neededAtomsInSlice);
  });

  it("a class covers its methods; another package's same-named function does not", () => {
    const span = { sourceFile: "semver-7.8.0/classes/semver.js", lineStart: 109, lineEnd: 133 };
    const atom = "semver-7.8.0:classes/semver.js#compareMain";
    const cls = {
      pkg: "semver-7.8.0",
      name: "SemVer",
      sourceFile: span.sourceFile,
      lineStart: 9,
      lineEnd: 300,
    };
    assert.equal(covers(cls, atom, span), true);
    assert.equal(covers({ ...cls, pkg: "zod-3.25.76", name: "compareMain" }, atom, span), false);
    assert.equal(covers({ ...cls, name: "other", lineStart: 200 }, atom, span), false);
  });
});

describe("slice source", () => {
  it("retrieved replaces the slice and keeps the fixture slice as the oracle", () => {
    for (const t of retrieved) {
      const fixture = tasks.find((x) => x.id === t.id);
      assert.deepEqual(t.oracleSlice, fixture.slice);
      assert.deepEqual(
        t.slice.map((c) => c.id),
        retrieval.tasks[t.id].slice.map((c) => c.id),
      );
    }
  });

  it("fixture leaves the slice as authored", () => {
    const f = withSliceSource(tasks, "fixture");
    for (const t of f) assert.deepEqual(t.slice, t.oracleSlice);
  });

  it("no prompt built from a retrieved slice contains a held-out check", () => {
    for (const t of retrieved)
      assert.equal(buildPrompt(t, "slice", t.slice).includes(t.heldOut), false);
  });

  it("slice-oracle is opt-in and prompts with the fixture slice; slice prompts with retrieval", async () => {
    assert.equal(ARMS.includes("slice-oracle"), false);
    const task = byId["build-order"];
    const prompts = [];
    const client = {
      async complete(p) {
        prompts.push(p);
        return { text: `\`\`\`ts\n${task.reference}\n\`\`\``, inputTokens: 1, outputTokens: 1 };
      },
    };
    const { rows } = await runAll({
      tasks: [task],
      client,
      options: { arms: ["slice", "slice-oracle"] },
    });
    assert.deepEqual(
      rows.map((r) => r.selection),
      ["rank", "oracle"],
    );
    assert.match(prompts[1], /toposort-2\.0\.2\/index\.js:37-91/);
    assert.equal(prompts[0].includes(task.slice[0].citation.sourceFile), true);
  });
});
