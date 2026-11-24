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
import { fileURLToPath } from "node:url";
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
  /**
   * LLVM's IR optimizations (`opt -O2`) before code generation: values out of stack slots into
   * registers, inlining, folding. They keep IEEE semantics (the IR has no fast-math flags), so they
   * change no result. Default: on, when `opt` is on the PATH.
   */
  readonly optimize?: boolean;
}

let optAvailable: boolean | undefined;
/** The module's IR optimized by `opt -O2`, as bitcode; undefined when there is no `opt`. */
function optimizeIr(ir: string, triple: string): Buffer | undefined {
  if (optAvailable === false) return undefined;
  const run = spawnSync("opt", ["-O2", `-mtriple=${triple}`, "-o", "-"], {
    input: ir,
    maxBuffer: 1 << 28,
  });
  if (run.error !== undefined) {
    optAvailable = false;
    return undefined;
  }
  optAvailable = true;
  if (run.status !== 0) throw new NativeToolError(`opt failed: ${run.stderr.toString().trim()}`);
  return run.stdout;
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
  const optimized = options.optimize === false ? undefined : optimizeIr(m.ir, triple);
  const run = spawnSync(options.llc ?? "llc", args, {
    input: optimized ?? m.ir,
    maxBuffer: 1 << 26,
  });
  if (run.error !== undefined)
    throw new NativeToolError(
      `llc could not be run (${run.error.message}): the native lowering needs LLVM's llc`,
    );
  if (run.status !== 0)
    throw new NativeToolError(`llc failed for ${triple}: ${run.stderr.toString().trim()}`);
  return new Uint8Array(run.stdout);
}

/** The runtime's C source (DEC-DUC-NATIVE-RUNTIME-001), shipped with the package. */
export const RUNTIME_SOURCE = fileURLToPath(new URL("../runtime/yk.c", import.meta.url));

/** The clang arguments that compile C for a target as `llc` compiles the lowering for it. */
const CLANG_TARGET: Readonly<Record<string, readonly string[]>> = {
  "armv7-unknown-linux-gnueabihf": ["-march=armv7-a", "-mfloat-abi=hard", "-mfpu=vfpv3-d16"],
  "riscv64-unknown-linux-gnu": ["-march=rv64gc", "-mabi=lp64d"],
};

/**
 * The runtime compiled to a relocatable object for the target, by clang: LLVM's own C compiler, so
 * the boxed lowering and its runtime come from one toolchain. `cflags` adds the target's include
 * flags (a sysroot) where the host's are not the target's.
 */
export function compileRuntime(
  options: {
    readonly target?: string;
    readonly clang?: string;
    readonly cflags?: readonly string[];
  } = {},
): Uint8Array {
  const triple = NATIVE_TARGETS[options.target ?? "x86_64-linux"] ?? (options.target as string);
  const args = [
    `--target=${triple}`,
    ...(CLANG_TARGET[triple] ?? []),
    ...(options.cflags ?? []),
    "-std=c11",
    "-O2",
    // Position-independent code is an ELF and Mach-O notion; a COFF target has no -fPIC (#1296).
    ...(triple.includes("windows") ? [] : ["-fPIC"]),
    "-c",
    RUNTIME_SOURCE,
    "-o",
    "-",
  ];
  const run = spawnSync(options.clang ?? "clang", args, { maxBuffer: 1 << 26 });
  if (run.error !== undefined)
    throw new NativeToolError(
      `clang could not be run (${run.error.message}): the runtime needs it`,
    );
  if (run.status !== 0)
    throw new NativeToolError(`clang failed for ${triple}: ${run.stderr.toString().trim()}`);
  return new Uint8Array(run.stdout);
}
