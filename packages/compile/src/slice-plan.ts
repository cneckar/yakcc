// SPDX-License-Identifier: MIT
// @decision DEC-V2-GLUE-LEAF-WASM-001
// title: WASM backend strategy for GlueLeafEntry — option (a) reject on glue
// status: decided (WI-V2-GLUE-LEAF-CONTRACT)
// rationale:
//   Three options were evaluated at WI dispatch:
//   (a) reject — throw GlueLeafInWasmModeError; callers must use compileToTypeScript.
//   (b) embed verbatim JS trampoline — not possible in a WASM binary; glue is TS source.
//   (c) link-time reference — requires a host-side link protocol that does not exist yet.
//   Option (a) is chosen: it is honest (WASM cannot embed TS glue verbatim), safe
//   (no silent data loss), and actionable (error message points to compileToTypeScript).
//   Option (c) is deferred to a future WI when the host link protocol is specified.
//   The typed GlueLeafInWasmModeError carries the first offending entry's hash and
//   reason so callers can log or surface it without re-running the slicer.
//
// @decision DEC-V2-GLUE-LEAF-TS-EMIT-001
// title: compileToTypeScript emits GlueLeafEntry verbatim with comment boundaries
// status: decided (WI-V2-GLUE-LEAF-CONTRACT)
// rationale:
//   Glue source is project-local TypeScript that didn't shave. Emitting it verbatim
//   inside the assembled module is the correct semantic: the output program is
//   "local atoms + novel glue + glue regions", all in TS. Comment boundaries
//   (// --- glue: <hash[:8]> ---) make glue regions auditable in the assembled
//   output without requiring re-running the slicer. Import ordering preservation
//   (glue at the position it appears in the DFS plan) is a natural consequence of
//   iterating plan.entries in order.

import type { GlueLeafEntry, SlicePlan, SlicePlanEntry } from "@yakcc/shave";

// ---------------------------------------------------------------------------
// GlueLeafInWasmModeError
// ---------------------------------------------------------------------------

/**
 * Thrown by compileSlicePlanToWasm when the slice plan contains one or more
 * GlueLeafEntry records. WASM cannot embed verbatim TypeScript glue source —
 * callers must use compileToTypeScript instead.
 *
 * @decision DEC-V2-GLUE-LEAF-WASM-001 (see file header)
 */
export class GlueLeafInWasmModeError extends Error {
  /** The canonical AST hash of the first offending GlueLeafEntry. */
  readonly canonicalAstHash: string;
  /** The reason the first offending subgraph was not shaveable. */
  readonly glueReason: string;

  constructor(entry: GlueLeafEntry) {
    super(
      `GlueLeafEntry (hash ${entry.canonicalAstHash.slice(0, 8)}) cannot be compiled to WASM: ` +
        `"${entry.reason}". Use compileToTypeScript instead — the TS backend emits glue verbatim.`,
    );
    this.name = "GlueLeafInWasmModeError";
    this.canonicalAstHash = entry.canonicalAstHash;
    this.glueReason = entry.reason;
  }
}

// ---------------------------------------------------------------------------
// compileToTypeScript — SlicePlan → TS source string
// ---------------------------------------------------------------------------

/**
 * Compile a SlicePlan to a TypeScript source string.
 *
 * Entry ordering follows plan.entries (DFS order from the slicer), preserving
 * import ordering so glue code that depends on local atoms compiles correctly.
 *
 * Per-entry emit rules (DEC-V2-GLUE-LEAF-TS-EMIT-001):
 *   PointerEntry     — emits a comment referencing the registry block; the block
 *                      source is not available without a registry lookup, so only
 *                      the identity comment is emitted. A future WI can accept a
 *                      block-source resolver callback.
 *   NovelGlueEntry   — emits the novel source verbatim (no markers needed; this
 *                      IS the new code).
 *   GlueLeafEntry    — emits the verbatim glue source delineated by comment markers
 *                      so the boundary is auditable in the assembled output.
 *   ForeignLeafEntry — skipped; foreign imports are opaque leaves and are not
 *                      inlined into the assembled TS module.
 *
 * @param plan - The SlicePlan produced by slice() (or a manually constructed plan).
 * @returns A TS source string suitable for further compilation or inspection.
 */
export function compileToTypeScript(plan: SlicePlan): string {
  const parts: string[] = [];

  parts.push(
    "// Assembled by @yakcc/compile (slice-plan path) — do not edit by hand.\n" +
      "// Glue regions are reproduced verbatim; local atoms are referenced by block identity.",
  );

  for (const entry of plan.entries) {
    const chunk = emitEntry(entry);
    if (chunk !== null) {
      parts.push(chunk);
    }
  }

  return `${parts.join("\n")}\n`;
}

function emitEntry(entry: SlicePlanEntry): string | null {
  switch (entry.kind) {
    case "pointer":
      return `\n// --- pointer: ${entry.merkleRoot} (${entry.canonicalAstHash.slice(0, 8)}) ---`;

    case "novel-glue":
      return `\n// --- novel-glue: ${entry.canonicalAstHash.slice(0, 8)} ---\n${entry.source}`;

    case "glue": {
      const shortHash = entry.canonicalAstHash.slice(0, 8);
      return `\n// --- glue: ${shortHash} (not in registry) ---\n${entry.source}\n// --- end glue ---`;
    }

    case "foreign-leaf":
      // Foreign imports are not inlined into the assembled module.
      return null;
  }
}

// ---------------------------------------------------------------------------
// compileSlicePlanToWasm — SlicePlan → WASM binary (rejects glue)
// ---------------------------------------------------------------------------

/**
 * Validate that a SlicePlan contains no GlueLeafEntry records before handing
 * off to the WASM backend.
 *
 * Throws GlueLeafInWasmModeError on the first GlueLeafEntry encountered.
 * If the plan is glue-free, returns the first GlueLeafEntry found (undefined
 * when clean), allowing callers to check without catching.
 *
 * Use compileToTypeScript for plans that contain glue regions.
 *
 * @decision DEC-V2-GLUE-LEAF-WASM-001 (option a: reject on glue)
 * @throws GlueLeafInWasmModeError if any GlueLeafEntry is present in the plan.
 */
export function assertNoGlueLeaf(plan: SlicePlan): void {
  for (const entry of plan.entries) {
    if (entry.kind === "glue") {
      throw new GlueLeafInWasmModeError(entry);
    }
  }
}
