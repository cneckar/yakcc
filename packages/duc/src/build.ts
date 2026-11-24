// SPDX-License-Identifier: Apache-2.0
/**
 * `yakcc build --native` (#1333): a program built into an executable. Its entry module and every
 * module it imports (the program record, `program.ts`) are lowered to one LLVM module
 * (`emitNativeModules`), compiled for the target by `llc`, linked with the runtime (compiled by
 * clang) and a generated `main`: the arguments in (`process.argv`), the entry module evaluated, the
 * jobs left run, and the exit code out (`process.exitCode`, 1 for an exception nothing catches).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { emitNativeModules } from "./emit-llvm-boxed.js";
import { NATIVE_TARGETS, NativeToolError, compileObject, compileRuntime } from "./native.js";
import { programRecord } from "./program.js";

export interface BuildOptions {
  /** The target (a key of NATIVE_TARGETS). Default: x86_64-linux. */
  readonly target?: string;
  /** The directory module ids are relative to. Default: the current directory. */
  readonly root?: string;
}

/** What a build made: the executable, and the program's modules. */
export interface BuildResult {
  readonly executable: string;
  readonly modules: readonly string[];
}

/** The generated main: argv in, the entry evaluated, the exit code out. */
function mainSource(entrySymbol: string): string {
  return [
    "#include <stdint.h>",
    "typedef uint64_t yk;",
    "void yk_main_begin(int, char **);",
    "int yk_main_end(void);",
    `extern yk ${entrySymbol}(void);`,
    "int main(int argc, char **argv) {",
    "  yk_main_begin(argc, argv);",
    `  ${entrySymbol}();`,
    "  return yk_main_end();",
    "}",
    "",
  ].join("\n");
}

/** The linker command for a target: the host's cc, or clang with the target's sysroot, static. */
function linker(target: string): { cc: string; flags: string[] } {
  if (target === "x86_64-linux") return { cc: "cc", flags: [] };
  const cross: Record<string, { triple: string; flags: string[] }> = {
    "aarch64-linux": { triple: "aarch64-linux-gnu", flags: [] },
    "arm-linux": {
      triple: "arm-linux-gnueabihf",
      flags: ["-march=armv7-a", "-mfloat-abi=hard", "-mfpu=vfpv3-d16"],
    },
    "riscv64-linux": { triple: "riscv64-linux-gnu", flags: ["-march=rv64gc", "-mabi=lp64d"] },
  };
  const c = cross[target];
  if (c === undefined)
    throw new NativeToolError(`building an executable for ${target} is not supported yet`);
  return {
    cc: "clang",
    flags: [
      `--target=${c.triple}`,
      "--sysroot=/",
      "-isystem",
      `/usr/${c.triple}/include`,
      ...c.flags,
      `-L/usr/${c.triple}/lib`,
      "-fuse-ld=lld",
      "-static",
    ],
  };
}

/** Build an entry module into an executable at `out`. */
export function buildProgram(entry: string, out: string, options: BuildOptions = {}): BuildResult {
  const target = options.target ?? "x86_64-linux";
  if (NATIVE_TARGETS[target] === undefined) throw new NativeToolError(`unknown target ${target}`);
  const program = programRecord(resolve(entry), options.root ?? process.cwd());
  const { ir, symbols } = emitNativeModules(program.modules);
  const entrySymbol = symbols[program.entry];
  if (entrySymbol === undefined) throw new NativeToolError("the entry module was not lowered");
  const { cc, flags } = linker(target);
  const work = mkdtempSync(join(tmpdir(), "yakcc-build-"));
  try {
    const cflags = flags.filter(
      (f) => f.startsWith("--sysroot") || f.startsWith("-isystem") || f.startsWith("/usr/"),
    );
    writeFileSync(
      join(work, "program.o"),
      compileObject({ ir, symbol: "", params: [], result: "i64" }, { target }),
    );
    writeFileSync(join(work, "yk.o"), compileRuntime({ target, cflags }));
    writeFileSync(join(work, "main.c"), mainSource(entrySymbol));
    mkdirSync(dirname(resolve(out)), { recursive: true });
    const link = spawnSync(
      cc,
      [...flags, "-O2", "main.c", "program.o", "yk.o", "-lm", "-o", resolve(out)],
      { cwd: work },
    );
    if (link.error !== undefined)
      throw new NativeToolError(`${cc} could not be run: ${link.error.message}`);
    if (link.status !== 0)
      throw new NativeToolError(`linking failed: ${link.stderr.toString().trim()}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { executable: resolve(out), modules: program.modules.map((m) => m.id) };
}
