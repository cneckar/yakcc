// SPDX-License-Identifier: MIT
// Combined fixture: two foreign deps in one file for WI-V2-04 L5.
// Tests that tag policy surfaces both entries in source-declaration order:
//   1. node:fs#readFileSync (first import)
//   2. ts-morph#Project (second import)
// Authority: packages/shave/src/__fixtures__/ (L5-I1)
import { readFileSync } from "node:fs";
import { Project } from "ts-morph";

export function loadProjectFromDisk(path: string): Project {
  const _src = readFileSync(path, "utf-8");
  return new Project();
}
