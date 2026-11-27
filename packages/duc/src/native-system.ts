// SPDX-License-Identifier: Apache-2.0
/**
 * The system natively, in LLVM (#1516, #1365 layer 0): the system-call leaf, the thread pointer, the
 * system call itself (`yk_sys`, which the C library's stand-in calls) and the process's entry
 * (`_start`, with no C library), per target. No runtime code for them: this module is linked into the
 * runtime's object (`compileRuntime`).
 *
 * The system-call leaf (`__yk_syscall`) is Linux's x86-64 numbering, as musl raised for x86-64 makes
 * its calls; on another Linux target each call is that target's of the same name. Memory is the
 * machine's, so a call's pointers are its own. Three calls differ from the kernel's: brk is refused
 * (0: the C library's allocator owns the break, so malloc maps), exit and exit_group are the C
 * library's exit (its buffers written), and write and writev write the C library's buffered output
 * first, so a program's output and the runtime's keep their order. A call with no number on the
 * target is -ENOSYS.
 */
import { leafDefinitions } from "./native-leaves.js";

/** Each Linux target's numbers of the x86-64 calls musl makes. */
const GENERIC: Readonly<Record<number, number>> = {
  0: 63, // read
  1: 64, // write
  3: 57, // close
  8: 62, // lseek
  9: 222, // mmap
  11: 215, // munmap
  14: 135, // rt_sigprocmask
  16: 29, // ioctl
  20: 66, // writev
  25: 216, // mremap
  28: 233, // madvise
  39: 172, // getpid
  186: 178, // gettid
  228: 113, // clock_gettime
};
const ARM: Readonly<Record<number, number>> = {
  0: 3,
  1: 4,
  3: 6,
  8: 19,
  9: 192, // mmap2: its offset in pages
  11: 91,
  14: 175,
  16: 54,
  20: 146,
  25: 163,
  28: 220,
  39: 20,
  186: 224,
  228: 403, // clock_gettime64: x86-64's timespec, two 64-bit words
};
const X86_64: Readonly<Record<number, number>> = Object.fromEntries(
  Object.keys(GENERIC).map((k) => [Number(k), Number(k)]),
);

type Arch = "x86_64" | "aarch64" | "arm" | "riscv64" | "other";
function archOf(triple: string): Arch {
  if (!triple.includes("linux")) return "other";
  if (triple.startsWith("x86_64")) return "x86_64";
  if (triple.startsWith("aarch64")) return "aarch64";
  if (triple.startsWith("arm")) return "arm";
  if (triple.startsWith("riscv64")) return "riscv64";
  return "other";
}

/** The system call's instruction and its registers, per architecture. */
function sysBody(arch: Arch, long: string): string[] {
  const args = `${long} %n, ${long} %a, ${long} %b, ${long} %c, ${long} %d, ${long} %e, ${long} %f`;
  const asm: Record<Exclude<Arch, "other">, [string, string]> = {
    x86_64: ["syscall", "={rax},{rax},{rdi},{rsi},{rdx},{r10},{r8},{r9},~{rcx},~{r11},~{memory}"],
    aarch64: ["svc 0", "={x0},{x8},{x0},{x1},{x2},{x3},{x4},{x5},~{memory},~{cc}"],
    arm: ["svc 0", "={r0},{r7},{r0},{r1},{r2},{r3},{r4},{r5},~{memory},~{cc}"],
    riscv64: ["ecall", "={x10},{x17},{x10},{x11},{x12},{x13},{x14},{x15},~{memory}"],
  };
  if (arch === "other") return [`  ret ${long} -38`];
  const [insn, cons] = asm[arch];
  return [`  %r = call ${long} asm sideeffect "${insn}", "${cons}"(${args})`, `  ret ${long} %r`];
}

/** The process's entry with no C library: the initial stack to yk_nolibc_start, aligned. */
const START: Readonly<Record<Exclude<Arch, "other">, string[]>> = {
  x86_64: [
    ".text",
    ".globl _start",
    ".type _start,@function",
    "_start:",
    "  xor %ebp, %ebp",
    "  mov %rsp, %rdi",
    "  and $-16, %rsp",
    "  call yk_nolibc_start",
    "  hlt",
  ],
  aarch64: [
    ".text",
    ".globl _start",
    ".type _start,%function",
    "_start:",
    "  mov x29, #0",
    "  mov x30, #0",
    "  mov x0, sp",
    "  and sp, x0, #-16",
    "  bl yk_nolibc_start",
  ],
  arm: [
    ".text",
    ".syntax unified",
    ".arm",
    ".globl _start",
    ".type _start,%function",
    "_start:",
    "  mov fp, #0",
    "  mov lr, #0",
    "  mov r0, sp",
    "  bic sp, sp, #15",
    "  bl yk_nolibc_start",
  ],
  riscv64: [
    ".text",
    ".globl _start",
    ".type _start,@function",
    "_start:",
    "  .option push",
    "  .option norelax",
    "  lla gp, __global_pointer$",
    "  .option pop",
    "  mv a0, sp",
    "  andi sp, sp, -16",
    "  call yk_nolibc_start",
  ],
};

/** The runtime's functions the system module calls, as the runtime defines them. */
const RUNTIME: Readonly<Record<string, string>> = {
  yk_bigint_word: "declare i64 @yk_bigint_word(i64, i32)",
  yk_bigint_from_i128: "declare i64 @yk_bigint_from_i128(i64, i64)",
  yk_global: "declare i64 @yk_global(ptr, i64)",
  yk_string_utf8: "declare i64 @yk_string_utf8(ptr, i64)",
  yk_add: "declare i64 @yk_add(i64, i64)",
  yk_new: "declare i64 @yk_new(i64, i64, ptr)",
  yk_throw: "declare void @yk_throw(i64) noreturn",
};

/**
 * The system module for a target triple: `yk_leaf_syscall`, `yk_leaf_tp`, the allocator's entry the
 * leaves call (`yk_mem_alloc`, `yk_mem_free`: the C library's, with its size type), `yk_sys`, and
 * with no C library `_start`.
 */
export function systemModuleIr(triple: string, options: { noLibc?: boolean } = {}): string {
  const arch = archOf(triple);
  const bits32 = arch === "arm" || /^(armv|arm-|thumb|i[3-6]86)/.test(triple);
  const long = bits32 ? "i32" : "i64";
  const numbers =
    arch === "x86_64" ? X86_64 : arch === "arm" ? ARM : arch === "other" ? {} : GENERIC;
  const used = new Set<string>(["yk_big_low64"]);
  const decls = new Set<string>();
  const helpers = leafDefinitions(used, decls);
  used.add("yk_bigint_from_i128");
  const out: string[] = [
    "; yakcc native system module (#1516): the system-call leaf, the thread pointer, the entry",
    `target triple = "${triple}"`,
    "",
  ];
  if (options.noLibc === true && arch !== "other")
    out.push(
      ...START[arch].map((l) => `module asm "${l.replace(/\\/g, "\\5C").replace(/"/g, "\\22")}"`),
      "",
    );
  out.push(
    ...helpers,
    ...[...used].sort().map((f) => RUNTIME[f] ?? `; ${f}`),
    ...decls,
    `declare ptr @calloc(${long}, ${long})`,
    "declare void @free(ptr)",
    "declare i32 @fflush(ptr)",
    "declare void @exit(i32) noreturn",
    "",
    `define ${long} @yk_sys(${long} %n, ${long} %a, ${long} %b, ${long} %c, ${long} %d, ${long} %e, ${long} %f) {`,
    ...sysBody(arch, long),
    "}",
    "",
    "define ptr @yk_mem_alloc(i64 %n) {",
    ...(bits32
      ? [
          "  %big = icmp ugt i64 %n, 4294967295",
          "  br i1 %big, label %none, label %go",
          "none:",
          "  ret ptr null",
          "go:",
          `  %m = trunc i64 %n to ${long}`,
          `  %p = call ptr @calloc(${long} 1, ${long} %m)`,
        ]
      : ["  %p = call ptr @calloc(i64 1, i64 %n)"]),
    "  ret ptr %p",
    "}",
    "",
    "define void @yk_mem_free(ptr %p) {",
    "  call void @free(ptr %p)",
    "  ret void",
    "}",
    "",
  );
  // The thread's control block: 4 KiB, zeroed, its first word its own address.
  const word = bits32
    ? "i32 ptrtoint (ptr @yk.tp to i32), i32 0"
    : "i64 ptrtoint (ptr @yk.tp to i64)";
  const rest = 4088;
  const ty = bits32 ? `{ i32, i32, [${rest} x i8] }` : `{ i64, [${rest} x i8] }`;
  out.push(
    `@yk.tp = internal global ${ty} { ${word}, [${rest} x i8] zeroinitializer }, align 64`,
    "define i64 @yk_leaf_tp() {",
    "  %a = ptrtoint ptr @yk.tp to i64",
    "  %r = call i64 @yk_bigint_from_i128(i64 %a, i64 0)",
    "  ret i64 %r",
    "}",
    "",
  );
  // The system-call leaf: its arguments' low 64 bits, the call by the target's number.
  const cases = Object.entries(numbers).sort((x, y) => Number(x[0]) - Number(y[0]));
  out.push(
    "define i64 @yk_leaf_syscall(i64 %nr, i64 %a0, i64 %b0, i64 %c0, i64 %d0, i64 %e0, i64 %f0) {",
    "entry:",
    "  %n = call i64 @yk.l.big64(i64 %nr)",
    ...["a", "b", "c", "d", "e", "f"].flatMap((r) => [
      `  %${r}w = call i64 @yk.l.big64(i64 %${r}0)`,
      `  %${r} = ${bits32 ? "trunc" : "add"} i64 %${r}w${bits32 ? "" : ", 0"}${bits32 ? ` to ${long}` : ""}`,
    ]),
    "  switch i64 %n, label %nosys [",
    "    i64 12, label %brk",
    "    i64 60, label %exit",
    "    i64 231, label %exit",
    ...cases.map(([x86]) => `    i64 ${x86}, label %call${x86}`),
    "  ]",
    "nosys:",
    "  br label %done64",
    "brk:",
    "  br label %done64",
    "exit:",
    "  call i32 @fflush(ptr null)",
    bits32 ? "  %code = add i32 %a, 0" : "  %code = trunc i64 %a to i32",
    "  call void @exit(i32 %code)",
    "  unreachable",
  );
  const results: string[] = [];
  for (const [x86, nr] of cases) {
    const label = `call${x86}`;
    out.push(`${label}:`);
    if (x86 === "1" || x86 === "20") out.push("  call i32 @fflush(ptr null)");
    let f = "%f";
    if (arch === "arm" && x86 === "9") {
      out.push(`  %pg${x86} = udiv ${long} %f, 4096`);
      f = `%pg${x86}`;
    }
    out.push(
      `  %r${x86} = call ${long} @yk_sys(${long} ${nr}, ${long} %a, ${long} %b, ${long} %c, ${long} %d, ${long} %e, ${long} ${f})`,
      "  br label %done",
    );
    results.push(`[ %r${x86}, %${label} ]`);
  }
  out.push(
    "done:",
    ...(results.length > 0
      ? [
          `  %rl = phi ${long} ${results.join(", ")}`,
          ...(bits32 ? ["  %rw = sext i32 %rl to i64"] : ["  %rw = add i64 %rl, 0"]),
        ]
      : ["  %rw = add i64 0, 0"]),
    "  br label %done64",
    "done64:",
    "  %r = phi i64 [ -38, %nosys ], [ 0, %brk ], [ %rw, %done ]",
    "  %h = ashr i64 %r, 63",
    "  %big = call i64 @yk_bigint_from_i128(i64 %r, i64 %h)",
    "  ret i64 %big",
    "}",
    "",
  );
  return out.join("\n");
}
