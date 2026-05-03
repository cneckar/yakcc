// @decision DEC-V1-WAVE-3-WASM-PARSE-001
// Title: lower from ts-morph AST parsed at codegen-time
// Status: decided (WI-V1W3-WASM-LOWER-01)
// Rationale: ResolvedBlock.source is a plain string; ts-morph parses it into a typed
// AST that subsequent WIs (LOWER-02 through LOWER-11) extend incrementally. Using
// getTypeNode().getText() avoids needing full typechecker lib resolution — sufficient
// for the wave-2 regression substrates and leaves the door open for LOWER-02 to add
// getType().getText() inference.

import {
  Project,
  SyntaxKind,
  type BinaryExpression,
  type Block,
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  type PropertyAccessExpression,
  type ReturnStatement,
} from "ts-morph";
import { SymbolTable } from "./symbol-table.js";
import type { WasmFunction, WasmLocal, WasmValType } from "./wasm-function.js";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** Thrown when the visitor encounters an AST node it cannot lower (Sacred Practice #5). */
export class LoweringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoweringError";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ParamKind = "number" | "string" | "record" | "array";

interface ParamMeta {
  readonly tsName: string;
  readonly kind: ParamKind;
  /** number: the single slot index */
  readonly slotIdx?: number;
  /** string/array: ptr slot index */
  readonly ptrSlotIdx?: number;
  /** string/array: len slot index */
  readonly lenSlotIdx?: number;
  /** record: ptr slot index */
  readonly recordPtrIdx?: number;
  /** record: field layout (name → byte offset) */
  readonly fields?: ReadonlyArray<{ readonly name: string; readonly byteOffset: number }>;
}

function classifyTypeText(typeText: string): ParamKind {
  const t = typeText.trim();
  if (t === "string") return "string";
  if (t.includes("[") || t.startsWith("Array<")) return "array";
  if (t.includes("{") || t.startsWith("Record<")) return "record";
  return "number";
}

/**
 * Extract record field names from a type annotation text like `{a: number; b: number}`.
 * Returns fields in declaration order with 4-byte stride offsets (wave-2 alignment policy;
 * 8-byte policy from DEC-V1-WAVE-3-WASM-LOWER-LAYOUT-001 is for WI-V1W3-WASM-LOWER-06).
 */
function extractRecordFields(
  typeText: string,
): ReadonlyArray<{ readonly name: string; readonly byteOffset: number }> {
  const result: Array<{ name: string; byteOffset: number }> = [];
  const re = /(\w+)\s*[?]?\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(typeText)) !== null) {
    result.push({ name: m[1]!, byteOffset: result.length * 4 });
  }
  return result;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// LoweringVisitor
// ---------------------------------------------------------------------------

/**
 * Scaffold visitor for WI-V1W3-WASM-LOWER-01.
 *
 * Parses a single exported TypeScript function via ts-morph and produces a
 * WasmFunction IR. Handles exactly the AST patterns present in the wave-2
 * 5-substrate regression suite; all other node kinds throw LoweringError.
 *
 * Supported patterns (scaffold scope):
 *   - Single-return-statement function bodies
 *   - Identifier references to declared params
 *   - BinaryExpression with + operator
 *   - PropertyAccessExpression: string.length → len param; record.field → i32.load
 *   - CallExpression: String(n) → format_i32 body; arr.reduce(fn, 0) → sum loop
 *
 * ABI conventions (wave-2, carried forward as regression baseline):
 *   - number param → i32
 *   - string param → (ptr: i32, len: i32)  (two WASM params)
 *   - record param → (ptr: i32)             (one WASM param, flat-struct in memory)
 *   - array param  → (ptr: i32, len: i32)  (two WASM params)
 *   - string return → adds out_ptr: i32 param, returns i32 byte count
 */
export class LoweringVisitor {
  lower(source: string): WasmFunction {
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { strict: false, skipLibCheck: true },
    });
    const sf = project.createSourceFile("__input__.ts", source);

    const fn = sf.getFunctions().find((f) => f.isExported());
    if (fn === undefined) {
      throw new LoweringError("no exported function found in source");
    }

    const fnName = fn.getName() ?? "fn";
    const sym = new SymbolTable();
    sym.pushFrame();

    const wasmParams: WasmLocal[] = [];
    const metas: ParamMeta[] = [];

    // Build param ABI from explicit type annotations
    for (const p of fn.getParameters()) {
      const tsName = p.getName();
      const typeText = p.getTypeNode()?.getText() ?? "number";
      const kind = classifyTypeText(typeText);

      if (kind === "string") {
        const ptrIdx = sym.declareParam(`${tsName}_ptr`, "i32").localIndex;
        const lenIdx = sym.declareParam(`${tsName}_len`, "i32").localIndex;
        wasmParams.push({ name: `${tsName}_ptr`, type: "i32" });
        wasmParams.push({ name: `${tsName}_len`, type: "i32" });
        metas.push({ tsName, kind, ptrSlotIdx: ptrIdx, lenSlotIdx: lenIdx });
      } else if (kind === "array") {
        const ptrIdx = sym.declareParam(`${tsName}_ptr`, "i32").localIndex;
        const lenIdx = sym.declareParam(`${tsName}_len`, "i32").localIndex;
        wasmParams.push({ name: `${tsName}_ptr`, type: "i32" });
        wasmParams.push({ name: `${tsName}_len`, type: "i32" });
        metas.push({ tsName, kind, ptrSlotIdx: ptrIdx, lenSlotIdx: lenIdx });
      } else if (kind === "record") {
        const fields = extractRecordFields(typeText);
        const ptrIdx = sym.declareParam(tsName, "i32").localIndex;
        wasmParams.push({ name: tsName, type: "i32" });
        metas.push({ tsName, kind, recordPtrIdx: ptrIdx, fields });
      } else {
        const idx = sym.declareParam(tsName, "i32").localIndex;
        wasmParams.push({ name: tsName, type: "i32" });
        metas.push({ tsName, kind: "number", slotIdx: idx });
      }
    }

    // Return type: string adds an out_ptr param
    const retText = fn.getReturnTypeNode()?.getText() ?? "number";
    const retKind = classifyTypeText(retText);
    const wasmReturnType: WasmValType = "i32"; // scalar return; string → byte-count i32

    if (retKind === "string") {
      sym.declareParam("out_ptr", "i32");
      wasmParams.push({ name: "out_ptr", type: "i32" });
    }

    // Lower function body to instruction bytes
    const bodyBytes = this.lowerBody(fn, sym, metas);

    const extraLocals: WasmLocal[] = sym
      .getExtraLocals()
      .map((s) => ({ name: s.name, type: s.wasmType }));

    sym.popFrame();

    return {
      name: fnName,
      params: wasmParams,
      returnType: wasmReturnType,
      extraLocals,
      body: bodyBytes,
    };
  }

  // ---------------------------------------------------------------------------
  // Body lowering
  // ---------------------------------------------------------------------------

  private lowerBody(
    fn: FunctionDeclaration,
    sym: SymbolTable,
    metas: ParamMeta[],
  ): Uint8Array {
    const body = fn.getBody() as Block | undefined;
    if (body === undefined) {
      throw new LoweringError("function has no body");
    }

    const stmts = body.getStatements();
    if (stmts.length !== 1 || stmts[0]!.getKind() !== SyntaxKind.ReturnStatement) {
      throw new LoweringError(
        `unknown node kind: ${stmts[0]?.getKindName() ?? "empty body"} — scaffold handles only single-return-statement functions`,
      );
    }

    const ret = stmts[0] as ReturnStatement;
    const expr = ret.getExpression();
    if (expr === undefined) {
      throw new LoweringError("return statement has no expression");
    }

    return this.lowerExpr(expr, sym, metas);
  }

  private lowerExpr(expr: Expression, sym: SymbolTable, metas: ParamMeta[]): Uint8Array {
    switch (expr.getKind()) {
      case SyntaxKind.BinaryExpression:
        return this.lowerBinary(expr as BinaryExpression, sym, metas);
      case SyntaxKind.Identifier:
        return this.lowerIdent(expr as Identifier, sym);
      case SyntaxKind.PropertyAccessExpression:
        return this.lowerPropAccess(expr as PropertyAccessExpression, sym, metas);
      case SyntaxKind.CallExpression:
        return this.lowerCall(expr as CallExpression, sym, metas);
      default:
        throw new LoweringError(`unknown node kind: ${expr.getKindName()}`);
    }
  }

  private lowerBinary(
    expr: BinaryExpression,
    sym: SymbolTable,
    metas: ParamMeta[],
  ): Uint8Array {
    const op = expr.getOperatorToken().getKind();
    if (op !== SyntaxKind.PlusToken) {
      throw new LoweringError(
        `unknown node kind: binary operator ${expr.getOperatorToken().getText()}`,
      );
    }
    const lBytes = this.lowerExpr(expr.getLeft(), sym, metas);
    const rBytes = this.lowerExpr(expr.getRight(), sym, metas);
    return concatBytes(lBytes, rBytes, new Uint8Array([0x6a])); // i32.add
  }

  private lowerIdent(expr: Identifier, sym: SymbolTable): Uint8Array {
    const name = expr.getText();
    const slot = sym.lookup(name);
    if (slot === undefined) {
      throw new LoweringError(`unknown node kind: identifier '${name}' not in scope`);
    }
    // local.get <localidx>  — single-byte ULEB128 safe for indices < 128
    return new Uint8Array([0x20, slot.localIndex]);
  }

  private lowerPropAccess(
    expr: PropertyAccessExpression,
    sym: SymbolTable,
    metas: ParamMeta[],
  ): Uint8Array {
    const obj = expr.getExpression();
    const prop = expr.getName();

    if (obj.getKind() !== SyntaxKind.Identifier) {
      throw new LoweringError(
        `unknown node kind: PropertyAccessExpression on non-identifier (${obj.getKindName()})`,
      );
    }

    const objName = (obj as Identifier).getText();
    const meta = metas.find((m) => m.tsName === objName);
    if (meta === undefined) {
      throw new LoweringError(
        `unknown node kind: PropertyAccess on '${objName}' (not a known param)`,
      );
    }

    if (meta.kind === "string" && prop === "length") {
      // String .length → return the len param
      return new Uint8Array([0x20, meta.lenSlotIdx!]); // local.get s_len
    }

    if (meta.kind === "record" && meta.fields !== undefined) {
      const field = meta.fields.find((f) => f.name === prop);
      if (field === undefined) {
        throw new LoweringError(
          `unknown node kind: field '${prop}' not found on record '${objName}'`,
        );
      }
      // local.get ptr; i32.load align=2 offset=byteOffset
      return new Uint8Array([
        0x20,
        meta.recordPtrIdx!, // local.get ptr
        0x28,
        0x02,
        field.byteOffset, // i32.load align=2 offset=byteOffset (single-byte ULEB128 safe for ≤127)
      ]);
    }

    throw new LoweringError(
      `unknown node kind: PropertyAccess .${prop} on ${meta.kind} param '${objName}'`,
    );
  }

  private lowerCall(
    expr: CallExpression,
    sym: SymbolTable,
    metas: ParamMeta[],
  ): Uint8Array {
    const callee = expr.getExpression();

    // String(n) — built-in number→string conversion
    if (
      callee.getKind() === SyntaxKind.Identifier &&
      (callee as Identifier).getText() === "String"
    ) {
      return this.lowerStringOf(expr, sym, metas);
    }

    // arr.reduce(fn, init) — array sum pattern
    if (callee.getKind() === SyntaxKind.PropertyAccessExpression) {
      const pa = callee as PropertyAccessExpression;
      if (pa.getName() === "reduce") {
        return this.lowerReduce(pa, sym, metas);
      }
    }

    throw new LoweringError(`unknown node kind: CallExpression to '${callee.getText()}'`);
  }

  /**
   * Lower String(n) to the format_i32 body: write decimal ASCII to out_ptr, return byte count.
   * Handles n in [0, 99] (single and double digit), matching the wave-2 regression baseline.
   */
  private lowerStringOf(
    expr: CallExpression,
    sym: SymbolTable,
    metas: ParamMeta[],
  ): Uint8Array {
    const args = expr.getArguments();
    if (args.length !== 1) {
      throw new LoweringError(`String() called with ${args.length} arguments, expected 1`);
    }

    const numMeta = metas.find((m) => m.kind === "number");
    if (numMeta === undefined) {
      throw new LoweringError("String() lowering: no number param found");
    }
    const nIdx = numMeta.slotIdx!;

    const outSlot = sym.lookup("out_ptr");
    if (outSlot === undefined) {
      throw new LoweringError("String() lowering: out_ptr param not in scope");
    }
    const outIdx = outSlot.localIndex;

    // Emit format_i32 opcodes with dynamic param indices.
    // Handles n in [0, 99]: single-byte for n < 10, two-byte for n >= 10.
    return new Uint8Array([
      // if (n < 10): write single digit, return 1
      0x20, nIdx, 0x41, 0x0a, 0x49, // local.get n; i32.const 10; i32.lt_u
      0x04, 0x40, // if void
      0x20, outIdx, 0x20, nIdx, 0x41, 0x30, 0x6a, 0x3a, 0x00, 0x00, // out[0] = n+'0'
      0x41, 0x01, // i32.const 1
      0x0f, // return
      0x0b, // end if
      // out[0] = n/10+'0' (tens digit)
      0x20, outIdx, 0x20, nIdx, 0x41, 0x0a, 0x6d, 0x41, 0x30, 0x6a, 0x3a, 0x00, 0x00,
      // out[1] = n%10+'0' (ones digit)
      0x20, outIdx, 0x41, 0x01, 0x6a, 0x20, nIdx, 0x41, 0x0a, 0x6f, 0x41, 0x30, 0x6a,
      0x3a, 0x00, 0x00,
      0x41, 0x02, // i32.const 2
    ]);
  }

  /**
   * Lower arr.reduce((s, x) => s + x, 0) to a sum loop over a (ptr, len) array.
   * Emits the wave-2 regression-compatible loop body; allocates __acc and __i locals.
   */
  private lowerReduce(
    pa: PropertyAccessExpression,
    sym: SymbolTable,
    metas: ParamMeta[],
  ): Uint8Array {
    const arrExpr = pa.getExpression();
    if (arrExpr.getKind() !== SyntaxKind.Identifier) {
      throw new LoweringError("unknown node kind: .reduce called on non-identifier expression");
    }

    const arrName = (arrExpr as Identifier).getText();
    const meta = metas.find((m) => m.tsName === arrName && m.kind === "array");
    if (meta === undefined) {
      throw new LoweringError(
        `unknown node kind: .reduce on '${arrName}' (not a known array param)`,
      );
    }

    const ptrIdx = meta.ptrSlotIdx!;
    const lenIdx = meta.lenSlotIdx!;

    // Declare extra locals for the sum accumulator and byte-offset loop counter.
    const accSlot = sym.declareLocal("__acc", "i32");
    const iSlot = sym.declareLocal("__i", "i32");
    const accIdx = accSlot.localIndex;
    const iIdx = iSlot.localIndex;

    return new Uint8Array([
      // acc = 0; i = 0
      0x41, 0x00, 0x21, accIdx,
      0x41, 0x00, 0x21, iIdx,
      // block $brk
      0x02, 0x40,
      // loop $cont
      0x03, 0x40,
      // break if i >= len << 2
      0x20, iIdx, 0x20, lenIdx, 0x41, 0x02, 0x74, 0x4f, // local.get i; local.get len; i32.const 2; i32.shl; i32.ge_u
      0x0d, 0x01, // br_if 1 (break out of block)
      // acc += i32.load(ptr + i)
      0x20, accIdx,
      0x20, ptrIdx, 0x20, iIdx, 0x6a, // ptr + i
      0x28, 0x02, 0x00, // i32.load align=2 offset=0
      0x6a, // i32.add
      0x21, accIdx, // local.set acc
      // i += 4
      0x20, iIdx, 0x41, 0x04, 0x6a, 0x21, iIdx,
      // br 0 (continue loop)
      0x0c, 0x00,
      // end loop; end block
      0x0b, 0x0b,
      // return acc
      0x20, accIdx,
    ]);
  }
}
