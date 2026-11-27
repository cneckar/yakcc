// SPDX-License-Identifier: Apache-2.0
// The interim fixpoint's command (#1370, step 5): each graph in the compact encoding, as JSON, in
// arguments ended by `--`; for each, its root, one line each: what the store's `packGraph` gives.
// Built natively.
import { type CompactGraph, decodeGraph } from "../../compact.js";
import { rootedGraph } from "../../root.js";

// A graph's JSON may be longer than one argument may be (128 KiB on Linux): it is given in parts, and
// an argument `--` ends it.
let text = "";
for (const part of process.argv.slice(2)) {
  if (part !== "--") {
    text += part;
    continue;
  }
  console.log(rootedGraph(decodeGraph(JSON.parse(text) as CompactGraph)).root);
  text = "";
}
