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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlvmModule } from "./emit-llvm.js";
import { cachedObject, runtimeAtomsModule } from "./native-runtime-atoms.js";
import { systemModuleIr } from "./native-system.js";

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
  if (optimized !== undefined && options.llc === undefined) {
    const split = compileInParts(optimized, args);
    if (split !== undefined) return split;
  }
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

/** IR this large (its optimized bitcode's bytes) is compiled in parts at once (#1369). */
const SPLIT_AT = 1 << 21;
let splitAvailable: boolean | undefined;
/**
 * A large module's code generation, in parallel (#1369): the module optimized whole (so inlining
 * crosses its functions as before) is split into parts (`llvm-split`), each compiled by its own
 * `llc` at once, and the parts' objects joined into one relocatable object (`ld.lld -r`).
 * Undefined when the module is small or a tool is missing (the caller compiles it whole).
 */
function compileInParts(optimized: Buffer, llcArgs: readonly string[]): Uint8Array | undefined {
  if (optimized.length < SPLIT_AT || splitAvailable === false) return undefined;
  const n = Math.max(2, Math.min(8, availableParallelism()));
  const dir = mkdtempSync(join(tmpdir(), "yakcc-llc-"));
  try {
    writeFileSync(join(dir, "m.bc"), optimized);
    const split = spawnSync("llvm-split", ["-j", String(n), "-o", "part", "m.bc"], { cwd: dir });
    if (split.error !== undefined || split.status !== 0) {
      splitAvailable = false;
      return undefined;
    }
    const args = llcArgs.filter((a, i) => a !== "-o" && llcArgs[i - 1] !== "-o");
    const quote = (a: string): string => `'${a.replace(/'/g, "'\\''")}'`;
    const script = [
      ...Array.from(
        { length: n },
        (_, k) => `llc ${args.map(quote).join(" ")} -o part${k}.o part${k} &`,
      ),
      "wait",
      `for k in ${Array.from({ length: n }, (_, k) => k).join(" ")}; do test -s part$k.o || exit 1; done`,
    ].join("\n");
    const llc = spawnSync("sh", ["-c", script], { cwd: dir, maxBuffer: 1 << 26 });
    if (llc.status !== 0) throw new NativeToolError(`llc failed: ${llc.stderr.toString().trim()}`);
    const parts = Array.from({ length: n }, (_, k) => `part${k}.o`);
    const link = spawnSync("ld.lld", ["-r", "-o", "m.o", ...parts], { cwd: dir });
    if (link.error !== undefined || link.status !== 0) {
      splitAvailable = false;
      return undefined;
    }
    splitAvailable = true;
    return new Uint8Array(readFileSync(join(dir, "m.o")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  const target = [`--target=${triple}`, ...(CLANG_TARGET[triple] ?? [])];
  const clang = options.clang ?? "clang";
  // The atoms the runtime calls (V8's BigInt library), compiled once per target and cached.
  const atoms = runtimeAtomsModule();
  const atomsObject = cachedObject(atoms.ir, triple, () =>
    compileObject({ ir: atoms.ir, symbol: "", params: [], result: "i64" }, { target: triple }),
  );
  const dir = mkdtempSync(join(tmpdir(), "yakcc-rt-"));
  try {
    // The C, as bitcode; the system module (in LLVM: the system-call leaf, the entry) linked to it;
    // the one module compiled to the object.
    const tool = (cmd: string, args: readonly string[], what: string): void => {
      const run = spawnSync(cmd, args, { cwd: dir, maxBuffer: 1 << 26 });
      if (run.error !== undefined)
        throw new NativeToolError(`${cmd} could not be run (${run.error.message}): ${what}`);
      if (run.status !== 0)
        throw new NativeToolError(`${cmd} failed for ${triple}: ${run.stderr.toString().trim()}`);
    };
    const pic = triple.includes("windows") ? [] : ["-fPIC"];
    tool(
      clang,
      [
        ...target,
        ...(options.cflags ?? []),
        "-std=c11",
        "-O2",
        // Position-independent code is an ELF and Mach-O notion; a COFF target has no -fPIC (#1296).
        ...pic,
        `-DYK_V8_BIGINT_ENTRY=${atoms.entry}`,
        "-emit-llvm",
        "-c",
        RUNTIME_SOURCE,
        "-o",
        "yk.bc",
      ],
      "the runtime needs clang",
    );
    const noLibc = (options.cflags ?? []).includes("-DYK_NOLIBC");
    writeFileSync(join(dir, "system.ll"), systemModuleIr(triple, { noLibc }));
    tool("llvm-link", ["yk.bc", "system.ll", "-o", "rt.bc"], "the runtime needs LLVM's llvm-link");
    tool(clang, [...target, "-O2", ...pic, "-c", "rt.bc", "-o", "rt.o"], "the runtime needs clang");
    // And the atoms' object with it: one relocatable object.
    writeFileSync(join(dir, "atoms.o"), atomsObject);
    tool("ld.lld", ["-r", "rt.o", "atoms.o", "-o", "runtime.o"], "the runtime needs LLVM's ld.lld");
    return new Uint8Array(readFileSync(join(dir, "runtime.o")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
