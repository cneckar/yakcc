// SPDX-License-Identifier: Apache-2.0
// Write src/atoms/v8-bigint.ts: V8's src/bigint shaved, with musl's memcpy, memset, memmove and
// abort (#1516). Run from packages/duc: `tsx scripts/shave-v8-bigint.ts`, then format with biome.
// Needs clang.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  shaveV8BigIntLibrary,
  v8BigIntLibrarySource,
} from "../src/__fixtures__/v8-bigint-library.js";

const lib = shaveV8BigIntLibrary();
if (lib.refused.length > 0) throw new Error(`refused: ${lib.refused.join("; ")}`);
for (const [file, text] of v8BigIntLibrarySource(lib))
  writeFileSync(fileURLToPath(new URL(`../src/atoms/${file}`, import.meta.url)), text);
console.log(`${lib.atoms.size} atoms, ${lib.statics.size} statics`);
