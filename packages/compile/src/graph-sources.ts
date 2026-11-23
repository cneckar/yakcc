// SPDX-License-Identifier: MIT
// @decision DEC-COMPILE-GRAPH-SOURCE-001 (#1279): the stored graph is the authority for a block's
// code. withGraphSources(registry) serves each block that has a DUC implementation with its code
// generated from the graph (emitTypeScript), the exported function keeping its name and the
// parameters their contract types; the stored implSource is then only a cache. The block's import
// declarations are kept as written: they are its links (references to other blocks), which are not
// part of the graph's identity, and composition resolves sub-blocks through them.
// A block with no stored graph, or one the emitter cannot express, is served as stored.

import type { BlockMerkleRoot } from "@yakcc/contracts";
import { type EmitSignature, emitTypeScript, unpackGraph } from "@yakcc/duc";
import type { BlockTripletRow, Registry } from "@yakcc/registry";

/** The exported function's name in a block's source, as assemble() keys blocks. */
function exportedName(source: string): string | undefined {
  for (const line of source.split("\n")) {
    const match = line.match(/^export\s+(?:async\s+)?function\s*\*?\s*(\w+)\s*[(<]/);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

/** The import declarations of a block's source, as written. */
function importDeclarations(source: string): string[] {
  const out: string[] = [];
  let current: string[] | undefined;
  for (const line of source.split("\n")) {
    if (current === undefined && /^import\s/.test(line)) current = [];
    if (current !== undefined) {
      current.push(line);
      if (/;\s*$/.test(line) || /from\s+["'][^"']+["']\s*;?\s*$/.test(line)) {
        out.push(current.join("\n"));
        current = undefined;
      }
    }
  }
  return out;
}

/** The contract's input and output types, as the emitter annotates them. */
function signatureOf(row: BlockTripletRow): EmitSignature | undefined {
  try {
    const spec = JSON.parse(new TextDecoder().decode(row.specCanonicalBytes)) as {
      inputs?: { type?: string }[];
      outputs?: { type?: string }[];
    };
    const inputs = (spec.inputs ?? []).map((i) => i.type ?? "unknown");
    const output = spec.outputs?.[0]?.type;
    return output !== undefined ? { inputs, output } : { inputs };
  } catch {
    return undefined;
  }
}

/**
 * A block's code generated from its stored graph, or undefined when it has none (or none the
 * emitter can express).
 */
export async function graphSourceOf(
  registry: Registry,
  row: BlockTripletRow,
): Promise<string | undefined> {
  const name = exportedName(row.implSource);
  if (name === undefined) return undefined;
  for (const identity of await registry.listDucImplementations(row.specHash)) {
    const impl = await registry.getDucImplementation(row.specHash, identity);
    if (impl === null || impl.blockMerkleRoot !== row.blockMerkleRoot) continue;
    let code: string;
    try {
      const graph = unpackGraph({
        formatVersion: impl.formatVersion,
        structure: impl.structure,
        // A stored link's reason is one the store wrote: a diamond reason.
        links: impl.links as unknown as Parameters<typeof unpackGraph>[0]["links"],
        ...(impl.annotations !== undefined && impl.annotations !== null
          ? { annotations: impl.annotations }
          : {}),
      });
      code = emitTypeScript(graph, signatureOf(row), { name });
    } catch {
      return undefined;
    }
    // The block's own import declarations are its links; the emitter's are not needed beside them.
    const body = code.split("\n").filter((line) => !/^import\s/.test(line));
    return [...importDeclarations(row.implSource), ...body].join("\n");
  }
  return undefined;
}

/**
 * The registry with each block's code generated from its stored graph (DEC-COMPILE-GRAPH-SOURCE-001):
 * pass it to assemble() to compile from the graphs.
 */
export function withGraphSources(registry: Registry): Registry {
  const getBlock = async (root: BlockMerkleRoot): Promise<BlockTripletRow | null> => {
    const row = await registry.getBlock(root);
    if (row === null) return null;
    const source = await graphSourceOf(registry, row);
    return source === undefined ? row : { ...row, implSource: source };
  };
  return new Proxy(registry, {
    get(target, prop, receiver) {
      if (prop === "getBlock") return getBlock;
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
