// @decision DEC-IR-FACADE-V0: The v0 IR exposes typed interfaces and opaque
// AST types with facade implementations that accept all input as valid.
// Status: provisional (WI-004 wires the real strict-TS-subset parser and validator)
// Rationale: Downstream packages need a stable API surface before the parser exists.
import type { ContractId } from "@yakcc/contracts";
export type BlockAst = { readonly __kind: "BlockAst"; readonly _raw: string };
export type { ContractId };
