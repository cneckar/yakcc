import { writeFileSync } from "node:fs";
// SPDX-License-Identifier: Apache-2.0
// #1421 slice 7: L2 over the bootstrap corpus. For every block: does it carry a contract L2 can
// check, is its implementation inside the encoder's fragment, and if not, which construct is the
// first refusal. For blocks with a number/boolean signature, the full pipeline runs on an
// automatic property (no NaN out for NaN-free inputs).
//
//   pnpm --filter @yakcc/verify-l2 build
//   node packages/verify-l2/scripts/measure-corpus.mjs [registry.sqlite] [out.json]
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { liftAtom } from "@yakcc/duc";
import { ENCODER_VERSION, Encoder, Unsupported, shutdownSolver, verifyL2 } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const dbPath = process.argv[2] ?? join(root, "bootstrap", "yakcc.registry.sqlite");
const outPath = process.argv[3] ?? join(here, "..", "results", "corpus-bootstrap.json");
const require = createRequire(join(root, "packages", "registry", "package.json"));
const Database = require("better-sqlite3");
const db = new Database(dbPath, { readonly: true });

const SORT = { number: "F64", boolean: "Bool", string: "Str" };
const rows = db
  .prepare("select block_merkle_root r, spec_canonical_bytes s, impl_source i from blocks")
  .all();
const tally = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const stats = {
  blocks: rows.length,
  withPostconditions: 0,
  withPreconditions: 0,
  scalarSignature: 0,
  liftErrors: 0,
  encodable: 0,
  encodableScalar: 0,
};
const refusals = new Map(); // first refusing construct, over every block that lifts
const typeRefusals = new Map(); // the first non-scalar type, over every block
const scalarRuns = [];

for (const row of rows) {
  const spec = JSON.parse(Buffer.from(row.s).toString("utf8"));
  if ((spec.postconditions ?? []).length > 0) stats.withPostconditions++;
  if ((spec.preconditions ?? []).length > 0) stats.withPreconditions++;
  const inputs = spec.inputs ?? [];
  const outputs = spec.outputs ?? [];
  const nonScalar = [...inputs, ...outputs].find((p) => SORT[p.type] === undefined);
  const scalar = nonScalar === undefined && outputs.length === 1;
  if (scalar) stats.scalarSignature++;
  else
    tally(
      typeRefusals,
      nonScalar?.type ?? (outputs.length === 0 ? "(no result)" : "(several results)"),
    );

  let graph;
  try {
    graph = liftAtom(row.i);
  } catch {
    stats.liftErrors++;
    continue;
  }
  // The fragment check is independent of the declared types: parameters are taken as numbers.
  const arity = graph.nodes.filter((n) => n.kind === "param-source").length;
  // Declared types where the spec gives them; a number otherwise.
  const params = Array.from({ length: arity }, (_, i) => {
    const sort = SORT[inputs[i]?.type];
    return sort === "Bool" || sort === "Str"
      ? { sort, smt: `p${i}` }
      : { sort: "F64", smt: `((_ to_fp 11 53) p${i})` };
  });
  try {
    new Encoder({ inputs: [], outputs: [], preconditions: [], postconditions: [] }, params).atom(
      graph,
    );
    stats.encodable++;
    if (scalar) stats.encodableScalar++;
  } catch (e) {
    tally(refusals, e instanceof Unsupported ? e.construct : `error: ${String(e).slice(0, 60)}`);
    continue;
  }
  if (scalar && outputs[0].type === "number") {
    const names = inputs.map((p) => p.name);
    const report = await verifyL2(
      graph,
      {
        inputs,
        outputs,
        preconditions: inputs
          .filter((p) => p.type === "number")
          .map((p) => `${p.name} === ${p.name}`),
        postconditions: ["result === result"],
      },
      { timeoutMs: 5000 },
    );
    scalarRuns.push({
      root: row.r,
      name: spec.name,
      params: names,
      verdict: report.verdict,
      outcome: report.obligations[0]?.outcome,
      reason: report.obligations[0]?.reason,
      counterexample: report.obligations[0]?.counterexample?.map((c) => `${c.name}=${c.text}`),
      throws: report.throws.map((t) => t.reachable),
    });
  }
}

// The DUC corpus sample (#1299): 61 whole functions with argument kinds, a fairer test of the
// fragment than the shaved fragments above.
const sample = JSON.parse(
  (await import("node:fs")).readFileSync(
    join(root, "packages", "duc", "src", "__fixtures__", "corpus-sample.json"),
    "utf8",
  ),
);
const sampleRefusals = new Map();
let sampleEncodable = 0;
let sampleScalar = 0;
// The sample's argument kinds (#1299's generator): numbers, indices and integers are numbers;
// "str" and { str } are strings.
const kindSort = (a) =>
  a === "num" || a === "int" || a === "idx"
    ? "F64"
    : a === "bool"
      ? "Bool"
      : a === "str" || (typeof a === "object" && a !== null && "str" in a)
        ? "Str"
        : undefined;
for (const atom of sample) {
  const scalar = atom.args.every((a) => kindSort(a) !== undefined);
  if (scalar) sampleScalar++;
  try {
    const graph = liftAtom(atom.source);
    const params = atom.args.map((a, i) =>
      a === "bool"
        ? { sort: "Bool", smt: `p${i}` }
        : { sort: "F64", smt: `((_ to_fp 11 53) p${i})` },
    );
    new Encoder({ inputs: [], outputs: [], preconditions: [], postconditions: [] }, params).atom(
      graph,
    );
    sampleEncodable++;
  } catch (e) {
    tally(sampleRefusals, e instanceof Unsupported ? e.construct : "lift error");
  }
}
stats.ducSample = {
  atoms: sample.length,
  scalarArguments: sampleScalar,
  encodable: sampleEncodable,
};

const sorted = (m) => Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
const result = {
  encoder: ENCODER_VERSION,
  registry: dbPath.replace(root, "."),
  date: new Date().toISOString().slice(0, 10),
  stats,
  firstRefusalByConstruct: sorted(refusals),
  firstNonScalarType: sorted(typeRefusals),
  ducSampleFirstRefusal: sorted(sampleRefusals),
  scalarRuns,
};
writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      ...result,
      firstRefusalByConstruct: Object.fromEntries(
        Object.entries(result.firstRefusalByConstruct).slice(0, 15),
      ),
      firstNonScalarType: Object.fromEntries(
        Object.entries(result.firstNonScalarType).slice(0, 10),
      ),
    },
    null,
    2,
  ),
);
await shutdownSolver();
