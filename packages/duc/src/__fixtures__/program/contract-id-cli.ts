// SPDX-License-Identifier: Apache-2.0
// The interim acceptance's command (#1361, #1333): each argument a ContractSpec as JSON; for each,
// its contract id and its canonical text's length, one line each. Built natively from the sources of
// @yakcc/contracts and @noble/hashes by `yakcc build --native`.
import { canonicalizeText } from "../../../../contracts/src/canonicalize.js";
import { contractId } from "../../../../contracts/src/contract-id.js";
import type { ContractSpec } from "../../../../contracts/src/index.js";

const specs = process.argv.slice(2);
if (specs.length === 0) {
  console.error("usage: contract-id <spec.json>...");
  process.exitCode = 2;
}
for (const text of specs) {
  const spec = JSON.parse(text) as ContractSpec;
  console.log("%s %d", contractId(spec), canonicalizeText(spec).length);
}
