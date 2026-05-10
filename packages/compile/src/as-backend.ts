// SPDX-License-Identifier: MIT
//
// @decision DEC-V1-LOWER-BACKEND-REUSE-001
// Title: AssemblyScript backend reuses visitor's numeric-domain analysis; does NOT
//        reuse the in-house WASM byte emitter (LoweringVisitor → WasmFunction bytecode).
// Status: decided (WI-AS-PHASE-1-MVP, Issue #145)
// Rationale:
//   The wave-3 wasm-backend (wasm-backend.ts) contains two distinct halves:
//
//   ANALYSIS HALF (reused here):
//     inferNumericDomain() in wasm-lowering/visitor.ts performs ts-morph AST
//     heuristics to classify `number`-typed TS functions as i32, i64, or f64.
//     That analysis is correct, well-tested, and domain-specific to yakcc's
//     atom signature conventions. The AS backend reuses the same heuristic by
//     re-implementing the lightweight text-scan version (rule -1, 0, 1-7) to
//     avoid importing the entire ts-morph-heavy visitor in a path that already
//     invokes an external compiler process. This re-implementation is validated
//     by the numeric-parity.test.ts suite which uses the same TS function bodies
//     as input. See Phase 0 spike findings (SPIKE_FINDINGS.md §6, Issue #144).
//
//   EMISSION HALF (NOT reused):
//     The hand-rolled WASM binary emitter (WasmFunction IR, opcodes tables,
//     uleb128 encoding) is the incumbent mechanism being superseded by the AS
//     backend in Phase 1. Reusing it would defeat the purpose of this track.
//     Operator adjudication (Issue #142 / Path A) mandates that AS-generated
//     WASM replaces in-house emission as the production path. The in-house
//     emitter continues to run as a differential oracle (wasmBackend()) until
//     Phase 3 retires it.
//
//   Per-atom module boundary (SPIKE_FINDINGS.md §4 / q3-boundary-choice.md):
//     Each yakcc atom maps to one AS file → one .wasm output. This preserves
//     content-addressing granularity: WASM artifact hash traces to a single
//     implSource hash. Per-package batching remains a Phase 1 escape hatch if
//     per-atom instantiation overhead proves excessive in the hot path.
//
// Supporting evidence:
//   - Issue #142: operator adjudication selecting Path A (AS-backed WASM)
//   - Issue #144: Phase 0 spike — asc 0.28.17 determinism confirmed, per-atom
//     boundary validated end-to-end with wasmtime 31.0.0, Q1/Q2/Q3 all PASS
//
// @decision DEC-AS-BACKEND-TMPDIR-001
// Title: AS source and WASM output written to OS temp directory, cleaned up on exit
// Status: decided (WI-AS-PHASE-1-MVP)
// Rationale:
//   The asc compiler requires a real filesystem path for input and output.
//   Using os.tmpdir() keeps the operation stateless from the caller's perspective
//   and avoids polluting the project tree. Temp files are cleaned up after each
//   emit() call regardless of success/failure (finally block). A unique
//   subdirectory per call (randomUUID) prevents concurrent-call collisions.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolutionResult } from "./resolve.js";
import type { WasmBackend } from "./wasm-backend.js";

// ---------------------------------------------------------------------------
// asc binary resolution
//
// Locate the assemblyscript asc compiler relative to this package's
// node_modules. Using createRequire(import.meta.url) finds the package in
// the correct resolution context even when the file is compiled to dist/.
// ---------------------------------------------------------------------------

function resolveAsc(): string {
  const require = createRequire(import.meta.url);
  // assemblyscript exposes its CLI via the "bin" field in its package.json.
  // The asc entry point is bin/asc.js (runs under Node; not the .cmd shim).
  const ascPkgPath: string = require.resolve("assemblyscript/package.json") as string;
  // ascPkgPath: .../node_modules/assemblyscript/package.json
  // asc.js lives at: .../node_modules/assemblyscript/bin/asc.js
  const pkgDir = ascPkgPath.replace(/[/\\]package\.json$/, "");
  return join(pkgDir, "bin", "asc.js");
}

// ---------------------------------------------------------------------------
// Numeric-domain inference
//
// Re-implements the lightweight subset of inferNumericDomain() from
// wasm-lowering/visitor.ts needed for AS type annotation injection.
// This avoids the ts-morph import (heavy, not needed in the AS path)
// while producing identical domain decisions for the numeric substrate.
//
// Rules (matching visitor.ts rules -1, 0, 1-7):
//   i64: large integer literals (> 2^31-1) or `bigint` keyword
//        or BigInt literal suffix `n`
//   i32: bitwise operators (&|^~<<>>>>>), explicit `| 0` pattern,
//        integer-floor hints (Math.floor/ceil/round/trunc),
//        boolean-typed params/return when no f64 indicator present
//   f64: true division (/), float literals (decimal point or `e` notation),
//        Math.sqrt/sin/cos/log/exp/pow/abs/hypot/atan2 etc.,
//        Number.isFinite/Number.isNaN/Number.isInteger
//   Ambiguous → f64 (conservative: f64 is never lossy for integer inputs)
// ---------------------------------------------------------------------------

const F64_MATH_FNS: ReadonlySet<string> = new Set([
  "sqrt",
  "sin",
  "cos",
  "log",
  "exp",
  "pow",
  "abs",
  "hypot",
  "atan2",
  "sign",
  "cbrt",
  "expm1",
  "log1p",
  "log2",
  "log10",
  "atan",
  "asin",
  "acos",
  "sinh",
  "cosh",
  "tanh",
  "asinh",
  "acosh",
  "atanh",
]);

const INTEGER_FLOOR_MATH_FNS: ReadonlySet<string> = new Set(["floor", "ceil", "round", "trunc"]);

type NumericDomain = "i32" | "i64" | "f64";

// @decision DEC-V1-DOMAIN-INFER-PARITY-001
// Title: as-backend inferDomainFromSource priority order aligned with visitor.ts inferNumericDomain
// Status: decided (WI-AS-PHASE-1-MVP-DOMAIN-INFER-PARITY, Issue #170)
// Rationale:
//   Pre-fix, two early-return paths (bigint/n-suffix → i64; >2^31 literal → i64) won
//   over the subsequent f64/bitop scans. visitor.ts checks the priority block in the
//   order bitop > f64 > i64 > floor > fallback. For two edge-case shapes — (a) source
//   with >2^31 literal AND true division, and (b) source with n-suffix bigint AND a
//   bitwise op — the two implementations disagreed. Phase 1 corpus has no such atoms,
//   so no tests failed, but the @decision DEC-V1-LOWER-BACKEND-REUSE-001 annotation's
//   "identical domain decisions" claim was technically false at the edges.
// Fix:
//   Collect i64 indicators into boolean flags alongside f64/bitop/floor flags, then
//   apply the canonical priority block. This makes the "identical decisions" claim
//   literally true for the documented shapes.
// Reference: packages/compile/src/wasm-lowering/visitor.ts inferNumericDomain (read-only consumer)

/**
 * Infer the numeric domain of a TypeScript atom source via text-level heuristics.
 *
 * Matches the policy of inferNumericDomain() in wasm-lowering/visitor.ts
 * (rules -1 through 7) using string scanning instead of ts-morph AST traversal.
 * This is appropriate here because: (1) the AS backend already shells out to asc,
 * so ts-morph's heaviness is not justified; (2) the numeric substrate functions
 * are guaranteed by the evaluation contract to be simple enough for text scanning.
 *
 * @decision DEC-V1-LOWER-BACKEND-REUSE-001 (analysis half reuse)
 * @decision DEC-V1-DOMAIN-INFER-PARITY-001 (priority order alignment)
 */
export function inferDomainFromSource(src: string): NumericDomain {
  // Strip comments to avoid false positives from commented-out code.
  const noComments = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

  let hasF64 = false;
  let hasBitop = false;
  let hasFloorHint = false;
  let hasBigIntKeyword = false;
  let hasBigIntLiteral = false;
  let hasI64RangeLiteral = false;

  // Rule -1 / rule 7: bigint keyword or n-suffix literal (collected as flag, NOT early-return)
  // DEC-V1-DOMAIN-INFER-PARITY-001: these must not short-circuit before bitop/f64 scans
  if (/\bbigint\b/.test(noComments)) hasBigIntKeyword = true;
  if (/\b\d+n\b/.test(noComments)) hasBigIntLiteral = true;

  // Rule 5: large integer literals > 2^31-1 (collected as flag, NOT early-return)
  // DEC-V1-DOMAIN-INFER-PARITY-001: f64 indicators (true division) must win over i64 range literals
  const allNums = noComments.match(/\b(\d+)\b/g);
  if (allNums !== null) {
    for (const lit of allNums) {
      const v = Number(lit);
      if (Number.isInteger(v) && v > 2147483647) {
        hasI64RangeLiteral = true;
        break;
      }
    }
  }

  // Rule 1: true division (/) — but not // (handled by comment stripping)
  // Match `/` that is not `/=` (assign) and not in regex-like contexts.
  if (/[^/*]\s*\/\s*[^/*=]/.test(noComments) || /^\s*\/[^/*=]/.test(noComments)) {
    hasF64 = true;
  }

  // Rule 2: float literals with decimal point or exponent
  if (/\b\d+\.\d*|\b\d*\.\d+|\b\d+[eE][+-]?\d+/.test(noComments)) {
    hasF64 = true;
  }

  // Rule 3: f64 Math functions
  const mathCalls = noComments.match(/Math\.(\w+)/g);
  if (mathCalls !== null) {
    for (const call of mathCalls) {
      const method = call.slice(5); // "Math.".length === 5
      if (F64_MATH_FNS.has(method)) hasF64 = true;
      if (INTEGER_FLOOR_MATH_FNS.has(method)) hasFloorHint = true;
    }
  }

  // Number.isFinite, Number.isNaN, Number.isInteger
  if (/Number\.(isFinite|isNaN|isInteger)/.test(noComments)) {
    hasF64 = true;
  }

  // Rule 4/5: bitwise operators force i32 (takes priority over f64 per visitor.ts)
  // Look for &, |, ^, ~, <<, >>, >>> but not &&, || (logical ops)
  if (/(?<![&|])[&|^~](?![&|])|<<|>>>|>>/.test(noComments)) {
    hasBitop = true;
  }

  // Priority order matching visitor.ts (DEC-V1-DOMAIN-INFER-PARITY-001):
  //   bitop   → i32  (| 0 idiom; DEC-V1-WAVE-3-WASM-LOWER-BITOP-PRIORITY-001)
  //   f64     → f64  (true division / float literal / Math.f64 / Number.is*)
  //   i64     → i64  (bigint keyword / n-suffix / >2^31 literal)
  //   floor   → i32  (Math.floor/ceil/round/trunc hint)
  //   default → f64  (ambiguous → conservative f64)
  if (hasBitop) return "i32";
  if (hasF64) return "f64";
  if (hasBigIntKeyword || hasBigIntLiteral || hasI64RangeLiteral) return "i64";
  if (hasFloorHint) return "i32";

  // Ambiguous → f64 (conservative, matching visitor.ts policy)
  return "f64";
}

// ---------------------------------------------------------------------------
// AS source preparation
//
// Takes the entry block's TypeScript implSource and produces valid
// AssemblyScript source for asc compilation.
//
// Transformations applied (matching tsBackend's cleanBlockSource for stripping,
// then applying AS-specific rewrites):
//   1. Strip TS-only import/export constructs (import type, type aliases,
//      CONTRACT export, shadow type aliases)
//   2. Rewrite `number` type annotations to the inferred AS numeric type
//      (i32 | i64 | f64)
//   3. Handle bigint→i64 rewrites when domain is i64
// ---------------------------------------------------------------------------

const INTRA_IMPORT_RE =
  /^import type\s+\{[^}]*\}\s+from\s+["'](\.|@yakcc\/seeds\/|@yakcc\/blocks\/)[^"']*["'];?\s*$/;
const SHADOW_ALIAS_RE = /^type\s+_\w+\s*=\s*typeof\s+\w+\s*;?\s*$/;
const CONTRACTS_IMPORT_RE = /^import type\s+\{[^}]*\}\s+from\s+["']@yakcc\/contracts["'];?\s*$/;
const CONTRACT_EXPORT_START_RE = /^export const CONTRACT(?:\s*:\s*\w+)?\s*=\s*\{/;

/**
 * Prepare an implSource string for asc compilation.
 *
 * Strips TypeScript-only constructs that asc cannot handle, then rewrites
 * `number` type annotations to the inferred AS numeric type.
 *
 * @param source  - Raw implSource from ResolvedBlock
 * @param domain  - Inferred numeric domain for `number` → AS-type rewriting
 * @returns AS-compatible source string
 */
export function prepareAsSource(source: string, domain: NumericDomain): string {
  const asType = domain === "i64" ? "i64" : domain === "f64" ? "f64" : "i32";

  const lines = source.split("\n");
  const cleaned: string[] = [];
  let contractDepth = 0;

  for (const line of lines) {
    // Skip CONTRACT multi-line declaration (same logic as tsBackend's cleanBlockSource)
    if (contractDepth > 0) {
      for (const ch of line) {
        if (ch === "{") contractDepth++;
        else if (ch === "}") contractDepth--;
      }
      continue;
    }
    if (CONTRACT_EXPORT_START_RE.test(line)) {
      for (const ch of line) {
        if (ch === "{") contractDepth++;
        else if (ch === "}") contractDepth--;
      }
      continue;
    }
    if (INTRA_IMPORT_RE.test(line)) continue;
    if (SHADOW_ALIAS_RE.test(line)) continue;
    if (CONTRACTS_IMPORT_RE.test(line)) continue;

    cleaned.push(line);
  }

  // Remove leading blank lines
  let start = 0;
  while (start < cleaned.length && cleaned[start]?.trim() === "") start++;
  let src = cleaned.slice(start).join("\n");

  // Rewrite TypeScript `number` type annotations to AS numeric type.
  // Replace `: number` in param and return type positions.
  src = src.replace(/:\s*number\b/g, `: ${asType}`);

  // Handle i64 domain: rewrite bigint-specific TS constructs
  if (domain === "i64") {
    // Rewrite `: bigint` type annotations → `: i64`
    src = src.replace(/:\s*bigint\b/g, ": i64");
    // BigInt(n) constructor → direct i64 cast: BigInt(expr) → (expr as i64)
    src = src.replace(/BigInt\(([^)]+)\)/g, "($1 as i64)");
    // BigInt literals: 123n → 123 (AS uses plain integer literals for i64 context)
    src = src.replace(/(\d+)n\b/g, "$1");
  }

  return src;
}

// ---------------------------------------------------------------------------
// Exported factory
// ---------------------------------------------------------------------------

// @decision DEC-AS-BACKEND-OPTIONS-001
// Title: assemblyScriptBackend() accepts optional AsBackendOptions for per-factory asc flags
// Status: decided (WI-AS-PHASE-2A-MULTI-EXPORT-AND-RECORDS, 2026-05-10)
// Rationale:
//   Phase 1 compiled all atoms with --noExportMemory (pure function substrate).
//   Phase 2A adds record substrate support (DEC-AS-RECORD-LAYOUT-001) where the
//   test needs to write struct bytes into the WASM memory before calling the function.
//   This requires omitting --noExportMemory (i.e. exporting memory). Rather than
//   adding a second factory function (which would be a parallel mechanism per
//   Sacred Practice #12), an options bag is passed to the factory. Default behaviour
//   (exportMemory: false) is byte-identical to Phase 1.
//
//   Alternative considered: separate `assemblyScriptRecordBackend()` factory.
//   Rejected: creates two nearly-identical factories that diverge over time. One
//   factory with a documented option is the single-source-of-truth design.
export interface AsBackendOptions {
  /**
   * When true, omit --noExportMemory from the asc invocation so the compiled
   * module exports its linear memory. Required for record substrates where the
   * test harness writes struct bytes directly into WASM memory before calling
   * the entry function. Default: false (matches Phase 1 pure-numeric behaviour).
   *
   * @decision DEC-AS-BACKEND-OPTIONS-001
   * @decision DEC-AS-RECORD-LAYOUT-001
   */
  readonly exportMemory?: boolean;
}

/**
 * Create the AssemblyScript WASM backend.
 *
 * The backend compiles yakcc atoms to .wasm via AssemblyScript (asc).
 * Phase 1 scope: numeric substrate (i32/i64/f64 arithmetic, bitops, Math.*).
 * Phase 2A extensions: multi-export modules (DEC-AS-MULTI-EXPORT-001),
 * records via flat-struct linear-memory (DEC-AS-RECORD-LAYOUT-001).
 *
 * Workflow per emit() call:
 *   1. Extract the entry block's implSource from the ResolutionResult
 *   2. Infer the numeric domain (i32/i64/f64) from source heuristics
 *   3. Prepare AS-compatible source (strip TS-only constructs, rewrite types)
 *   4. Write source to a temp directory, invoke asc via Node child_process
 *   5. Read the .wasm bytes, clean up temp directory, return Uint8Array
 *
 * Multi-export support (DEC-AS-MULTI-EXPORT-001):
 *   asc natively emits exports for every `export function` in the source.
 *   No change to the emitter is needed — prepareAsSource() already preserves
 *   all `export function` declarations. The consumer (closer-parity-as.test.ts)
 *   treats WASM with ≥1 export as covered (structural coverage for P-OTHER,
 *   per-export value parity when an oracle exists).
 *
 * @param opts - Optional factory configuration (see AsBackendOptions)
 * @decision DEC-V1-LOWER-BACKEND-REUSE-001 (see file header)
 * @decision DEC-AS-BACKEND-TMPDIR-001 (see file header)
 * @decision DEC-AS-MULTI-EXPORT-001 (multi-export: asc handles natively; no emitter change)
 * @decision DEC-AS-RECORD-LAYOUT-001 (records: flat-struct linear-memory; exportMemory option)
 * @decision DEC-AS-BACKEND-OPTIONS-001 (optional AsBackendOptions for per-factory asc flags)
 */
export function assemblyScriptBackend(opts?: AsBackendOptions): WasmBackend {
  const exportMemory = opts?.exportMemory ?? false;

  return {
    name: "as",
    async emit(resolution: ResolutionResult): Promise<Uint8Array<ArrayBuffer>> {
      const entryBlock = resolution.blocks.get(resolution.entry);
      if (entryBlock === undefined) {
        throw new Error(
          `assemblyScriptBackend: entry block not found in resolution (entry=${resolution.entry})`,
        );
      }

      const domain = inferDomainFromSource(entryBlock.source);
      const asSource = prepareAsSource(entryBlock.source, domain);

      // Create a unique temp directory for this compilation unit.
      // @decision DEC-AS-BACKEND-TMPDIR-001
      const workDir = join(tmpdir(), `yakcc-as-${randomUUID()}`);
      mkdirSync(workDir, { recursive: true });

      const srcPath = join(workDir, "atom.ts");
      const outPath = join(workDir, "atom.wasm");

      try {
        writeFileSync(srcPath, asSource, "utf8");

        // Invoke asc via Node (asc.js is a Node CLI script, not a native binary).
        // We find asc.js by resolving the assemblyscript package from this module's
        // require context. This works both in src/ (development) and dist/ (built).
        const ascJs = resolveAsc();
        const ascArgs = [
          ascJs,
          srcPath,
          "--outFile",
          outPath,
          "--optimize",
          "--runtime",
          "stub", // minimal AS runtime (no GC) — numeric + struct substrates
        ];

        // --noExportMemory: suppress memory export for pure numeric functions
        // (Phase 1 default). Omit when exportMemory is requested (Phase 2A
        // record substrates need to write struct bytes into WASM memory).
        // @decision DEC-AS-BACKEND-OPTIONS-001
        // @decision DEC-AS-RECORD-LAYOUT-001
        if (!exportMemory) {
          ascArgs.push("--noExportMemory");
        } else {
          // --initialMemory 1: guarantee ≥1 page (64 KiB) when memory is exported.
          // The AS stub runtime does not allocate memory pages by default; without
          // an initial page, DataView writes by the test harness throw RangeError.
          // 1 page (64 KiB) is sufficient for all Phase 2A record substrates
          // (struct pointers start at byte 64, struct data fits well within 64 KiB).
          // @decision DEC-AS-RECORD-LAYOUT-001
          ascArgs.push("--initialMemory", "1");
        }

        execFileSync(process.execPath, ascArgs, {
          // Capture stderr to include in errors; stdio: pipe prevents terminal noise.
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "buffer",
        });

        const wasmBytes = readFileSync(outPath);
        // Cast to the typed Uint8Array<ArrayBuffer> that WasmBackend.emit promises.
        return new Uint8Array(
          wasmBytes.buffer,
          wasmBytes.byteOffset,
          wasmBytes.byteLength,
        ) as Uint8Array<ArrayBuffer>;
      } catch (err: unknown) {
        // Enrich error with source context for debugging.
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `assemblyScriptBackend: asc compilation failed for entry=${resolution.entry}\n` +
            `domain: ${domain}\n` +
            `source:\n${asSource}\n` +
            `asc error:\n${msg}`,
        );
      } finally {
        // Always clean up the temp directory, even on error.
        rmSync(workDir, { recursive: true, force: true });
      }
    },
  };
}
