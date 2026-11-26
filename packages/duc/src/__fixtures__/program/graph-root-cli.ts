// SPDX-License-Identifier: Apache-2.0
// The interim fixpoint's command (#1370, step 5): each argument a graph in the compact encoding, as
// JSON; for each, its root, one line each: what the store's `packGraph` gives. Built natively.
import { type CompactGraph, decodeGraph } from "../../compact.js";
import { rootedGraph } from "../../root.js";

for (const text of process.argv.slice(2))
  console.log(rootedGraph(decodeGraph(JSON.parse(text) as CompactGraph)).root);
