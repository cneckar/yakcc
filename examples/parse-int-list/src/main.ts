// SPDX-License-Identifier: MIT
// @decision DEC-EXAMPLE-MAIN-001: Demo entry point for parse-int-list.
// Status: implemented (WI-009)
// Rationale: Demonstrates the full v0 assembly pipeline end-to-end. Reads the
// compiled dist/module.ts produced by `yakcc compile examples/parse-int-list`,
// transpiles it via the TypeScript compiler API (available as a workspace
// devDependency), and calls the assembled listOfInts function with sample inputs.
// Using the TypeScript compiler API avoids requiring tsx or ts-node as an extra
// installed tool — `typescript` is already a workspace-level devDependency.
//
// Run after `pnpm build` and `yakcc compile examples/parse-int-list`:
//   node --import tsx/esm examples/parse-int-list/src/main.ts
// OR (using the workspace TypeScript API directly):
//   pnpm --filter @yakcc/cli exec node examples/parse-int-list/src/main.mjs

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(__dirname, "..");
const compiledModulePath = join(exampleRoot, "dist", "module.ts");
const transpiledPath = join(exampleRoot, "dist", "module.mjs");

// Verify the compiled module exists.
if (!existsSync(compiledModulePath)) {
  console.error(`error: compiled module not found at ${compiledModulePath}`);
  console.error("Run: pnpm --filter @yakcc/cli exec yakcc compile examples/parse-int-list");
  process.exit(1);
}

// Transpile the TypeScript module to ESM using the workspace TypeScript compiler.
const req = createRequire(import.meta.url);
// Resolve typescript from the workspace root, which hoists it for all packages.
const ts = req("typescript") as typeof import("typescript");

const source = readFileSync(compiledModulePath, "utf-8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: false,
  },
});
writeFileSync(transpiledPath, transpiled.outputText, "utf-8");

// Dynamically import the transpiled module.
const mod = (await import(pathToFileURL(transpiledPath).href)) as {
  listOfInts: (input: string) => ReadonlyArray<number>;
};

// Run with the CLI argument or the default sample inputs.
const cliArg = process.argv[2];

if (cliArg !== undefined) {
  // Single input from CLI: node main.mjs '[1,2,3]'
  try {
    const result = mod.listOfInts(cliArg);
    console.log(`listOfInts(${JSON.stringify(cliArg)}) => ${JSON.stringify(result)}`);
  } catch (err) {
    console.error(`listOfInts(${JSON.stringify(cliArg)}) threw: ${String(err)}`);
    process.exit(1);
  }
} else {
  // Default demo: print several sample inputs.
  const samples = ["[1,2,3]", "[]", "[ 42 ]", "[10,200,3000]"] as const;

  console.log("parse-int-list demo — assembled by Yakcc v0");
  console.log("============================================");
  for (const sample of samples) {
    const result = mod.listOfInts(sample);
    console.log(`  listOfInts(${JSON.stringify(sample)}) => ${JSON.stringify(result)}`);
  }
  console.log("");
  console.log("Error cases:");
  const errorCases = ["[abc]", "[1,2,", "[1]x"] as const;
  for (const bad of errorCases) {
    try {
      mod.listOfInts(bad);
      console.log(`  listOfInts(${JSON.stringify(bad)}) => (no error — unexpected!)`);
    } catch (err) {
      const name = err instanceof Error ? err.constructor.name : "Error";
      console.log(`  listOfInts(${JSON.stringify(bad)}) => throws ${name}`);
    }
  }
}
