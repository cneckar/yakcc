/**
 * Tool: yakcc_check_duplicates — before storing a function, find stored code that behaves the same.
 *
 * @decision DEC-MCP-CHECK-DUPLICATES-001
 * @title Return behaviorally verified neighbors of newly written code, with verdicts
 * @status decided (lane:reuse; evidence in bench/B15-upsert-dedup; registry side is #1342)
 * @rationale
 *   An agent that has written a function asks whether the registry already has it. The tool
 *   runs the new function (DEC-MCP-BEHAVIOR-001) and compares it with stored definitions'
 *   recorded outputs, and returns neighbors with a verdict each: equivalent, near (with the
 *   inputs where they differ), different, or inconclusive. The caller decides: use the stored
 *   one, keep its own, or store its own as an alternative. Candidates come from behavior (the
 *   probe fingerprint) and from text (BM25 over descriptions, when a description is given);
 *   B15 found the two sources complementary (each ~87% alone, 97% together).
 *
 *   The behavior index is read from YAKCC_BEHAVIOR_INDEX (built by
 *   scripts/build-behavior-index.mjs). Until the registry stores tests and equivalence links
 *   (#1342), the index is local. Errors come back as content (DEC-MCP-ERROR-AS-CONTENT-004).
 */

import { readFile } from "node:fs/promises";
import { bm25Rank } from "@yakcc/discovery-search";
import {
  type BehaviorIndex,
  findNeighbors,
  loadFunction,
  parseBehaviorIndex,
  passesExamples,
} from "../behavior.js";
import type { MCPContent, ToolModule } from "./types.js";

export interface CheckDuplicatesDeps {
  loadIndex(): Promise<BehaviorIndex>;
}

const text = (v: unknown): MCPContent[] => [{ type: "text", text: JSON.stringify(v) }];
const error = (code: string, message: string): MCPContent[] => text({ error: code, message });

let cached: Promise<BehaviorIndex> | undefined;

export const defaultCheckDuplicatesDeps: CheckDuplicatesDeps = {
  loadIndex() {
    const path = process.env.YAKCC_BEHAVIOR_INDEX;
    if (!path)
      return Promise.reject(
        new Error(
          "YAKCC_BEHAVIOR_INDEX is not set; build one with scripts/build-behavior-index.mjs",
        ),
      );
    cached ??= readFile(path, "utf8").then((s) => parseBehaviorIndex(JSON.parse(s)));
    return cached;
  },
};

export function makeCheckDuplicatesTool(
  deps: CheckDuplicatesDeps = defaultCheckDuplicatesDeps,
): ToolModule {
  return {
    name: "yakcc_check_duplicates",
    description:
      "Before storing a function you wrote, check whether stored code already behaves the same. Pass the function's source (self-contained TypeScript or JavaScript, no imports), its parameter types, and optionally a one-sentence description and examples. The tool runs your function on fixed inputs and compares its outputs with stored definitions' recorded outputs. Each neighbor gets a verdict: equivalent (agrees on every input tried), near (agrees on most; counterexamples show where they differ), different, or inconclusive. Equivalent is evidence from the inputs tried, not proof.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The function's source." },
        name: {
          type: "string",
          description: "The function to check, when the code declares several.",
        },
        paramTypes: {
          type: "array",
          items: { type: "string" },
          description:
            'Declared parameter types, in order (e.g. ["string", "number[]"]); the arity is their count.',
        },
        description: {
          type: "string",
          description: "What it does, in one sentence (adds text-matched candidates).",
        },
        examples: {
          type: "array",
          description:
            "Example calls ({ args: [...], returns: value }); the tool reports whether your function passes them.",
          items: { type: "object" },
        },
        k: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Candidates per source (default 5).",
        },
      },
      required: ["code", "paramTypes"],
      additionalProperties: false,
    },
    async handler(args: unknown): Promise<MCPContent[]> {
      const a = (args ?? {}) as Record<string, unknown>;
      if (typeof a.code !== "string" || a.code.trim() === "")
        return error("invalid_args", "code must be a non-empty string");
      if (!Array.isArray(a.paramTypes) || !a.paramTypes.every((t) => typeof t === "string"))
        return error("invalid_args", "paramTypes must be an array of strings");
      const paramTypes = a.paramTypes as string[];
      const k = Number.isInteger(a.k) ? Math.min(20, Math.max(1, a.k as number)) : 5;
      let index: BehaviorIndex;
      try {
        index = await deps.loadIndex();
      } catch (err) {
        return error("index_unavailable", String((err as Error).message));
      }
      let f: ReturnType<typeof loadFunction>;
      try {
        f = loadFunction(a.code, typeof a.name === "string" ? a.name : undefined);
      } catch (err) {
        return error("code_not_loadable", String((err as Error).message).slice(0, 300));
      }
      const textRanked =
        typeof a.description === "string" && a.description.trim()
          ? bm25Rank(
              index.entries.map((e) => `${e.name} ${e.text}`),
              a.description,
            )
          : [];
      const examples = Array.isArray(a.examples)
        ? (a.examples as { args?: unknown; returns?: unknown; throws?: unknown }[]).filter((e) =>
            Array.isArray(e?.args),
          )
        : [];
      const { neighbors, probesRun } = findNeighbors(index, f, {
        arity: paramTypes.length,
        paramTypes,
        textRanked,
        exampleArgs: examples.map((e) => e.args as unknown[]),
        k,
      });
      return text({
        probesRun,
        passesOwnExamples: examples.length > 0 ? passesExamples(f, examples) : null,
        neighbors,
      });
    },
  };
}

export const checkDuplicatesTool: ToolModule = makeCheckDuplicatesTool();
