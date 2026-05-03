import type { WasmValType } from "./wasm-function.js";

/** A resolved slot in WASM local space. */
export interface LocalSlot {
  readonly name: string;
  /** 0-based WASM local index (params first, then extra locals in declaration order). */
  readonly localIndex: number;
  readonly wasmType: WasmValType;
  readonly isParam: boolean;
}

interface Frame {
  readonly bindings: Map<string, LocalSlot>;
}

/**
 * Lexical-scoped symbol table for the WASM lowering pass.
 *
 * Usage pattern per function:
 *   sym.pushFrame()
 *   for each param: sym.declareParam(...)
 *   // lower body, calling sym.declareLocal(...) for let/const bindings
 *   sym.popFrame()
 *
 * Lookup traverses frames from innermost to outermost (standard lexical scope).
 * Local indices are assigned sequentially in declaration order (params then extras),
 * matching the WASM spec requirement that params occupy the first N local indices.
 */
export class SymbolTable {
  private readonly frames: Frame[] = [];
  private readonly slots: LocalSlot[] = [];
  private _paramCount = 0;

  pushFrame(): void {
    this.frames.push({ bindings: new Map() });
  }

  popFrame(): void {
    if (this.frames.length === 0) {
      throw new Error("SymbolTable: popFrame called on empty frame stack");
    }
    this.frames.pop();
  }

  declareParam(name: string, wasmType: WasmValType): LocalSlot {
    const frame = this.frames[this.frames.length - 1];
    if (frame === undefined) {
      throw new Error("SymbolTable: declareParam called with no active frame");
    }
    const slot: LocalSlot = {
      name,
      localIndex: this.slots.length,
      wasmType,
      isParam: true,
    };
    this.slots.push(slot);
    this._paramCount++;
    frame.bindings.set(name, slot);
    return slot;
  }

  declareLocal(name: string, wasmType: WasmValType): LocalSlot {
    const frame = this.frames[this.frames.length - 1];
    if (frame === undefined) {
      throw new Error("SymbolTable: declareLocal called with no active frame");
    }
    const slot: LocalSlot = {
      name,
      localIndex: this.slots.length,
      wasmType,
      isParam: false,
    };
    this.slots.push(slot);
    frame.bindings.set(name, slot);
    return slot;
  }

  /** Search from innermost frame outward; returns undefined if not found. */
  lookup(name: string): LocalSlot | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const found = this.frames[i]!.bindings.get(name);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  getParamCount(): number {
    return this._paramCount;
  }

  /** Returns only the non-param locals, in declaration order. */
  getExtraLocals(): LocalSlot[] {
    return this.slots.filter((s) => !s.isParam);
  }

  getAllSlots(): LocalSlot[] {
    return [...this.slots];
  }
}
