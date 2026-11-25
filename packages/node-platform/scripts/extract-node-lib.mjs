// SPDX-License-Identifier: Apache-2.0
// Extract Node's built-in library from the running binary into vendor/node-<version>/lib (#1331):
// each module's JavaScript as Node ships it inside the binary, keyed by its builtin id. Also the
// internalBinding names the library uses, with each binding's members as this Node exposes them.
// Run with the pinned Node: `node --expose-internals scripts/extract-node-lib.mjs`.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { internalBinding } = require("internal/test/binding");
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "vendor", `node-${process.version}`);
const natives = internalBinding("builtins").natives;
const ids = Object.keys(natives).sort();
for (const id of ids) {
  const file = join(root, "lib", `${id}.js`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, natives[id]);
}
const source = Object.values(natives).join("\n");
const used = [
  ...new Set([...source.matchAll(/internalBinding\(\s*'([a-z_0-9]+)'\s*\)/g)].map((m) => m[1])),
].sort();
const bindings = {};
for (const name of used) {
  try {
    bindings[name] = Object.keys(internalBinding(name)).sort();
  } catch {
    bindings[name] = null; // not in this build (quic, internal_only_v8)
  }
}
writeFileSync(
  join(root, "manifest.json"),
  `${JSON.stringify({ node: process.version, v8: process.versions.v8, modules: ids, bindings }, null, 1)}\n`,
);
console.log(`${ids.length} modules, ${used.length} bindings -> ${root}`);
