#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Build tasks/<id>.json for the corpus composition tasks (GH #1272) from
// tasks-src/corpus-tasks.mjs. Each slice candidate's `ref` ({ file, name }) is resolved to
// the exact span of that definition in the shave corpus fixtures, so every candidate's text
// is real corpus source and its citation names the lines it came from.
//   node harness/build-tasks.mjs           write the task files
//   node harness/build-tasks.mjs --check   exit 1 if any task file is stale
// No network, no model.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const benchDir = resolve(here, "..");
const repo = resolve(benchDir, "..", "..");
export const FIXTURES = join(repo, "packages/shave/src/__fixtures__/module-graph");

/**
 * Find the line span of the definition `name` in `text`: a function declaration, a
 * const/let/var binding, a class, or a class method. The span runs from the definition
 * line to the line holding the matching close brace (or the end of a one-line binding).
 * Returns 1-based inclusive line numbers.
 */
export function findDefinition(text, name) {
  const lines = text.split("\n");
  const id = name.replace(/[$]/g, "\\$&");
  const patterns = [
    new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${id}\\s*\\(`),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${id}\\s*=`),
    new RegExp(`^\\s*(?:export\\s+)?class\\s+${id}\\b`),
    new RegExp(`^\\s+${id}\\s*\\([^)]*\\)\\s*\\{`),
  ];
  const start = lines.findIndex((l) => patterns.some((p) => p.test(l)));
  if (start < 0) throw new Error(`definition ${name} not found`);
  const end = matchBraces(lines, start);
  return { lineStart: start + 1, lineEnd: end + 1 };
}

// Scan from line `start` to the line where the first `{` opened there is closed. Strings,
// template literals, comments and regex literals are skipped so braces inside them do not
// count. A definition with no brace on its first line ends at the first line ending in `;`.
function matchBraces(lines, start) {
  const src = lines.slice(start).join("\n");
  let depth = 0;
  let opened = false;
  let line = start;
  let prevSignificant = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\n") {
      line++;
      if (!opened && /[;)]\s*$/.test(lines[line - 1] ?? "")) return line - 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i) - 1;
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      line += src.slice(i, close).split("\n").length - 1;
      i = close + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\") j++;
        else if (src[j] === "\n") line++;
        j++;
      }
      i = j;
      prevSignificant = ch;
      continue;
    }
    if (ch === "/" && /[(,=:[!&|?{};]|^$/.test(prevSignificant)) {
      // A regex literal: skip to its closing slash, honouring classes and escapes.
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j++;
      }
      i = j;
      prevSignificant = "/";
      continue;
    }
    if (ch === "{") {
      depth++;
      opened = true;
    } else if (ch === "}") {
      depth--;
      if (opened && depth === 0) return line;
    }
    if (!/\s/.test(ch)) prevSignificant = ch;
  }
  throw new Error(`unbalanced braces from line ${start + 1}`);
}

/** Resolve a ref to a slice candidate: the source text, its package, and a citation. */
export function resolveRef(ref) {
  const path = join(FIXTURES, ref.file);
  const fileText = readFileSync(path, "utf8");
  const { lineStart, lineEnd } = findDefinition(fileText, ref.name);
  const text = fileText
    .split("\n")
    .slice(lineStart - 1, lineEnd)
    .join("\n");
  const sourcePkg = ref.file.split("/")[0];
  // These spans are not registry blocks, so there is no block merkle root. The citation
  // carries a content hash of the span, which the self-test re-derives from the fixture.
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  return {
    sourcePkg,
    text,
    citation: {
      merkleRoot: `unregistered-sha256-${hash}`,
      sourceFile: ref.file,
      lineStart,
      lineEnd,
    },
  };
}

/** The JSON a corpus task is stored as. */
export function buildTask(src) {
  return {
    id: src.id,
    entry: src.entry,
    difficulty: src.difficulty,
    atoms: src.atoms,
    spec: src.spec,
    reference: src.reference,
    slice: src.slice.map((c) => ({ id: c.id, score: c.score, ref: c.ref, ...resolveRef(c.ref) })),
    heldOut: src.heldOut,
  };
}

async function main() {
  const check = process.argv.includes("--check");
  const { corpusTasks } = await import(
    pathToFileURL(join(benchDir, "tasks-src", "corpus-tasks.mjs")).href
  );
  let stale = 0;
  for (const src of corpusTasks) {
    const out = join(benchDir, "tasks", `${src.id}.json`);
    const json = `${JSON.stringify(buildTask(src), null, 2)}\n`;
    let current = "";
    try {
      current = readFileSync(out, "utf8");
    } catch {}
    if (current === json) continue;
    stale++;
    if (check) console.error(`stale: tasks/${src.id}.json`);
    else writeFileSync(out, json);
  }
  if (check && stale > 0) process.exit(1);
  console.log(
    check
      ? `${corpusTasks.length} corpus tasks up to date`
      : `wrote ${stale} of ${corpusTasks.length} corpus tasks`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
