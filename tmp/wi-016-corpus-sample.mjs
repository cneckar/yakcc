// @decision DEC-CORPUS-001 (WI-016)
// title: extractCorpus() evidence script — calls upstream-test source against triplet.test.ts fixture
// status: evidence-only (not production code)
// rationale: Demonstrates the corpus extraction pipeline end-to-end using the
// same fixture as triplet.test.ts. Output captured to tmp/wi-016-evidence/corpus-result-sample.json.

import { extractCorpus } from "../packages/shave/dist/corpus/index.js";

const intentCard = {
  schemaVersion: 1,
  behavior: "Parse a comma-separated list of integers and return them as an array",
  inputs: [{ name: "raw", typeHint: "string", description: "The raw CSV string" }],
  outputs: [{ name: "result", typeHint: "number[]", description: "Parsed integers" }],
  preconditions: ["raw is a non-empty string"],
  postconditions: ["result.length >= 0"],
  notes: ["Trailing commas are ignored"],
  modelVersion: "claude-3-5-haiku-20241022",
  promptVersion: "v1.0",
  sourceHash: "deadbeef",
  extractedAt: "2025-01-01T00:00:00.000Z",
};

const source = `function parseIntList(raw) { return raw.split(",").map(Number).filter(Number.isFinite); }`;

const result = await extractCorpus({ source, intentCard });

const decoder = new TextDecoder();
const utf8Content = decoder.decode(result.bytes);
const first20Lines = utf8Content.split("\n").slice(0, 20).join("\n");
const bytesHex = Buffer.from(result.bytes).toString("hex");

process.stdout.write(
  `${JSON.stringify(
    {
      source: result.source,
      path: result.path,
      contentHash: result.contentHash,
      bytesHex,
      bytesLength: result.bytes.length,
      first20LinesDecoded: first20Lines,
    },
    null,
    2,
  )}\n`,
);
