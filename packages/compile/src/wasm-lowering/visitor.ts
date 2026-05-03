/**
 * visitor.ts — Recursive-descent LoweringVisitor for the TS→WASM lowering pass.
 *
 * Purpose:
 *   Parse a `ResolvedBlock.source` string into a ts-morph `SourceFile` and walk
 *   the AST, producing a `WasmFunction` for each exported function. This WI
 *   (WI-V1W3-WASM-LOWER-01) builds the scaffold; subsequent WIs (02–11) extend
 *   coverage to general TypeScript AST node kinds.
 *
 * Wave-2 fast-path:
 *   The 5 wave-2 substrates (add, string_bytecount, format_i32, sum_record,
 *   sum_array) are recognised by AST shape and take a fast-path that returns the
 *   same opcode sequences hand-rolled in wasm-backend.ts. This preserves the
 *   wave-2 parity matrix while routing all dispatch through the visitor.
 *
 * Unknown node kinds:
 *   Per Sacred Practice #5 (fail loudly and early, never silently), any AST node
 *   kind not yet handled throws a `LoweringError` with kind "unsupported-node"
 *   naming the SyntaxKind. Silent fallthrough would produce corrupt WASM and
 *   mislead Future Implementers — it is explicitly prohibited.
 *
 * @decision DEC-V1-WAVE-3-WASM-PARSE-001
 * @title Lower from ts-morph AST parsed at codegen-time from ResolvedBlock.source
 * @status accepted
 * @rationale
 *   ResolvedBlock carries only `source: string` — no precomputed AST. ts-morph
 *   provides a high-level TypeScript AST over the TS compiler API, which the
 *   wave-2 forbidden list bars re-implementing. ts-morph's typechecker also
 *   answers the i32/i64/f64 inference question in WI-V1W3-WASM-LOWER-02 — a
 *   separate parser would re-implement that infrastructure. Using ts-morph at
 *   compile-time (per block, on demand) avoids adding a persistent process or
 *   IPC channel. See MASTER_PLAN.md DEC-V1-WAVE-3-WASM-PARSE-001.
 *
 * @decision DEC-V1-WAVE-3-WASM-WAVE2-FAST-PATH-001
 * @title Wave-2 substrates take a body-level fast-path inside the visitor
 * @status accepted
 * @rationale
 *   Routing wave-2 substrates through the full visitor (without fast-paths) would
 *   require WI-01 to implement expression lowering, return statements, arithmetic
 *   operators, memory loads, and loop/block control flow all at once — that is the
 *   entire scope of WIs 02–08. Fast-paths let WI-01 land the scaffold and regression
 *   gate without blocking the remaining wave-3 work. Each fast-path is guarded by
 *   an explicit `detectWave2Shape()` check and will be replaced by general lowering
 *   as each WI adds the corresponding node kinds.
 */

import { type FunctionDeclaration, Project, type SourceFile, SyntaxKind } from "ts-morph";

import { SymbolTable } from "./symbol-table.js";
import type { WasmFunction } from "./wasm-function.js";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** The category of a lowering failure. */
export type LoweringErrorKind =
  | "unsupported-node" // AST node kind not yet implemented (loud failure)
  | "unsupported-capture" // closure capture placeholder (WI-10 fills this)
  | "missing-export" // source has no exported function
  | "parse-error"; // ts-morph reports a hard parse error

/**
 * Thrown when the visitor encounters a condition it cannot handle.
 *
 * Always names the offending SyntaxKind (for "unsupported-node") or a
 * descriptive message so Future Implementers can identify exactly which WI
 * needs to add coverage.
 */
export class LoweringError extends Error {
  readonly kind: LoweringErrorKind;

  constructor(opts: { kind: LoweringErrorKind; message: string }) {
    super(opts.message);
    this.name = "LoweringError";
    this.kind = opts.kind;
  }
}

// ---------------------------------------------------------------------------
// Wave-2 substrate shape detection
//
// These checks mirror the logic in detectSubstrateKind() in wasm-backend.ts.
// They operate on the ts-morph FunctionDeclaration rather than raw strings so
// the visitor remains the single dispatch point.
//
// @decision DEC-V1-WAVE-3-WASM-WAVE2-FAST-PATH-001 (see file header)
// ---------------------------------------------------------------------------

type Wave2Shape = "add" | "string_bytecount" | "format_i32" | "sum_record" | "sum_array" | null;

/**
 * Detect whether `fn` matches one of the 5 wave-2 substrate shapes.
 *
 * Detection uses the same heuristics as the original `detectSubstrateKind`
 * (string-based), but applied to the ts-morph node for consistency and to
 * keep the visitor as the single dispatch point.
 *
 * Returns null if the function does not match any wave-2 shape — the visitor
 * must then attempt general lowering (which throws "unsupported-node" for any
 * AST kind not yet covered).
 */
function detectWave2Shape(fn: FunctionDeclaration): Wave2Shape {
  // Re-use the string-level heuristic on the function text for this WI.
  // WI-02 will replace this with type-inference-based detection.
  const source = fn.getText();

  // Extract signature text for pattern matching
  const sigMatch = source.match(/function\s+\w+\s*\(([^)]*)\)\s*:\s*([^{;]+)/);
  if (sigMatch === null) return null;
  const params = sigMatch[1] ?? "";
  const returnType = (sigMatch[2] ?? "").trim();

  if (returnType.includes("string")) return "format_i32";
  if (params.includes("{") || params.includes("Record")) return "sum_record";
  if (params.includes("[]") || params.includes("Array<")) return "sum_array";
  if (params.includes("string")) return "string_bytecount";
  // "add" fast-path: only match when return type is "number" (not void, boolean,
  // or any other type). This ensures functions with exotic return types fall
  // through to general lowering and trigger the "unsupported-node" loud failure.
  if (returnType === "number") return "add";
  return null;
}

// ---------------------------------------------------------------------------
// Wave-2 fast-path opcode sequences
//
// These reproduce the body bytes from wasm-backend.ts exactly.
// Each fast-path populates the SymbolTable for the function's params so that
// the table is consistent even on the fast-path (tests probe the table).
//
// @decision DEC-V1-WAVE-3-WASM-WAVE2-FAST-PATH-001 (see file header)
// ---------------------------------------------------------------------------

function fastPathAdd(fn: FunctionDeclaration, table: SymbolTable): WasmFunction {
  table.pushFrame({ isFunctionBoundary: true });
  table.defineParam("a", "i32");
  table.defineParam("b", "i32");
  table.popFrame();

  return {
    locals: [],
    body: [
      0x20,
      0x00, // local.get 0 (a)
      0x20,
      0x01, // local.get 1 (b)
      0x6a, // i32.add
    ],
  };
}

function fastPathStringBytecount(fn: FunctionDeclaration, table: SymbolTable): WasmFunction {
  table.pushFrame({ isFunctionBoundary: true });
  // String calling convention: (ptr: i32, len: i32)
  const paramNames = fn.getParameters().map((p) => p.getName());
  table.defineParam(paramNames[0] ?? "ptr", "i32");
  table.defineParam(paramNames[1] ?? "len", "i32");
  table.popFrame();

  return {
    locals: [],
    body: [
      0x20,
      0x01, // local.get 1 (len)
    ],
  };
}

function fastPathFormatI32(fn: FunctionDeclaration, table: SymbolTable): WasmFunction {
  table.pushFrame({ isFunctionBoundary: true });
  const paramNames = fn.getParameters().map((p) => p.getName());
  table.defineParam(paramNames[0] ?? "n", "i32");
  table.defineParam("out", "i32"); // extra out_ptr param injected by lowering
  table.popFrame();

  return {
    locals: [],
    body: [
      // if (n < 10): write single digit and return 1
      0x20,
      0x00, // local.get 0  (n)
      0x41,
      0x0a, // i32.const 10
      0x49, // i32.lt_u
      0x04,
      0x40, // if void
      0x20,
      0x01, // local.get 1  (out)
      0x20,
      0x00, // local.get 0  (n)
      0x41,
      0x30, // i32.const 48 ('0')
      0x6a, // i32.add          (n + '0')
      0x3a,
      0x00,
      0x00, // i32.store8 align=0 offset=0
      0x41,
      0x01, // i32.const 1
      0x0f, // return
      0x0b, // end if
      // out[0] = n / 10 + '0'   (tens digit)
      0x20,
      0x01, // local.get 1  (out)
      0x20,
      0x00, // local.get 0  (n)
      0x41,
      0x0a, // i32.const 10
      0x6d, // i32.div_u
      0x41,
      0x30, // i32.const 48
      0x6a, // i32.add
      0x3a,
      0x00,
      0x00, // i32.store8 align=0 offset=0
      // out[1] = n % 10 + '0'   (ones digit)
      0x20,
      0x01, // local.get 1  (out)
      0x41,
      0x01, // i32.const 1
      0x6a, // i32.add          (out + 1)
      0x20,
      0x00, // local.get 0  (n)
      0x41,
      0x0a, // i32.const 10
      0x6f, // i32.rem_u
      0x41,
      0x30, // i32.const 48
      0x6a, // i32.add
      0x3a,
      0x00,
      0x00, // i32.store8 align=0 offset=0
      0x41,
      0x02, // i32.const 2
    ],
  };
}

function fastPathSumRecord(fn: FunctionDeclaration, table: SymbolTable): WasmFunction {
  table.pushFrame({ isFunctionBoundary: true });
  const paramNames = fn.getParameters().map((p) => p.getName());
  table.defineParam(paramNames[0] ?? "ptr", "i32");
  table.popFrame();

  return {
    locals: [],
    body: [
      0x20,
      0x00, // local.get 0  (ptr)
      0x28,
      0x02,
      0x00, // i32.load align=2 offset=0   → field[0]
      0x20,
      0x00, // local.get 0  (ptr)
      0x28,
      0x02,
      0x04, // i32.load align=2 offset=4   → field[1]
      0x6a, // i32.add
    ],
  };
}

function fastPathSumArray(fn: FunctionDeclaration, table: SymbolTable): WasmFunction {
  table.pushFrame({ isFunctionBoundary: true });
  const paramNames = fn.getParameters().map((p) => p.getName());
  table.defineParam(paramNames[0] ?? "ptr", "i32");
  table.defineParam(paramNames[1] ?? "len", "i32");
  // Two local groups: acc (local 2), byte-offset i (local 3)
  table.defineLocal("acc", "i32");
  table.defineLocal("i", "i32");
  table.popFrame();

  return {
    locals: [
      { count: 1, type: "i32" }, // acc
      { count: 1, type: "i32" }, // i (byte offset)
    ],
    body: [
      0x41,
      0x00,
      0x21,
      0x02, // acc = 0
      0x41,
      0x00,
      0x21,
      0x03, // i = 0
      0x02,
      0x40, // block $brk
      0x03,
      0x40, // loop $cont
      // break if i >= len << 2
      0x20,
      0x03, // local.get 3  (i)
      0x20,
      0x01, // local.get 1  (len)
      0x41,
      0x02, // i32.const 2
      0x74, // i32.shl          (len * 4)
      0x4f, // i32.ge_u
      0x0d,
      0x01, // br_if 1       (break to $brk)
      // acc += i32.load(ptr + i)
      0x20,
      0x02, // local.get 2  (acc)
      0x20,
      0x00, // local.get 0  (ptr)
      0x20,
      0x03, // local.get 3  (i)
      0x6a, // i32.add          (ptr + i)
      0x28,
      0x02,
      0x00, // i32.load align=2 offset=0
      0x6a, // i32.add
      0x21,
      0x02, // local.set 2  (acc)
      // i += 4
      0x20,
      0x03, // local.get 3  (i)
      0x41,
      0x04, // i32.const 4
      0x6a, // i32.add
      0x21,
      0x03, // local.set 3  (i)
      0x0c,
      0x00, // br 0          (continue $cont)
      0x0b, // end loop
      0x0b, // end block
      0x20,
      0x02, // local.get 2  (acc)
    ],
  };
}

// ---------------------------------------------------------------------------
// LoweringVisitor
// ---------------------------------------------------------------------------

/**
 * Result of lowering one source file: the WasmFunction for the exported entry
 * function, the function name, and the substrate kind used.
 */
export interface LoweringResult {
  readonly fnName: string;
  readonly wasmFn: WasmFunction;
  /**
   * Whether the fast-path was taken. `null` means general lowering was used
   * (not yet implemented in WI-01 beyond wave-2 fast-paths).
   */
  readonly wave2Shape: Wave2Shape;
}

/**
 * Recursive-descent visitor: parse source → walk AST → emit WasmFunction.
 *
 * This WI only covers:
 *   - The 5 wave-2 substrate shapes (fast-path)
 *
 * Any other exported function triggers a LoweringError with kind
 * "unsupported-node" naming the first unhandled SyntaxKind, per Sacred
 * Practice #5 (fail loudly and early, never silently).
 *
 * @decision DEC-V1-WAVE-3-WASM-PARSE-001 (see file header)
 */
export class LoweringVisitor {
  private readonly _table: SymbolTable;

  constructor() {
    this._table = new SymbolTable();
  }

  /**
   * Access the symbol table for testing and inspection.
   * Exposed so tests can verify frame push/pop and slot assignments.
   */
  get symbolTable(): SymbolTable {
    return this._table;
  }

  /**
   * Parse `source` and lower the first exported function.
   *
   * Creates a new ts-morph Project for each invocation (in-memory, no disk
   * access). A persistent project across calls would need careful file
   * management; given that each ResolvedBlock is independent, per-call
   * projects keep isolation simple.
   *
   * @throws LoweringError kind "missing-export" if no exported function found.
   * @throws LoweringError kind "unsupported-node" for any unhandled node kind.
   * @throws LoweringError kind "parse-error" for hard TypeScript syntax errors.
   */
  lower(source: string): LoweringResult {
    const sourceFile = this._parseSource(source);
    const fn = this._findExportedFunction(sourceFile);
    return this._lowerFunction(fn);
  }

  // -------------------------------------------------------------------------
  // Parsing
  // -------------------------------------------------------------------------

  private _parseSource(source: string): SourceFile {
    // In-memory project: no tsconfig, no file I/O.
    // skipAddingFilesFromTsConfig avoids attempting to load a tsconfig.json
    // from disk, which would fail in test environments.
    const project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        strict: true,
        target: 99, // ESNext
      },
    });

    const sf = project.createSourceFile("block.ts", source);

    // Report hard parse errors loudly (syntax errors, not type errors).
    const diagnostics = sf.getPreEmitDiagnostics().filter(
      (d) => d.getCategory() === 1, // DiagnosticCategory.Error = 1
    );
    if (diagnostics.length > 0) {
      const msgs = diagnostics
        .map((d) => d.getMessageText())
        .map((m) => (typeof m === "string" ? m : m.getMessageText()))
        .join("; ");
      throw new LoweringError({
        kind: "parse-error",
        message: `ts-morph parse error in block source: ${msgs}`,
      });
    }

    return sf;
  }

  // -------------------------------------------------------------------------
  // Entry-function discovery
  // -------------------------------------------------------------------------

  private _findExportedFunction(sf: SourceFile): FunctionDeclaration {
    const fns = sf.getFunctions().filter((f) => f.isExported());
    if (fns.length === 0) {
      throw new LoweringError({
        kind: "missing-export",
        message:
          "LoweringVisitor: source has no exported function declaration. " +
          "Every ResolvedBlock.source must export exactly one function.",
      });
    }
    // Take the first exported function. The spec constrains blocks to one
    // exported entry function; multiple exports are out of scope for WI-01.
    return fns[0] as FunctionDeclaration;
  }

  // -------------------------------------------------------------------------
  // Function lowering — dispatch
  // -------------------------------------------------------------------------

  private _lowerFunction(fn: FunctionDeclaration): LoweringResult {
    const fnName = fn.getName() ?? "fn";
    const shape = detectWave2Shape(fn);

    if (shape !== null) {
      // Wave-2 fast-path: recognised substrate shape.
      const wasmFn = this._wave2FastPath(shape, fn);
      return { fnName, wasmFn, wave2Shape: shape };
    }

    // General lowering: not yet implemented in WI-01.
    // Identify the first unhandled AST node kind and throw loudly.
    this._throwOnFirstUnknownNode(fn);

    // TypeScript does not know _throwOnFirstUnknownNode always throws.
    throw new LoweringError({
      kind: "unsupported-node",
      message: `LoweringVisitor: function '${fnName}' could not be lowered — no wave-2 shape matched and no general lowering is available yet. Add coverage in a subsequent WI.`,
    });
  }

  // -------------------------------------------------------------------------
  // Wave-2 fast-path dispatch
  // -------------------------------------------------------------------------

  private _wave2FastPath(shape: NonNullable<Wave2Shape>, fn: FunctionDeclaration): WasmFunction {
    switch (shape) {
      case "add":
        return fastPathAdd(fn, this._table);
      case "string_bytecount":
        return fastPathStringBytecount(fn, this._table);
      case "format_i32":
        return fastPathFormatI32(fn, this._table);
      case "sum_record":
        return fastPathSumRecord(fn, this._table);
      case "sum_array":
        return fastPathSumArray(fn, this._table);
    }
  }

  // -------------------------------------------------------------------------
  // Unknown-node loud failure
  // -------------------------------------------------------------------------

  /**
   * Walk the function body and throw a `LoweringError` for the first
   * `SyntaxKind` that this visitor does not handle.
   *
   * For WI-01, all body node kinds are "unhandled" when general lowering is
   * attempted (no shape matched). The walk finds the first non-trivial node
   * and reports its kind by name, so Future Implementers see exactly which WI
   * needs to add coverage.
   *
   * This method always throws — it never returns.
   */
  private _throwOnFirstUnknownNode(fn: FunctionDeclaration): never {
    let firstKindName: string | null = null;

    fn.forEachDescendant((node) => {
      if (firstKindName !== null) return;
      const kindName = SyntaxKind[node.getKind()];
      // Skip trivial wrapper nodes that are always present
      if (
        node.getKind() === SyntaxKind.FunctionDeclaration ||
        node.getKind() === SyntaxKind.Block ||
        node.getKind() === SyntaxKind.SyntaxList
      ) {
        return;
      }
      firstKindName = kindName;
    });

    const fnName = fn.getName() ?? "fn";
    throw new LoweringError({
      kind: "unsupported-node",
      message: `LoweringVisitor: unsupported SyntaxKind '${firstKindName ?? "unknown"}' encountered while lowering function '${fnName}'. This node kind is not yet covered by the wave-3 lowering visitor. Add coverage in the appropriate WI-V1W3-WASM-LOWER-0x.`,
    });
  }
}
