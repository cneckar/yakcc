/**
 * Tools: yakcc_find_modules, yakcc_get_module — module discovery for a composing model.
 *
 * @decision DEC-MCP-MODULES-001
 * @title Find large modules by a described need; the composing model confirms
 * @status decided (lane:reuse; evidence in bench/B12-need-to-code and bench/B13-module-discovery)
 * @rationale
 *   A composing model describes the capability it needs in one or two sentences (no code, no
 *   examples). yakcc_find_modules returns the top few large modules (graph roots whose
 *   closures do substantial work) with their descriptive names, so the model can read them and
 *   pick one or none; yakcc_get_module returns the picked module's source. The pick is the
 *   decision: B13 measured it right 95% of the time when the module was shown, and "none"
 *   every time it was not, while retrieval scores alone do not separate right from wrong
 *   (B11). So the tool returns no "match" verdict, only ordered candidates and what each costs
 *   to write (closure tokens), which is the saving if it is reused.
 *
 *   Index: a module index built offline by scripts/build-module-index.mjs, read from the path
 *   in YAKCC_MODULE_INDEX and cached for the process. Search: @yakcc/discovery-search's
 *   searchModules (dense + BM25 + reciprocal rank fusion). The query is embedded with the
 *   local provider, which must be the model the index was built with; a mismatch is an error,
 *   not a silent wrong ranking.
 *
 *   Both tools follow DEC-MCP-ERROR-AS-CONTENT-004: errors come back as content, never thrown.
 */

import { readFile } from "node:fs/promises";
import {
  type ModuleIndex,
  moduleSource,
  parseModuleIndex,
  searchModules,
} from "@yakcc/discovery-search";
import type { MCPContent, ToolModule } from "./types.js";

/** What the tools need from their environment; injected in tests. */
export interface ModuleToolDeps {
  /** The module index (cached by the caller if it likes). */
  loadIndex(): Promise<ModuleIndex>;
  /** Embed a query with the index's model; returns the model id it used. */
  embed(text: string): Promise<{ vector: Float32Array; model: string }>;
}

const text = (v: unknown): MCPContent[] => [{ type: "text", text: JSON.stringify(v) }];
const error = (code: string, message: string): MCPContent[] => text({ error: code, message });

let cachedIndex: Promise<ModuleIndex> | undefined;
let cachedEmbedder:
  | Promise<{ embed(t: string): Promise<Float32Array>; modelId: string }>
  | undefined;

/** The production dependencies: the index at YAKCC_MODULE_INDEX, the local embedding provider. */
export const defaultModuleDeps: ModuleToolDeps = {
  loadIndex() {
    const path = process.env.YAKCC_MODULE_INDEX;
    if (!path)
      return Promise.reject(
        new Error("YAKCC_MODULE_INDEX is not set; build one with scripts/build-module-index.mjs"),
      );
    cachedIndex ??= readFile(path, "utf8").then((s) => parseModuleIndex(JSON.parse(s)));
    return cachedIndex;
  },
  async embed(t) {
    cachedEmbedder ??= import("@yakcc/contracts").then((c) => c.createLocalEmbeddingProvider());
    const p = await cachedEmbedder;
    return { vector: await p.embed(t), model: p.modelId };
  },
};

/** yakcc_find_modules, over the given dependencies. */
export function makeFindModulesTool(deps: ModuleToolDeps = defaultModuleDeps): ToolModule {
  return {
    name: "yakcc_find_modules",
    description:
      "Find existing modules that implement a capability you need, before writing it. Describe the need in one or two sentences, in your own words (what it takes, what it returns, the behavior that matters); no code. Returns up to k candidate modules with descriptive names. Read them and reuse one only if its description matches your need; if none does, write the code yourself. closureTokens is roughly what writing the module would cost.",
    inputSchema: {
      type: "object",
      properties: {
        need: { type: "string", description: "The capability you need, in one or two sentences." },
        k: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "How many candidates (default 5).",
        },
      },
      required: ["need"],
      additionalProperties: false,
    },
    async handler(args) {
      const a = (args ?? {}) as { need?: unknown; k?: unknown };
      if (typeof a.need !== "string" || a.need.trim().length === 0)
        return error("invalid_input", "need must be a non-empty string");
      if (
        a.k !== undefined &&
        (typeof a.k !== "number" || !Number.isInteger(a.k) || a.k < 1 || a.k > 10)
      )
        return error("invalid_input", "k must be an integer between 1 and 10");
      let index: ModuleIndex;
      try {
        index = await deps.loadIndex();
      } catch (err) {
        return error("index_unavailable", err instanceof Error ? err.message : String(err));
      }
      try {
        const q = await deps.embed(a.need);
        if (q.model !== index.model)
          return error(
            "model_mismatch",
            `the index was built with ${index.model}, the query embedded with ${q.model}`,
          );
        const hits = searchModules(index, q.vector, a.need, {
          k: (a.k as number | undefined) ?? 5,
        });
        return text({
          candidates: hits.map((h, i) => ({
            pick: i + 1,
            id: h.entry.id,
            module: h.entry.text,
            closureTokens: h.entry.closureTokens,
          })),
          note: "Reuse a candidate only if its description matches the need; otherwise write it. Fetch the code with yakcc_get_module.",
        });
      } catch (err) {
        return error("search_failed", err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/** yakcc_get_module, over the given dependencies. */
export function makeGetModuleTool(deps: ModuleToolDeps = defaultModuleDeps): ToolModule {
  return {
    name: "yakcc_get_module",
    description:
      "Get the source of a module returned by yakcc_find_modules: the root definition first, then the definitions it depends on.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "A module id from yakcc_find_modules." } },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(args) {
      const a = (args ?? {}) as { id?: unknown };
      if (typeof a.id !== "string" || a.id.length === 0)
        return error("invalid_input", "id must be a non-empty string");
      let index: ModuleIndex;
      try {
        index = await deps.loadIndex();
      } catch (err) {
        return error("index_unavailable", err instanceof Error ? err.message : String(err));
      }
      const parts = moduleSource(index, a.id);
      if (parts === null) return error("not_found", `no module ${a.id} in the index`);
      return text({ id: a.id, definitions: parts });
    },
  };
}

export const findModulesTool = makeFindModulesTool();
export const getModuleTool = makeGetModuleTool();
