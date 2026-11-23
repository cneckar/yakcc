// SPDX-License-Identifier: Apache-2.0
/**
 * Native object files from a graph (#1292): the LLVM lowering (emit-llvm.ts) handed to LLVM's own
 * backend, `llc`, which writes the relocatable object a compiler writes, for the target triple asked:
 * ELF, Mach-O or COFF; x86-64, AArch64, ARM, RISC-V. Any stock linker takes it (GNU ld, lld, the
 * system `cc` driver), as it takes a C compiler's.
 *
 * `llc` is a tool on the machine, not a dependency of this package: when it is missing, the error
 * says so. The same module and triple give byte-identical objects.
 */
import { spawnSync } from "node:child_process";
import type { LlvmModule } from "./emit-llvm.js";

export class NativeToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeToolError";
  }
}

/** Common targets, by name: the LLVM triple for each. */
export const NATIVE_TARGETS: Readonly<Record<string, string>> = {
  "x86_64-linux": "x86_64-unknown-linux-gnu",
  "aarch64-linux": "aarch64-unknown-linux-gnu",
  "arm-linux": "armv7-unknown-linux-gnueabihf",
  "riscv64-linux": "riscv64-unknown-linux-gnu",
  "x86_64-macos": "x86_64-apple-macosx11.0.0",
  "aarch64-macos": "arm64-apple-macosx11.0.0",
  "x86_64-windows": "x86_64-pc-windows-msvc",
  "aarch64-windows": "aarch64-pc-windows-msvc",
};

export interface ObjectOptions {
  /** The LLVM target triple (a key of NATIVE_TARGETS, or a triple). Default: x86_64-linux. */
  readonly target?: string;
  /** The `llc` to run. Default: `llc` on the PATH. */
  readonly llc?: string;
  /** Extra target attributes (`-mattr`), e.g. `+d` for RISC-V's double-precision floats. */
  readonly attributes?: string;
}

/** The default attributes a target needs for this subset: a hardware double. */
const ATTRIBUTES: Readonly<Record<string, string>> = {
  "riscv64-unknown-linux-gnu": "+m,+a,+f,+d,+c",
};
const ABI: Readonly<Record<string, string>> = {
  "riscv64-unknown-linux-gnu": "lp64d",
};

/** The module compiled to a relocatable object file for the target. */
export function compileObject(m: LlvmModule, options: ObjectOptions = {}): Uint8Array {
  const triple = NATIVE_TARGETS[options.target ?? "x86_64-linux"] ?? (options.target as string);
  const attributes = options.attributes ?? ATTRIBUTES[triple];
  const args = [
    "-filetype=obj",
    "-O2",
    `-mtriple=${triple}`,
    "-relocation-model=pic",
    ...(attributes !== undefined ? [`-mattr=${attributes}`] : []),
    ...(ABI[triple] !== undefined ? [`-target-abi=${ABI[triple]}`] : []),
    "-o",
    "-",
  ];
  const run = spawnSync(options.llc ?? "llc", args, { input: m.ir, maxBuffer: 1 << 26 });
  if (run.error !== undefined)
    throw new NativeToolError(
      `llc could not be run (${run.error.message}): the native lowering needs LLVM's llc`,
    );
  if (run.status !== 0)
    throw new NativeToolError(`llc failed for ${triple}: ${run.stderr.toString().trim()}`);
  return new Uint8Array(run.stdout);
}
