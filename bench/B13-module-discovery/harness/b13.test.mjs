// SPDX-License-Identifier: MIT
// B13 self-test: root selection, the leverage arithmetic, README sectioning and the leak
// check, the confirm prompt, and the seed set's integrity. No model, no embedding model.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { corpusDefinitions } from "../../B11-reuse-economics/harness/retrieve.mjs";
import { isTarget } from "../../B12-need-to-code/harness/match.mjs";
import { buildNames, renderName, words } from "../../B12-need-to-code/harness/names.mjs";
import { CONFIRM_OUTPUT, LARGE_NODES, est, isLargeRoot, leverage } from "./b13.mjs";
import { rootsPrompt } from "./confirm-roots.mjs";
import { leaks, readmes, sections } from "./needs-from-readme.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bench = join(here, "..");
const seed = JSON.parse(readFileSync(join(bench, "queries", "seed.json"), "utf8"));
const records = Object.values(buildNames(corpusDefinitions()));

describe("roots and names", () => {
  it("a large root is an entry point or shared core with a big closure", () => {
    assert.equal(isLargeRoot({ exported: true, fanIn: 0, closureNodes: LARGE_NODES }), true);
    assert.equal(isLargeRoot({ exported: false, fanIn: 2, closureNodes: LARGE_NODES + 1 }), true);
    assert.equal(isLargeRoot({ exported: false, fanIn: 1, closureNodes: 10_000 }), false);
    assert.equal(isLargeRoot({ exported: true, fanIn: 0, closureNodes: LARGE_NODES - 1 }), false);
  });
  it("names resolve imports across files: semver's satisfies reaches Range", () => {
    const r = records.find(
      (x) => x.sourceFile === "semver-7.8.0/functions/satisfies.js" && x.name === "satisfies",
    );
    assert.ok(r.callees.includes("Range"));
    assert.ok(r.closureSize >= 5);
    assert.match(renderName(r), /semver › satisfies\(version, range, options\) \[entry\]/);
  });
  it("names are deterministic", () => {
    const again = Object.values(buildNames(corpusDefinitions()));
    assert.deepEqual(again.slice(0, 50), records.slice(0, 50));
  });
  it("identifier words split camelCase, snake_case and acronyms", () => {
    assert.deepEqual(words("parseISODate_v2"), ["parse", "iso", "date", "v2"]);
  });
});

describe("leverage", () => {
  it("is the cost of writing over the cost of finding, at a model's prices", () => {
    const u = { writeTokens: 1000, requestTokens: 40, confirmInputTokens: 500 };
    // write 1000 out; find (40 + 60) out + 500 in at a 1:5 price ratio = 100 + 100 = 200.
    assert.equal(CONFIRM_OUTPUT, 60);
    assert.equal(leverage(u, [1, 5]), 5000 / (100 * 5 + 500 * 1));
    assert.ok(leverage({ ...u, writeTokens: 50 }, [1, 5]) < 1);
    assert.equal(est(401), 101);
  });
});

describe("held-out generation (no calls)", () => {
  it("splits a README on headings within the size limit", () => {
    const s = sections("# A\nintro\n## Install\nnpm i\n## API\n### parse(x)\ndoes", 20);
    assert.ok(s.length >= 3);
    assert.ok(s.every((x) => x.length <= 40));
  });
  it("drops a need that names the API or the package", () => {
    assert.equal(
      leaks("Use maxSatisfying to pick a version", "maxSatisfying", "semver-7.8.0"),
      true,
    );
    assert.equal(
      leaks("Pick the highest semver in a range", "maxSatisfying", "semver-7.8.0"),
      true,
    );
    assert.equal(
      leaks("Pick the highest version in a range", "semver.maxSatisfying", "semver-7.8.0"),
      false,
    );
  });
  it("finds the corpus READMEs", () => {
    assert.ok(readmes().length >= 6);
  });
  it("the confirm prompt numbers the candidates and carries only the need", () => {
    const p = rootsPrompt("parse csv", [{ text: "a › b\nline" }, { text: "c" }]);
    assert.match(p, /^What I need:\nparse csv/);
    assert.match(p, /1\. a › b\n {3}line\n2\. c/);
  });
});

describe("seed set", () => {
  it("is labelled a seed set, with unique ids, positives and negatives", () => {
    assert.equal(seed.set, "seed");
    assert.equal(new Set(seed.queries.map((q) => q.id)).size, seed.queries.length);
    assert.ok(seed.queries.filter((q) => q.targets.length === 0).length >= 5);
  });
  it("every target resolves to a named corpus definition", () => {
    for (const q of seed.queries.filter((x) => x.targets.length > 0))
      assert.ok(
        records.some((r) => isTarget(r, q)),
        q.id,
      );
  });
  it("no need names its target's identifier", () => {
    for (const q of seed.queries)
      for (const t of q.targets) {
        const name = t.split("#")[1];
        // Compound identifiers (camelCase, digits, underscores) would leak; a plain word such
        // as "satisfies" or "set" is ordinary English, as in B12.
        if (/[A-Z_$\d]/.test(name.slice(1)))
          assert.equal(new RegExp(`\\b${name}\\b`).test(q.need), false, `${q.id}: ${name}`);
      }
  });
});

describe("committed results", () => {
  const file = join(bench, "results", "eval-seed.json");
  it("cover the seed set in both pools", { skip: !existsSync(file) }, () => {
    const r = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(r.set, "seed");
    for (const pool of ["all", "large roots"])
      assert.equal(r.rows[pool].length, seed.queries.length);
  });
});
