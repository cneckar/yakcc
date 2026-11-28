// SPDX-License-Identifier: Apache-2.0
// Write src/atoms/v8-numbers.ts: V8's number conversions shaved, with ICU's uchar.cpp and musl
// (#1516). Run from packages/duc: `tsx scripts/shave-v8-numbers.ts`, then format with biome.
// Needs clang.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  shaveV8NumbersLibrary,
  v8NumbersLibrarySource,
} from "../src/__fixtures__/v8-numbers-library.js";

const lib = shaveV8NumbersLibrary();
if (lib.refused.length > 0) throw new Error(`refused: ${lib.refused.join("; ")}`);
for (const [file, text] of v8NumbersLibrarySource(lib))
  writeFileSync(fileURLToPath(new URL(`../src/atoms/${file}`, import.meta.url)), text);
console.log(
  `${lib.atoms.size} atoms, ${lib.statics.size} statics; left: ${lib.externals.join(" ")}`,
);
