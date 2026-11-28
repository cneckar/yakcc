// SPDX-License-Identifier: Apache-2.0
/**
 * The atoms the native runtime calls (#1516): V8's BigInt library (`atoms/v8-bigint.ts`, shaved
 * from V8 12.4's src/bigint, with musl's memcpy, memset, memmove and abort), lowered as one module
 * whose exports are its functions. The runtime evaluates the module once and calls its functions
 * by name, where it has replaced its own code with V8's.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { V8_BIGINT_ATOM_SOURCES, V8_BIGINT_STATICS } from "./atoms/v8-bigint.js";
import { emitNativeModules } from "./emit-llvm-boxed.js";
import { liftAtom } from "./lift.js";
import { withStatics } from "./native-statics.js";

/** The module's id; its entry is the symbol the runtime calls (`YK_V8_BIGINT_ENTRY`). */
const ID = "yk_v8_bigint.js";

let memo: { ir: string; entry: string } | undefined;
/** The atoms' module: its LLVM IR and its entry's symbol. */
export function runtimeAtomsModule(): { ir: string; entry: string } {
  if (memo !== undefined) return memo;
  const names = Object.keys(V8_BIGINT_ATOM_SOURCES);
  const statements = [
    ...names.map((n) => ({
      kind: "function" as const,
      declares: [n],
      graph: liftAtom((V8_BIGINT_ATOM_SOURCES[n] as { source: string }).source),
    })),
    {
      kind: "statement" as const,
      declares: [],
      graph: liftAtom(`module.exports = { ${names.join(", ")} };`),
    },
  ];
  const { ir, symbols } = emitNativeModules(
    withStatics([{ id: ID, statements }], new Map(Object.entries(V8_BIGINT_STATICS))),
  );
  // Its own symbols (a module's are m0_s0, m0.init, …, as every program's are): prefixed.
  memo = { ir: ir.replace(/@("?)m(\d+)([._])/g, "@$1ykv8.m$2$3"), entry: symbols[ID] as string };
  return memo;
}

/**
 * An object compiled from IR for a target, cached on disk by the IR's and the target's hash: the
 * atoms' module takes minutes to compile, and is the same for every program.
 */
export function cachedObject(ir: string, triple: string, compile: () => Uint8Array): Uint8Array {
  const dir = join(tmpdir(), "yakcc-native-cache");
  const key = createHash("sha256").update(triple).update("\0").update(ir).digest("hex");
  const path = join(dir, `${key}.o`);
  if (existsSync(path)) return new Uint8Array(readFileSync(path));
  const obj = compile();
  mkdirSync(dir, { recursive: true });
  const part = `${path}.${process.pid}.part`;
  writeFileSync(part, obj);
  renameSync(part, path);
  return obj;
}
