#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// B15: the upsert check, measured. For each model-written function (results/impls.json), run
// the check against the corpus and ask:
//   - Is the corpus definition it was written to match (the target) among the neighbors, by
//     text, by behavior, or by both?
//   - What verdict does the target get, and how do the two compare in speed?
//   - What else is judged equivalent (duplicates elsewhere in the corpus, or false matches)?
//   - Negatives: mutants of the new function that fail its own examples must not be judged
//     equivalent to the target. They are compared without those examples, as a stored block
//     would be by someone who did not write them.
// No model calls: the local embedding model and the vm sandbox.
//
//   node harness/run.mjs [--k 5] [--limit N] [--out results/run.json]
process.env.TZ = "UTC";

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cardText } from "../../B12-need-to-code/harness/cards.mjs";
import { denseRanking, embedder, queryText } from "../../B12-need-to-code/harness/eval.mjs";
import { isTarget } from "../../B12-need-to-code/harness/match.mjs";
import { resolveCallable, taggedEqual } from "../../B12-need-to-code/harness/sandbox.mjs";
import {
  compareRuns,
  probeInputs,
  runInputs,
  standaloneCallable,
  uniqueInputs,
  upsertCheck,
  verdict,
} from "./dedup.mjs";
import { loadQueries } from "./write-impls.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bench = resolve(here, "..");
const repo = resolve(bench, "..", "..");
const b12 = resolve(bench, "..", "B12-need-to-code");

const MAX_MUTANTS = 5;

/** Whether a callable returns each example's value (or throws where it should). */
export function passesExamples(callable, examples) {
  const rs = runInputs(
    callable,
    examples.map((e) => e.args),
  );
  return examples.every((e, i) =>
    e.throws ? !rs[i].ok : rs[i].ok && taggedEqual(rs[i].value, e.returns),
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const k = Number(arg("k", "5"));
  const out = resolve(arg("out", join(bench, "results", "run.json")));
  const { impls, model } = JSON.parse(readFileSync(join(bench, "results", "impls.json"), "utf8"));
  const queries = loadQueries()
    .filter((q) => impls[q.id])
    .slice(0, Number(arg("limit", "100000")));
  const t0 = Date.now();

  // Library: B12's cards (probed callables) with the model-written descriptions.
  const cards = JSON.parse(readFileSync(join(b12, ".cache", "cards.json"), "utf8"));
  const descriptions = JSON.parse(
    readFileSync(join(b12, "results", "descriptions.json"), "utf8"),
  ).descriptions;
  const callableCards = cards.filter((c) => c.callable);
  const emb = await embedder();
  const textOf = (c) => cardText(c.doc || !descriptions[c.id] ? c : { ...c, doc: descriptions[c.id] });
  const ids = callableCards.map((c) => c.id);
  const vecs = [];
  for (const c of callableCards) vecs.push(await emb.embed(textOf(c)));
  emb.save();

  const atomsAt = new Map();
  const atomsFor = (arity, types) => {
    const key = JSON.stringify([arity, types]);
    if (!atomsAt.has(key)) {
      const probes = probeInputs(arity, types);
      const list = [];
      for (const card of callableCards) {
        if (Math.abs(card.arity - arity) > 1) continue;
        const c = resolveCallable(card.sourceFile, card.name);
        if (!c.callable) continue;
        list.push({ id: card.id, card, callable: c, fingerprint: runInputs(c, probes) });
      }
      atomsAt.set(key, list);
    }
    return atomsAt.get(key);
  };

  const { generateMutants } = await import(
    pathToFileURL(join(repo, "packages/variance/dist/mutate/index.js")).href
  );

  const rows = [];
  for (const q of queries) {
    const impl = impls[q.id];
    const nc = standaloneCallable(impl.code, impl.name);
    const row = { query: q.id, name: impl.name };
    rows.push(row);
    if (!nc.callable) {
      row.skipped = `new function: ${nc.reason}`;
      continue;
    }
    row.passesOwnExamples = passesExamples(nc, q.examples);
    const arity = q.inputs.length;
    const types = q.inputs.map((p) => p.type);
    const atoms = atomsFor(arity, types);
    const target = atoms.find((a) => isTarget(a.card, q));
    row.target = target?.id ?? null;
    if (!target) {
      row.skipped = "target not callable at this arity";
      continue;
    }
    const qvec = await emb.embed(queryText(q));
    const atomIds = new Set(atoms.map((a) => a.id));
    const textIds = denseRanking(qvec, vecs, ids)
      .map((x) => x.id)
      .filter((id) => atomIds.has(id));
    const { behaviorIds, neighbors } = upsertCheck({
      newCallable: nc,
      arity,
      paramTypes: types,
      newExamples: q.examples,
      atoms,
      textIds,
      k,
    });
    const rank = (list) => {
      const i = list.findIndex((id) => id === target.id);
      return i < 0 ? null : i + 1;
    };
    row.behaviorRank = rank(behaviorIds);
    row.textRank = rank(textIds);
    const tn = neighbors.find((n) => n.id === target.id);
    row.targetVerdict = tn?.verdict ?? "not found";
    row.targetTiming = tn?.timing ?? null;
    row.targetCounterexamples = tn?.verdict === "near" ? tn.counterexamples : undefined;
    row.otherEquivalent = neighbors
      .filter((n) => n.id !== target.id && n.verdict === "equivalent")
      .map((n) => ({ id: n.id, sameName: atoms.find((a) => a.id === n.id).card.name === target.card.name }));
    row.topVerdict = neighbors[0]?.verdict ?? null;
    row.topIsTarget = neighbors[0]?.id === target.id;

    // Negatives: mutants of the new function that fail its own examples.
    const mutants = generateMutants(impl.code);
    const killed = [];
    for (const m of mutants) {
      if (killed.length >= MAX_MUTANTS) break;
      const mc = standaloneCallable(m.mutatedSource, impl.name);
      if (!mc.callable || passesExamples(mc, q.examples)) continue;
      killed.push(mc);
    }
    const inputs = uniqueInputs([
      ...probeInputs(arity, types),
      ...(target.card.examples ?? []).map((e) => e.args),
    ]);
    const targetRun = runInputs(target.callable, inputs);
    row.mutants = killed.map((mc) => verdict(compareRuns(inputs, runInputs(mc, inputs), targetRun)));
  }

  const summary = summarize(rows, k);
  writeFileSync(
    out,
    `${JSON.stringify({ implModel: model, k, seconds: Math.round((Date.now() - t0) / 1000), summary, rows }, null, 2)}\n`,
  );
  console.log(JSON.stringify(summary, null, 2));
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.floor(s.length / 2)];
};

export function summarize(rows, k) {
  const scored = rows.filter((r) => !r.skipped);
  const frac = (f, of = scored) => (of.length ? +(of.filter(f).length / of.length).toFixed(3) : null);
  const within = (r, key) => r[key] !== null && r[key] <= k;
  const verdicts = {};
  for (const r of scored) verdicts[r.targetVerdict] = (verdicts[r.targetVerdict] ?? 0) + 1;
  const mutants = scored.flatMap((r) => r.mutants);
  const mv = {};
  for (const v of mutants) mv[v] = (mv[v] ?? 0) + 1;
  const timed = scored.filter((r) => r.targetTiming?.ratio);
  const passing = scored.filter((r) => r.passesOwnExamples);
  return {
    queries: rows.length,
    skipped: rows.length - scored.length,
    scored: scored.length,
    newPassesOwnExamples: frac((r) => r.passesOwnExamples),
    targetFound: {
      [`text top-${k}`]: frac((r) => within(r, "textRank")),
      [`behavior top-${k}`]: frac((r) => within(r, "behaviorRank")),
      "behavior top-1": frac((r) => r.behaviorRank === 1),
      union: frac((r) => within(r, "textRank") || within(r, "behaviorRank")),
    },
    targetVerdicts: verdicts,
    targetEquivalentOrNear: frac((r) => ["equivalent", "near"].includes(r.targetVerdict)),
    targetEquivalentOrNearWhenNewPassesExamples: frac(
      (r) => ["equivalent", "near"].includes(r.targetVerdict),
      passing,
    ),
    topNeighborIsTarget: frac((r) => r.topIsTarget),
    otherEquivalent: {
      queriesWithAny: frac((r) => r.otherEquivalent.length > 0),
      total: scored.reduce((n, r) => n + r.otherEquivalent.length, 0),
      sameNameAsTarget: scored.reduce((n, r) => n + r.otherEquivalent.filter((o) => o.sameName).length, 0),
    },
    speed: {
      pairs: timed.length,
      newFaster: frac((r) => r.targetTiming.ratio < 1, timed),
      medianNewOverStored: timed.length ? +median(timed.map((r) => r.targetTiming.ratio)).toFixed(2) : null,
    },
    mutants: { total: mutants.length, verdicts: mv, falseEquivalent: mutants.length ? +((mv.equivalent ?? 0) / mutants.length).toFixed(3) : null },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
