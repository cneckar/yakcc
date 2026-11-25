// SPDX-License-Identifier: Apache-2.0
/**
 * The system-call leaf and the thread pointer in the native runtime (#1365 layer 0, #1361 P1), with
 * raise-c's createCSystem meaning over C's memory:
 * - anonymous mmap gives a region of whole pages, and a file mapping is -ENOSYS;
 * - brk and munmap give 0, and mremap -ENOMEM;
 * - clock_gettime stores the time in C's memory;
 * - getpid gives 1;
 * - write and writev write C's bytes to the host's descriptor;
 * - an unknown call gives -ENOSYS;
 * - __yk_tp is a zeroed 4 KiB block whose first word is its own address.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canRun, harness } from "./__fixtures__/native-harness.js";
import { buildProgram } from "./build.js";
import { emitLlvmBoxed } from "./emit-llvm-boxed.js";
import { liftAtom } from "./lift.js";

const work = mkdtempSync(join(tmpdir(), "yakcc-syscall-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!canRun("x86_64-linux"))("the system-call leaf, natively (#1365)", () => {
  it("mmap, brk, munmap, mremap, clock_gettime, getpid, ENOSYS and the thread pointer", () => {
    const source = `export function f(k) {
      const m = __yk_syscall(9n, 0n, BigInt(5000 + k), 3n, 34n, -1n, 0n);
      const at = Number(m);
      __ykStore32(at + 8188, 7);
      const ts = __ykAlloc(16, 8);
      const clock = __yk_syscall(228n, 0n, BigInt(ts), 0n, 0n, 0n, 0n);
      const tp = __yk_tp();
      let past = "";
      try { __ykLoad8(at + 8192); } catch (e) { past = e.message.slice(0, 18); }
      return [
        m > 0n && at % 4096 === 0, __ykLoad32(at + 8188), past,
        __yk_syscall(9n, 0n, 4096n, 3n, 1n, 3n, 0n), __yk_syscall(12n, 0n, 0n, 0n, 0n, 0n, 0n),
        __yk_syscall(11n, m, 4096n, 0n, 0n, 0n, 0n), __yk_syscall(25n, m, 4096n, 8192n, 1n, 0n, 0n),
        clock, __ykLoad64(ts) > 1700000000n, __ykLoad64(ts + 8) < 1000000000n,
        __yk_syscall(39n, 0n, 0n, 0n, 0n, 0n, 0n), __yk_syscall(999n, 0n, 0n, 0n, 0n, 0n, 0n),
        __yk_syscall(1n, 2n, BigInt(ts), 0n, 0n, 0n, 0n),
        tp === __ykLoad64(Number(tp)), __ykLoad64(Number(tp) + 4088), tp === __yk_tp(),
      ];
    }`;
    const run = harness(emitLlvmBoxed(liftAtom(source)), work);
    const { results, stderr } = run([[0], [3000]]);
    expect(results.length, stderr).toBe(2);
    for (const r of results)
      expect(r).toEqual([
        true,
        7,
        "memory trap: load ",
        -38n,
        0n,
        0n,
        -12n,
        0n,
        true,
        true,
        1n,
        -38n,
        0n,
        true,
        0n,
        true,
      ]);
  }, 300_000);

  it("write and writev put C's bytes on the descriptor; exit ends the program with its status", () => {
    const entry = join(work, "hello.js");
    writeFileSync(
      entry,
      `const text = [104, 105, 10, 121, 111, 10];
const buf = __ykAlloc(32, 16);
for (let i = 0; i < text.length; i++) __ykStore8(buf + i, text[i]);
__yk_syscall(1n, 1n, BigInt(buf), 3n, 0n, 0n, 0n);
const iov = __ykAlloc(32, 16);
__ykStore64(iov, BigInt(buf + 3));
__ykStore64(iov + 8, 2n);
__ykStore64(iov + 16, BigInt(buf + 5));
__ykStore64(iov + 24, 1n);
__yk_syscall(20n, 1n, BigInt(iov), 2n, 0n, 0n, 0n);
__yk_syscall(231n, 7n, 0n, 0n, 0n, 0n, 0n);
console.log("not reached");
`,
    );
    const exe = join(work, "hello");
    buildProgram(entry, exe, { root: work });
    const r = spawnSync(exe, [], { encoding: "utf8" });
    expect(r.stdout).toBe("hi\nyo\n");
    expect(r.status).toBe(7);
  }, 300_000);
});
