// SPDX-License-Identifier: Apache-2.0
// Builds the fixed corpus sample for the lowering prototypes (#1299): ~50 atoms chosen by construct
// coverage from the bootstrap registry and the seed blocks, each with its source verbatim, its graph
// identity, and the input types the differential test generates inputs from. Run after `pnpm build`:
//   node packages/duc/scripts/build-corpus-sample.mjs
// It rewrites src/__fixtures__/corpus-sample.json. The sample is fixed: rerun only to change it.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { graphIdentity, liftAtom } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const registry = join(repo, "bootstrap", "yakcc.registry.sqlite");

// Input type specs (see __fixtures__/differential.ts for the generator).
const S = "str";
const NUM = "num";
const INT = "int";
const IDX = "idx";
const PARSE = { str: "0123456789,[] \t-+.xé😀", max: 10 };
const QR = {
  obj: {
    expectedAtom: { union: [{ lit: [null] }, { str: "abc", max: 3 }] },
    top1Correct: "bool",
    top1Score: NUM,
    expectedAtomRank: { union: [{ lit: [null] }, IDX] },
  },
};
const SIG = {
  arr: { obj: { name: { str: "ab", max: 2 }, type: { lit: ["string", "number"] } } },
  max: 3,
};

/** [name, origin, specs, constructs] — origin is a registry block root prefix or `seed:<dir>`. */
const SAMPLE = [
  ["add", "db5da00e2383", [NUM, NUM], ["number"]],
  ["isHex64", "67612218ea", [{ str: "0123456789abcdefABCDEFg", max: 66 }], ["string", "regex"]],
  ["truncate", "7c6b1dff6c", [S, IDX], ["string", "number"]],
  ["stemToCamelCase", "52639497e7", [{ str: "ab-cZ_", max: 8 }], ["string", "regex", "closure"]],
  [
    "emitEntry",
    "939775daa1",
    [
      {
        obj: {
          kind: { lit: ["pointer", "novel-glue", "glue", "foreign-leaf"] },
          merkleRoot: S,
          canonicalAstHash: S,
          source: S,
        },
      },
    ],
    ["string", "object", "switch"],
  ],
  ["panicCodeToKind", "4fc4eb009a", [INT], ["number"]],
  ["f64Bytes", "333e718ae4", [NUM], ["number", "array", "platform"]],
  ["valtypeByte", "de5a272554", [{ lit: ["i32", "i64", "f64", "x"] }], ["switch", "module"]],
  ["bytesToHex", "bfa606249f", [{ arr: "byte", max: 6 }], ["array", "closure", "string"]],
  ["isLocalTriplet", "49c462823a", [{ obj: { kind: { lit: ["local", "foreign"] } } }], ["object"]],
  ["normalizeBase", "aabb5f8610", [{ str: "ab/", max: 5 }], ["string"]],
  [
    "buildIntentCardQuery",
    "e3e4fe3152",
    [{ obj: { intent: S, sourceContext: { opt: S } }, opt: ["sourceContext"] }],
    ["object", "truthiness"],
  ],
  ["buildSkeletonSpec", "672ef5373e", [S], ["object", "array"]],
  ["refBytesToHex", "8dc97fc0c4", [{ arr: "byte", max: 6 }], ["loop", "array", "string"]],
  ["isAsciiDigit", "d0897c9466", [{ str: "09a/:é", max: 2 }], ["string", "comparison"]],
  ["isEnoent", "e02be7c904", ["any"], ["object", "in", "typeof"]],
  ["normalizeSource", "d931405d02", [{ str: "a\r\n \t", max: 8 }], ["string", "regex"]],
  [
    "candidatesToCombinedScores",
    "985c697cc9",
    [{ arr: { obj: { cosineDistance: NUM } }, max: 4 }],
    ["array", "closure", "number"],
  ],
  ["propsArtifactPath", "85f2dc95ec", [S], ["string"]],
  ["collapseWhitespace", "dc29dd0af3", [{ str: "a \t\n ", max: 8 }], ["string", "regex"]],
  ["escapeRegex", "4aec71ca15", [{ str: "a.*+?^${}()|[]\\", max: 6 }], ["string", "regex"]],
  ["normalizeId", "d63e7bcb48", [{ str: "(a b)", max: 8 }], ["string", "regex"]],
  ["mapParam", "5c305103ef", [{ obj: { name: S, typeHint: S, description: S } }], ["object"]],
  ["deriveSpecName", "ab986670f9", [S, { str: "0123456789abcdef", max: 16 }], ["string", "regex"]],
  ["normalizeSentence", "ea87254f07", [{ str: "Ab .;!?,\t", max: 10 }], ["string", "regex"]],
  [
    "parseArgv",
    "6142909d11",
    [
      { arr: { str: "-ab=c1", max: 4 }, max: 5 },
      {
        opt: {
          obj: {
            boolean: { arr: { lit: ["a", "b"] }, max: 2 },
            alias: { obj: { a: { arr: { lit: ["x"] }, max: 1 } } },
            default: { obj: { b: "bool" } },
          },
          opt: ["boolean", "alias", "default"],
        },
      },
    ],
    ["loop", "closure", "object", "array", "string"],
  ],
  ["insideSnapshot", "ec715635d0", [{ str: "/snapshot", max: 12 }], ["string"]],
  [
    "validateProofManifestL0",
    "fb8b235983",
    [
      {
        union: [
          "any",
          {
            obj: {
              artifacts: {
                arr: {
                  obj: {
                    kind: { lit: ["property_tests", "smt_cert"] },
                    path: { str: "ab", max: 2 },
                  },
                },
                max: 2,
              },
            },
          },
        ],
      },
    ],
    ["exception", "loop", "object", "in", "typeof"],
  ],
  ["buildFragmentFallback", "355decb523", [INT, INT], ["string", "number"]],
  [
    "isTestEmission",
    "7c8f7e55c6",
    [{ str: "describe(it ", max: 12 }, { opt: { lit: ["a.test.ts", "b.ts", "c.spec.js"] } }],
    ["string", "regex"],
  ],
  [
    "extractFunctionName",
    "6653796f33",
    [{ lit: ["export function foo() {}", "export async function bar(x)", "function baz", ""] }],
    ["regex", "optional-chain"],
  ],
  ["renderAtomNewComment", "8050249191", [S, S], ["string"]],
  [
    "outcomeFromResponse",
    "f3ad41d8d8",
    [{ obj: { kind: { lit: ["registry-hit", "passthrough"] } } }, { opt: { lit: ["atomized"] } }],
    ["object", "undefined"],
  ],
  ["cosineDistanceToCombinedScore", "549cfea79f", [NUM], ["number", "math"]],
  [
    "benchmarkQueryToIntentQuery",
    "7fcc130325",
    [
      {
        obj: {
          behavior: S,
          signature: { opt: { obj: { inputs: SIG, outputs: SIG }, opt: ["inputs", "outputs"] } },
        },
        opt: ["signature"],
      },
    ],
    ["object", "closure", "optional-chain"],
  ],
  [
    "worstHitRateEntries",
    "ae2a5ef798",
    [{ arr: QR, max: 5 }, { opt: IDX }],
    ["array", "closure", "sort", "default-param"],
  ],
  ["computePrecisionAt1", "c70cd690c1", [{ arr: QR, max: 5 }], ["array", "closure", "number"]],
  ["computeRecallAtK", "cffb9d270b", [{ arr: QR, max: 5 }], ["array", "closure", "number"]],
  [
    "computeAtomComplexity",
    "d0a5ca1c69",
    [
      {
        obj: {
          spec: {
            obj: { inputs: { opt: { arr: INT, max: 3 } }, outputs: { opt: { arr: INT, max: 3 } } },
            opt: ["inputs", "outputs"],
          },
          exportedSurface: INT,
          transitiveDeps: INT,
        },
      },
    ],
    ["object", "number", "nullish"],
  ],
  [
    "computeNeedComplexity",
    "c8fe85d625",
    [{ obj: { bindingsUsed: NUM, statementCount: NUM } }],
    ["number", "math"],
  ],
  [
    "buildSuggestion",
    "1c4451dab5",
    [
      { lit: ["specificity_floor", "descent_bypass_rate", "result_set_median", "ratio_median"] },
      {
        obj: {
          windowSize: INT,
          meanSpecificityScore: NUM,
          descentBypassRate: NUM,
          medianResultSetSize: INT,
          medianAtomRatio: NUM,
        },
      },
      {
        obj: {
          specificityFloor: NUM,
          descentBypassMax: NUM,
          resultSetMedianMax: INT,
          ratioMedianMax: NUM,
        },
      },
    ],
    ["switch", "string", "number-format"],
  ],
  [
    "tokenize",
    "5582923495",
    [{ str: "Ab -_1 ", max: 12 }],
    ["string", "regex", "closure", "array"],
  ],
  [
    "withCompletion",
    "b37c8738c4",
    [{ obj: { completedBindings: { arr: { lit: ["a", "b"] }, max: 2 } } }, { lit: ["a", "c"] }],
    ["object", "spread", "array"],
  ],
  [
    "withHitIncrement",
    "f2efd15031",
    [{ obj: { hitCounts: { obj: { a: { opt: INT } }, opt: ["a"] } } }, { lit: ["a", "b"] }],
    ["object", "spread", "computed-key"],
  ],
  ["makeBindingKey", "0f089e81fc", [S, S], ["string"]],
  ["makeLruNode", "c4417a5b79", [S, "any"], ["object"]],
  [
    "parseSemver",
    "4021ed3d57",
    [
      {
        union: [
          { lit: ["1.2.3", "0.0.1-alpha.1+build.5", "01.2.3", "1.2", "1.2.3-", "10.20.30+x"] },
          { str: "0123.-+a", max: 9 },
        ],
      },
    ],
    ["exception", "loop", "string", "object"],
  ],
  ["seed:ascii-char", "seed:ascii-char", [PARSE, IDX], ["string", "exception"]],
  ["seed:bracket", "seed:bracket", [PARSE, IDX, { lit: ["[", "]"] }], ["string", "exception"]],
  ["seed:char-code", "seed:char-code", [PARSE, IDX], ["string", "exception"]],
  ["seed:digit-or-throw", "seed:digit-or-throw", [PARSE, IDX], ["string", "exception", "tuple"]],
  ["seed:eof-check", "seed:eof-check", [PARSE, IDX], ["exception"]],
  ["seed:integer", "seed:integer", [PARSE, IDX], ["loop", "exception", "number"]],
  ["seed:signed-integer", "seed:signed-integer", [PARSE, IDX], ["loop", "exception", "number"]],
  ["seed:whitespace", "seed:whitespace", [PARSE, IDX], ["loop", "exception"]],
  [
    "seed:string-from-position",
    "seed:string-from-position",
    [PARSE, IDX, IDX],
    ["string", "exception"],
  ],
  ["seed:position-step", "seed:position-step", [IDX, IDX, IDX], ["number", "exception"]],
  ["seed:peek-char", "seed:peek-char", [PARSE, IDX], ["string", "exception", "null"]],
  ["seed:non-ascii-rejector", "seed:non-ascii-rejector", [PARSE], ["loop", "exception", "string"]],
  [
    "seed:comma-separated-integers",
    "seed:comma-separated-integers",
    [PARSE, IDX],
    ["loop", "exception", "array", "tuple"],
  ],
  [
    "seed:nonempty-list-content",
    "seed:nonempty-list-content",
    [PARSE, IDX],
    ["loop", "exception", "array"],
  ],
];

const rows = JSON.parse(
  execFileSync(
    "python3",
    [
      "-c",
      `import sqlite3,json;c=sqlite3.connect(${JSON.stringify(registry)});print(json.dumps([[r[0],r[1]] for r in c.execute('select block_merkle_root,impl_source from blocks')]))`,
    ],
    { maxBuffer: 1 << 28 },
  ).toString(),
);
const out = [];
const seenIdentity = new Map();
for (const [name, origin, args, constructs] of SAMPLE) {
  let source;
  let root;
  if (origin.startsWith("seed:")) {
    source = readFileSync(
      join(repo, "packages", "seeds", "src", "blocks", origin.slice(5), "impl.ts"),
      "utf8",
    );
    root = origin;
  } else {
    const hits = rows.filter(([r]) => r.startsWith(origin));
    if (hits.length !== 1) throw new Error(`${name}: ${hits.length} blocks match ${origin}`);
    [root, source] = hits[0];
  }
  const identity = graphIdentity(liftAtom(source));
  if (seenIdentity.has(identity))
    throw new Error(`${name}: same graph as ${seenIdentity.get(identity)}`);
  seenIdentity.set(identity, name);
  out.push({ name, origin: root, identity, constructs, args, source });
}
writeFileSync(
  join(here, "..", "src", "__fixtures__", "corpus-sample.json"),
  `${JSON.stringify(out, null, 2)}\n`,
);
console.log(`${out.length} atoms`);
