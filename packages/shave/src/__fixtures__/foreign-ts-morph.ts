// SPDX-License-Identifier: MIT
// Fixture C: foreign-block test fixture for WI-V2-04 L5.
// Tests the classifyForeign + policy gate path for ts-morph#Project.
// Real ts-morph requirement: uses actual ts-morph package (not a mock).
// Authority: packages/shave/src/__fixtures__/ (L5-I1)
import { Project } from "ts-morph";

export function newProject(): Project {
  return new Project();
}
