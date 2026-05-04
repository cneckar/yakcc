/**
 * wasm-host-v2.test.ts — Conformance fixture for the yakcc WASM host v2 syscall surface.
 *
 * This file is the conformance fixture referenced by WASM_HOST_CONTRACT.md §14.7.
 * Any host claiming "Conformant with WASM_HOST_CONTRACT.md v2 syscall surface
 * (WI-WASM-HOST-CONTRACT-V2)" must pass all tests defined here.
 *
 * Production sequence exercised:
 *   createHost() → importObject.yakcc_host.host_fs_* / host_proc_* / host_time_* / host_random_*
 *   → direct import-function calls with real linear memory
 *
 * Test structure:
 *   1.  importObject shape — all 24 keys present (1 memory + 4 v1 + 5 wave-3 + 14 v2)
 *   2.  fs happy-path: open+read+close round-trip
 *   3.  fs happy-path: write+read round-trip
 *   4.  fs happy-path: mkdir+unlink
 *   5.  fs happy-path: stat returns plausible mtime/size
 *   6.  fs negative: open non-existent → ENOENT
 *   7.  fs negative: read from closed fd → EBADF
 *   8.  proc: argv length matches process.argv
 *   9.  proc: env_get returns expected value for a set env var
 *   10. proc: exit invokes onExit hook without killing process
 *   11. time: now_unix_ms within 1 s of Date.now()
 *   12. time: monotonic_ns is strictly increasing across two calls
 *   13. random: random_bytes(N) yields non-zero entropy; two calls differ
 *   14. integration: hand-rolled WASM module that imports host_fs_write + host_fs_read
 *       round-trips bytes through a temp file
 *
 * @decision DEC-V2-WASM-HOST-CONTRACT-WASI-001
 * @title v2 syscall surface is WASI-preview1-shaped
 * @status accepted
 * @rationale Errno values follow WASI preview1 enum; imports use host_* namespace.
 *   Node stdlib (node:fs, node:crypto, node:process) provides sync backing impls.
 *   Tests exercise the real Node syscall path — no mock at the fs boundary.
 */

import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import * as nodeProcess from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WasiErrno, createHost } from "./wasm-host.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cast the yakcc_host namespace to a typed record for calling imports directly. */
function getHost(host: ReturnType<typeof createHost>): Record<string, unknown> {
  return host.importObject.yakcc_host as Record<string, unknown>;
}

/** Write a UTF-8 string into linear memory and return (ptr, len). Uses bump alloc. */
function writeString(host: ReturnType<typeof createHost>, s: string): { ptr: number; len: number } {
  const enc = new TextEncoder().encode(s);
  const hostAlloc = getHost(host).host_alloc as (n: number) => number;
  const ptr = hostAlloc(enc.length);
  new Uint8Array(host.memory.buffer).set(enc, ptr);
  return { ptr, len: enc.length };
}

/** Read a little-endian i32 from linear memory at offset. */
function readI32LE(host: ReturnType<typeof createHost>, offset: number): number {
  return new DataView(host.memory.buffer).getInt32(offset, true);
}

/** Read a little-endian i64 from linear memory as a BigInt (two Uint32 halves). */
function readI64LE(host: ReturnType<typeof createHost>, offset: number): bigint {
  const dv = new DataView(host.memory.buffer);
  const lo = BigInt(dv.getUint32(offset, true));
  const hi = BigInt(dv.getUint32(offset + 4, true));
  return lo | (hi << 32n);
}

/** Allocate an i32 output slot in linear memory via bump alloc. Returns the pointer. */
function allocSlot(host: ReturnType<typeof createHost>): number {
  const hostAlloc = getHost(host).host_alloc as (n: number) => number;
  return hostAlloc(4);
}

/** Allocate an i64 (8-byte) output slot in linear memory via bump alloc. */
function allocSlot64(host: ReturnType<typeof createHost>): number {
  const hostAlloc = getHost(host).host_alloc as (n: number) => number;
  return hostAlloc(8);
}

// ---------------------------------------------------------------------------
// Temp directory lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
  tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "yakcc-v2-test-"));
});

afterAll(() => {
  // Clean up temp dir and anything left inside (best-effort).
  try {
    nodeFs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // swallow — test cleanup is best-effort
  }
});

// ---------------------------------------------------------------------------
// Test 1: importObject shape — all 24 keys
// ---------------------------------------------------------------------------

describe("createHost() — v2 importObject shape", () => {
  it("exposes all 26 required yakcc_host keys (1 memory + 4 v1 + 7 wave-3 + 14 v2)" +
    " — WI-V1W3-WASM-LOWER-08 followup adds 2 codepoint imports (closes #82)", () => {
    const host = createHost();
    const yh = getHost(host);

    // 1 memory import
    expect(yh.memory).toBeInstanceOf(WebAssembly.Memory);

    // 4 v1 imports
    expect(typeof yh.host_log).toBe("function");
    expect(typeof yh.host_alloc).toBe("function");
    expect(typeof yh.host_free).toBe("function");
    expect(typeof yh.host_panic).toBe("function");

    // 5 wave-3 string imports (WI-V1W3-WASM-LOWER-05)
    expect(typeof yh.host_string_length).toBe("function");
    expect(typeof yh.host_string_indexof).toBe("function");
    expect(typeof yh.host_string_slice).toBe("function");
    expect(typeof yh.host_string_concat).toBe("function");
    expect(typeof yh.host_string_eq).toBe("function");

    // 2 wave-3.1 codepoint iteration imports (WI-V1W3-WASM-LOWER-08 followup, closes #82)
    // DEC-V1-WAVE-3-WASM-LOWER-CF5-HOST-001
    expect(typeof yh.host_string_codepoint_at).toBe("function");
    expect(typeof yh.host_string_codepoint_next_offset).toBe("function");

    // 14 v2 syscall imports
    expect(typeof yh.host_fs_open).toBe("function");
    expect(typeof yh.host_fs_close).toBe("function");
    expect(typeof yh.host_fs_read).toBe("function");
    expect(typeof yh.host_fs_write).toBe("function");
    expect(typeof yh.host_fs_stat).toBe("function");
    expect(typeof yh.host_fs_readdir).toBe("function");
    expect(typeof yh.host_fs_mkdir).toBe("function");
    expect(typeof yh.host_fs_unlink).toBe("function");
    expect(typeof yh.host_proc_argv).toBe("function");
    expect(typeof yh.host_proc_env_get).toBe("function");
    expect(typeof yh.host_proc_exit).toBe("function");
    expect(typeof yh.host_time_now_unix_ms).toBe("function");
    expect(typeof yh.host_time_monotonic_ns).toBe("function");
    expect(typeof yh.host_random_bytes).toBe("function");

    // Total key count: 26 (was 24; +2 for codepoint imports per #82)
    expect(Object.keys(yh).length).toBe(26);

    host.close();
  });
});

// ---------------------------------------------------------------------------
// Tests 2–5: Filesystem happy paths
// ---------------------------------------------------------------------------

describe("host_fs_* — happy paths", () => {
  it("2. open+read+close round-trip reads back written file content", () => {
    const host = createHost();
    const yh = getHost(host);
    const hostFsOpen = yh.host_fs_open as (
      pp: number,
      pl: number,
      flags: number,
      outFd: number,
    ) => number;
    const hostFsClose = yh.host_fs_close as (fd: number) => number;
    const hostFsRead = yh.host_fs_read as (
      fd: number,
      bp: number,
      bl: number,
      outBr: number,
    ) => number;

    // Write a known file via Node directly (not via host_fs_write — isolates read path)
    const filePath = nodePath.join(tmpDir, "read-test.txt");
    const content = "hello yakcc";
    nodeFs.writeFileSync(filePath, content, "utf8");

    const { ptr: pathPtr, len: pathLen } = writeString(host, filePath);
    const fdOutPtr = allocSlot(host);

    // Open for reading (flags=0 = O_RDONLY)
    const openErrno = hostFsOpen(pathPtr, pathLen, 0, fdOutPtr);
    expect(openErrno).toBe(WasiErrno.SUCCESS);
    const fd = readI32LE(host, fdOutPtr);
    expect(fd).toBeGreaterThan(0);

    // Read into linear memory buffer
    const hostAlloc = yh.host_alloc as (n: number) => number;
    const bufPtr = hostAlloc(64);
    const bytesReadOutPtr = allocSlot(host);
    const readErrno = hostFsRead(fd, bufPtr, 64, bytesReadOutPtr);
    expect(readErrno).toBe(WasiErrno.SUCCESS);
    const bytesRead = readI32LE(host, bytesReadOutPtr);
    expect(bytesRead).toBe(content.length);

    // Decode what was read
    const decoded = new TextDecoder().decode(new Uint8Array(host.memory.buffer, bufPtr, bytesRead));
    expect(decoded).toBe(content);

    // Close
    const closeErrno = hostFsClose(fd);
    expect(closeErrno).toBe(WasiErrno.SUCCESS);

    host.close();
  });

  it("3. write+read round-trip: written bytes match read-back bytes", () => {
    const host = createHost();
    const yh = getHost(host);
    const hostFsOpen = yh.host_fs_open as (
      pp: number,
      pl: number,
      flags: number,
      outFd: number,
    ) => number;
    const hostFsClose = yh.host_fs_close as (fd: number) => number;
    const hostFsWrite = yh.host_fs_write as (
      fd: number,
      bp: number,
      bl: number,
      outBw: number,
    ) => number;
    const hostFsRead = yh.host_fs_read as (
      fd: number,
      bp: number,
      bl: number,
      outBr: number,
    ) => number;

    const filePath = nodePath.join(tmpDir, "write-read-test.txt");
    const payload = new TextEncoder().encode("round-trip-data");

    // Open for writing (flags = O_WRONLY|O_CREAT|O_TRUNC = 1|512|1024 = 1537)
    const { ptr: pathPtr, len: pathLen } = writeString(host, filePath);
    const fdOutPtr = allocSlot(host);
    const writeOpenErrno = hostFsOpen(pathPtr, pathLen, 1537, fdOutPtr);
    expect(writeOpenErrno).toBe(WasiErrno.SUCCESS);
    const writeFd = readI32LE(host, fdOutPtr);

    // Copy payload into linear memory and write
    const hostAlloc = yh.host_alloc as (n: number) => number;
    const payloadPtr = hostAlloc(payload.length);
    new Uint8Array(host.memory.buffer).set(payload, payloadPtr);
    const bwOutPtr = allocSlot(host);
    const writeErrno = hostFsWrite(writeFd, payloadPtr, payload.length, bwOutPtr);
    expect(writeErrno).toBe(WasiErrno.SUCCESS);
    const bytesWritten = readI32LE(host, bwOutPtr);
    expect(bytesWritten).toBe(payload.length);
    hostFsClose(writeFd);

    // Re-open for reading and verify
    const { ptr: rPathPtr, len: rPathLen } = writeString(host, filePath);
    const rFdOutPtr = allocSlot(host);
    hostFsOpen(rPathPtr, rPathLen, 0, rFdOutPtr);
    const readFd = readI32LE(host, rFdOutPtr);
    const readBufPtr = hostAlloc(64);
    const brOutPtr = allocSlot(host);
    hostFsRead(readFd, readBufPtr, 64, brOutPtr);
    const bytesRead = readI32LE(host, brOutPtr);
    expect(bytesRead).toBe(payload.length);
    const readBack = new Uint8Array(host.memory.buffer, readBufPtr, bytesRead);
    expect(Array.from(readBack)).toEqual(Array.from(payload));
    hostFsClose(readFd);

    host.close();
  });

  it("4. mkdir creates directory; unlink removes a file", () => {
    const host = createHost();
    const yh = getHost(host);
    const hostFsMkdir = yh.host_fs_mkdir as (pp: number, pl: number, mode: number) => number;
    const hostFsUnlink = yh.host_fs_unlink as (pp: number, pl: number) => number;

    // mkdir
    const dirPath = nodePath.join(tmpDir, "subdir-test");
    const { ptr: dirPtr, len: dirLen } = writeString(host, dirPath);
    const mkdirErrno = hostFsMkdir(dirPtr, dirLen, 0o755);
    expect(mkdirErrno).toBe(WasiErrno.SUCCESS);
    expect(nodeFs.existsSync(dirPath)).toBe(true);
    expect(nodeFs.statSync(dirPath).isDirectory()).toBe(true);

    // Create a file to unlink
    const filePath = nodePath.join(tmpDir, "to-unlink.txt");
    nodeFs.writeFileSync(filePath, "x");
    const { ptr: filePtr, len: fileLen } = writeString(host, filePath);
    const unlinkErrno = hostFsUnlink(filePtr, fileLen);
    expect(unlinkErrno).toBe(WasiErrno.SUCCESS);
    expect(nodeFs.existsSync(filePath)).toBe(false);

    host.close();
  });

  it("5. stat returns plausible mtime and size for an existing file", () => {
    const host = createHost();
    const yh = getHost(host);
    const hostFsStat = yh.host_fs_stat as (pp: number, pl: number, out: number) => number;
    const hostAlloc = yh.host_alloc as (n: number) => number;

    const filePath = nodePath.join(tmpDir, "stat-test.txt");
    const fileContent = "stat me";
    nodeFs.writeFileSync(filePath, fileContent, "utf8");

    const { ptr: pathPtr, len: pathLen } = writeString(host, filePath);
    // stat_out: 16 bytes
    const statOutPtr = hostAlloc(16);
    const statErrno = hostFsStat(pathPtr, pathLen, statOutPtr);
    expect(statErrno).toBe(WasiErrno.SUCCESS);

    // size should match content byte length
    const size = readI32LE(host, statOutPtr + 8);
    expect(size).toBe(fileContent.length);

    // mtime_ns should be within last 60 seconds (plausibility check)
    const mtimeNs = readI64LE(host, statOutPtr);
    const nowMs = BigInt(Date.now());
    const mtimeMs = mtimeNs / 1_000_000n;
    expect(mtimeMs).toBeGreaterThan(nowMs - 60_000n);
    expect(mtimeMs).toBeLessThanOrEqual(nowMs + 5_000n);

    // filetype should be 4 (regular_file)
    const filetype = readI32LE(host, statOutPtr + 12);
    expect(filetype).toBe(4);

    host.close();
  });
});

// ---------------------------------------------------------------------------
// Tests 6–7: Filesystem negative paths
// ---------------------------------------------------------------------------

describe("host_fs_* — negative paths", () => {
  it("6. open non-existent file returns ENOENT", () => {
    const host = createHost();
    const yh = getHost(host);
    const hostFsOpen = yh.host_fs_open as (
      pp: number,
      pl: number,
      flags: number,
      outFd: number,
    ) => number;

    const { ptr: pathPtr, len: pathLen } = writeString(
      host,
      nodePath.join(tmpDir, "definitely-does-not-exist-xyz.txt"),
    );
    const fdOutPtr = allocSlot(host);
    const errno = hostFsOpen(pathPtr, pathLen, 0, fdOutPtr);
    expect(errno).toBe(WasiErrno.NOENT);

    host.close();
  });

  it("7. read from a never-opened fd returns EBADF", () => {
    const host = createHost();
    const yh = getHost(host);
    const hostFsRead = yh.host_fs_read as (
      fd: number,
      bp: number,
      bl: number,
      out: number,
    ) => number;
    const hostAlloc = yh.host_alloc as (n: number) => number;

    // fd 9999 was never opened via host_fs_open
    const bufPtr = hostAlloc(16);
    const outPtr = allocSlot(host);
    const errno = hostFsRead(9999, bufPtr, 16, outPtr);
    expect(errno).toBe(WasiErrno.BADF);

    host.close();
  });

  it("7b. read from fd that was opened then closed returns EBADF", () => {
    const host = createHost();
    const yh = getHost(host);
    const hostFsOpen = yh.host_fs_open as (
      pp: number,
      pl: number,
      flags: number,
      outFd: number,
    ) => number;
    const hostFsClose = yh.host_fs_close as (fd: number) => number;
    const hostFsRead = yh.host_fs_read as (
      fd: number,
      bp: number,
      bl: number,
      out: number,
    ) => number;
    const hostAlloc = yh.host_alloc as (n: number) => number;

    const filePath = nodePath.join(tmpDir, "close-then-read.txt");
    nodeFs.writeFileSync(filePath, "data");
    const { ptr: pathPtr, len: pathLen } = writeString(host, filePath);
    const fdOutPtr = allocSlot(host);
    hostFsOpen(pathPtr, pathLen, 0, fdOutPtr);
    const fd = readI32LE(host, fdOutPtr);
    hostFsClose(fd);

    // After close, reading should return EBADF from our fd table check
    const bufPtr = hostAlloc(16);
    const outPtr = allocSlot(host);
    const errno = hostFsRead(fd, bufPtr, 16, outPtr);
    expect(errno).toBe(WasiErrno.BADF);

    host.close();
  });
});

// ---------------------------------------------------------------------------
// Test 7c: O_RDWR|O_CREAT|O_TRUNC truncation conformance (Finding 1 regression guard)
// ---------------------------------------------------------------------------

describe("host_fs_open — O_RDWR|O_CREAT|O_TRUNC truncation (flags=1538)", () => {
  /**
   * Regression guard for the isRdWr+isTrunc bug fixed in WI-WASM-HOST-CONTRACT-V2.
   *
   * Production sequence:
   *   1. Create a file via O_WRONLY|O_CREAT (flags=513) and write 100 bytes.
   *   2. Re-open the same file with O_RDWR|O_CREAT|O_TRUNC (flags=1538 = 2|512|1024).
   *   3. Write 50 bytes through the new fd.
   *   4. Close and stat — file size must be 50, proving truncation occurred.
   *
   * Without the fix the isRdWr branch mapped O_RDWR|O_CREAT to "a+" (append) which ignores
   * O_TRUNC, leaving the original 100 bytes intact.  The fix maps isTrunc → "w+" so Node
   * truncates on open just as POSIX requires.
   *
   * @decision DEC-V2-WASM-HOST-CONTRACT-WASI-001
   */
  it("7c. O_RDWR|O_CREAT|O_TRUNC (flags=1538) truncates an existing file to the newly written size", () => {
    const host = createHost();
    const yh = getHost(host);
    const hostFsOpen = yh.host_fs_open as (
      pp: number,
      pl: number,
      flags: number,
      outFd: number,
    ) => number;
    const hostFsClose = yh.host_fs_close as (fd: number) => number;
    const hostFsWrite = yh.host_fs_write as (
      fd: number,
      bp: number,
      bl: number,
      outBw: number,
    ) => number;
    const hostFsStat = yh.host_fs_stat as (pp: number, pl: number, out: number) => number;
    const hostAlloc = yh.host_alloc as (n: number) => number;

    const filePath = nodePath.join(tmpDir, "trunc-rdwr-test.bin");

    // Step 1: create file with 100 bytes via O_WRONLY|O_CREAT|O_TRUNC (flags=1537)
    const buf100 = new Uint8Array(100).fill(0xaa);
    const { ptr: p1Ptr, len: p1Len } = writeString(host, filePath);
    const fd1OutPtr = allocSlot(host);
    const openErrno1 = hostFsOpen(p1Ptr, p1Len, 1537, fd1OutPtr);
    expect(openErrno1).toBe(WasiErrno.SUCCESS);
    const fd1 = readI32LE(host, fd1OutPtr);
    const buf100Ptr = hostAlloc(100);
    new Uint8Array(host.memory.buffer).set(buf100, buf100Ptr);
    const bw1OutPtr = allocSlot(host);
    const writeErrno1 = hostFsWrite(fd1, buf100Ptr, 100, bw1OutPtr);
    expect(writeErrno1).toBe(WasiErrno.SUCCESS);
    expect(readI32LE(host, bw1OutPtr)).toBe(100);
    hostFsClose(fd1);

    // Verify baseline: file is 100 bytes on disk
    expect(nodeFs.statSync(filePath).size).toBe(100);

    // Step 2: re-open with O_RDWR|O_CREAT|O_TRUNC (flags = 2|512|1024 = 1538)
    const { ptr: p2Ptr, len: p2Len } = writeString(host, filePath);
    const fd2OutPtr = allocSlot(host);
    const openErrno2 = hostFsOpen(p2Ptr, p2Len, 1538, fd2OutPtr);
    expect(openErrno2).toBe(WasiErrno.SUCCESS);
    const fd2 = readI32LE(host, fd2OutPtr);

    // Step 3: write 50 bytes through the new fd
    const buf50 = new Uint8Array(50).fill(0xbb);
    const buf50Ptr = hostAlloc(50);
    new Uint8Array(host.memory.buffer).set(buf50, buf50Ptr);
    const bw2OutPtr = allocSlot(host);
    const writeErrno2 = hostFsWrite(fd2, buf50Ptr, 50, bw2OutPtr);
    expect(writeErrno2).toBe(WasiErrno.SUCCESS);
    expect(readI32LE(host, bw2OutPtr)).toBe(50);
    hostFsClose(fd2);

    // Step 4: stat via host and assert size === 50 (truncation proof)
    const { ptr: p3Ptr, len: p3Len } = writeString(host, filePath);
    const statOutPtr = hostAlloc(16);
    const statErrno = hostFsStat(p3Ptr, p3Len, statOutPtr);
    expect(statErrno).toBe(WasiErrno.SUCCESS);
    const reportedSize = readI32LE(host, statOutPtr + 8);
    expect(reportedSize).toBe(50); // Must be 50, not 100 — truncation happened

    host.close();
  });
});

// ---------------------------------------------------------------------------
// Tests 8–10: Process imports
// ---------------------------------------------------------------------------

describe("host_proc_* — process imports", () => {
  it("8. argv: total bytes written is at least sum of process.argv strings + null terminators", () => {
    const host = createHost();
    const yh = getHost(host);
    const hostProcArgv = yh.host_proc_argv as (bp: number, bl: number, out: number) => number;
    const hostAlloc = yh.host_alloc as (n: number) => number;

    const bufPtr = hostAlloc(4096);
    const outPtr = allocSlot(host);
    const errno = hostProcArgv(bufPtr, 4096, outPtr);
    expect(errno).toBe(WasiErrno.SUCCESS);

    const bytesWritten = readI32LE(host, outPtr);
    // Each argv entry: encoded bytes + 1 null terminator
    const expectedMin = nodeProcess.argv.reduce(
      (acc, a) => acc + new TextEncoder().encode(a).length + 1,
      0,
    );
    expect(bytesWritten).toBeGreaterThanOrEqual(expectedMin);

    host.close();
  });

  it("9. env_get returns expected value for a known env var", () => {
    const host = createHost();
    const yh = getHost(host);
    const hostProcEnvGet = yh.host_proc_env_get as (
      np: number,
      nl: number,
      bp: number,
      bl: number,
      out: number,
    ) => number;
    const hostAlloc = yh.host_alloc as (n: number) => number;

    // Set a known env var for this test
    const testKey = "YAKCC_V2_TEST_VAR_XYZ";
    const testVal = "hello-from-v2";
    nodeProcess.env[testKey] = testVal;

    const { ptr: namePtr, len: nameLen } = writeString(host, testKey);
    const bufPtr = hostAlloc(256);
    const outPtr = allocSlot(host);
    const errno = hostProcEnvGet(namePtr, nameLen, bufPtr, 256, outPtr);
    expect(errno).toBe(WasiErrno.SUCCESS);

    const byteCount = readI32LE(host, outPtr);
    const decoded = new TextDecoder().decode(new Uint8Array(host.memory.buffer, bufPtr, byteCount));
    expect(decoded).toBe(testVal);

    // Clean up
    delete nodeProcess.env[testKey];
    host.close();
  });

  it("9b. env_get returns NOENT for an unset variable", () => {
    const host = createHost();
    const yh = getHost(host);
    const hostProcEnvGet = yh.host_proc_env_get as (
      np: number,
      nl: number,
      bp: number,
      bl: number,
      out: number,
    ) => number;
    const hostAlloc = yh.host_alloc as (n: number) => number;

    const { ptr: namePtr, len: nameLen } = writeString(host, "YAKCC_DEFINITELY_NOT_SET_AAABBBCCC");
    const bufPtr = hostAlloc(64);
    const outPtr = allocSlot(host);
    const errno = hostProcEnvGet(namePtr, nameLen, bufPtr, 64, outPtr);
    expect(errno).toBe(WasiErrno.NOENT);

    host.close();
  });

  it("10. exit: onExit hook is called with the exit code, process is not killed", () => {
    const exitCodes: number[] = [];
    const host = createHost({
      onExit: (code) => {
        exitCodes.push(code);
      },
    });
    const yh = getHost(host);
    const hostProcExit = yh.host_proc_exit as (code: number) => void;

    // host_proc_exit throws a WasmTrap after calling onExit (to unwind the call stack),
    // so we expect it to throw.
    expect(() => hostProcExit(42)).toThrow();
    expect(exitCodes).toEqual([42]);

    host.close();
  });
});

// ---------------------------------------------------------------------------
// Tests 11–12: Time imports
// ---------------------------------------------------------------------------

describe("host_time_* — time imports", () => {
  it("11. now_unix_ms is within 1 second of Date.now()", () => {
    const host = createHost();
    const yh = getHost(host);
    const hostTimeNow = yh.host_time_now_unix_ms as (out: number) => number;

    const outPtr = allocSlot64(host);
    const before = BigInt(Date.now());
    const errno = hostTimeNow(outPtr);
    const after = BigInt(Date.now());
    expect(errno).toBe(WasiErrno.SUCCESS);

    const hostMs = readI64LE(host, outPtr);
    // Must be within the [before-1000, after+1000] window (1 second tolerance)
    expect(hostMs).toBeGreaterThanOrEqual(before - 1000n);
    expect(hostMs).toBeLessThanOrEqual(after + 1000n);

    host.close();
  });

  it("12. monotonic_ns is strictly increasing across two successive calls", () => {
    const host = createHost();
    const yh = getHost(host);
    const hostMonotonic = yh.host_time_monotonic_ns as (out: number) => number;
    const hostAlloc = yh.host_alloc as (n: number) => number;

    const out1 = hostAlloc(8);
    const out2 = hostAlloc(8);

    hostMonotonic(out1);
    // Spin briefly to ensure monotonic advancement (performance.now() has ~100µs resolution)
    const spinEnd = Date.now() + 2;
    while (Date.now() < spinEnd) {
      /* spin */
    }
    hostMonotonic(out2);

    const ns1 = readI64LE(host, out1);
    const ns2 = readI64LE(host, out2);
    expect(ns2).toBeGreaterThan(ns1);

    host.close();
  });
});

// ---------------------------------------------------------------------------
// Test 13: Randomness
// ---------------------------------------------------------------------------

describe("host_random_bytes — randomness", () => {
  it("13. random_bytes(32) yields non-zero entropy; two calls produce different sequences", () => {
    const host = createHost();
    const yh = getHost(host);
    const hostRandom = yh.host_random_bytes as (bp: number, bl: number) => number;
    const hostAlloc = yh.host_alloc as (n: number) => number;

    const N = 32;
    const buf1Ptr = hostAlloc(N);
    const buf2Ptr = hostAlloc(N);

    const errno1 = hostRandom(buf1Ptr, N);
    const errno2 = hostRandom(buf2Ptr, N);
    expect(errno1).toBe(WasiErrno.SUCCESS);
    expect(errno2).toBe(WasiErrno.SUCCESS);

    const bytes1 = Array.from(new Uint8Array(host.memory.buffer, buf1Ptr, N));
    const bytes2 = Array.from(new Uint8Array(host.memory.buffer, buf2Ptr, N));

    // Not all-zero (non-zero entropy)
    expect(bytes1.every((b) => b === 0)).toBe(false);
    expect(bytes2.every((b) => b === 0)).toBe(false);

    // Two calls produce different sequences (collision probability: 2^-256 for 32 bytes)
    expect(bytes1).not.toEqual(bytes2);

    host.close();
  });
});

// ---------------------------------------------------------------------------
// Test 14: Integration — hand-rolled WASM module using host_fs_write + host_fs_read
// ---------------------------------------------------------------------------

describe("Integration — hand-rolled WASM module with host_fs_write + host_fs_read", () => {
  /**
   * Build a minimal WASM binary that:
   *   1. imports memory, host_fs_write, host_fs_read from yakcc_host
   *   2. exports a function `test_roundtrip(fd: i32, data_ptr: i32, data_len: i32, out_fd: i32) -> i32`
   *      that calls host_fs_write then rewinds the file and calls host_fs_read,
   *      returns the bytes_read value so the host can assert it.
   *
   * We build the binary using the WASM binary encoding directly (no wabt dependency).
   * The module structure is minimal: types, imports, function, export, code sections.
   *
   * The function logic in WASM pseudo-code:
   *   (param $fd i32) (param $data_ptr i32) (param $data_len i32) (param $out_fd i32) (result i32)
   *   ;; write: host_fs_write(fd, data_ptr, data_len, &bytes_written)
   *   ;; bytes_written stored at scratch_ptr (compile-time constant in data segment, offset 0)
   *   local.get $fd
   *   local.get $data_ptr
   *   local.get $data_len
   *   i32.const 512   ;; scratch ptr for bytes_written output (in reserved space, offset 512)
   *   call $host_fs_write  ;; -> errno (drop)
   *   drop
   *   ;; read: host_fs_read(out_fd, data_ptr, data_len, &bytes_read)
   *   ;; result at offset 516
   *   local.get $out_fd
   *   local.get $data_ptr
   *   local.get $data_len
   *   i32.const 516   ;; scratch ptr for bytes_read output
   *   call $host_fs_read  ;; -> errno (drop)
   *   drop
   *   ;; return bytes_read (i32 at offset 516)
   *   i32.const 516
   *   i32.load
   *
   * This exercises the real production path: WASM module → host_fs_write → disk → host_fs_read.
   */
  function buildTestModule(): Uint8Array {
    // Helpers to encode LEB128
    function uleb(n: number): number[] {
      const out: number[] = [];
      do {
        let byte = n & 0x7f;
        n >>>= 7;
        if (n !== 0) byte |= 0x80;
        out.push(byte);
      } while (n !== 0);
      return out;
    }
    function section(id: number, body: number[]): number[] {
      return [id, ...uleb(body.length), ...body];
    }
    function vec(items: number[][]): number[] {
      return [...uleb(items.length), ...items.flat()];
    }

    // Type section:
    //   T0: () -> ()                  (memory import — unused type but needed for completeness)
    //   T1: (i32,i32,i32,i32) -> i32  (host_fs_write signature)
    //   T2: (i32,i32,i32,i32) -> i32  (host_fs_read signature)
    //   T3: (i32,i32,i32,i32) -> i32  (our exported test_roundtrip function)
    const typeSection = section(1, [
      ...vec([
        [0x60, 0x00, 0x00], // T0: () -> ()
        [0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f], // T1: (i32,i32,i32,i32)->i32
        [0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f], // T2: same
        [0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f], // T3: our function
      ]),
    ]);

    // Import section:
    //   yakcc_host / memory      (memory, limits min=1 max=1)
    //   yakcc_host / host_fs_write  (func, T1 = index 1)
    //   yakcc_host / host_fs_read   (func, T2 = index 2)
    function strBytes(s: string): number[] {
      const enc = new TextEncoder().encode(s);
      return [...uleb(enc.length), ...Array.from(enc)];
    }
    const importSection = section(2, [
      ...uleb(3), // 3 imports
      // memory import
      ...strBytes("yakcc_host"),
      ...strBytes("memory"),
      0x02,
      0x01,
      0x01,
      0x01, // kind=memory, flags=1 (has max), min=1, max=1
      // host_fs_write import (func index 0)
      ...strBytes("yakcc_host"),
      ...strBytes("host_fs_write"),
      0x00,
      0x01, // kind=func, type index 1
      // host_fs_read import (func index 1)
      ...strBytes("yakcc_host"),
      ...strBytes("host_fs_read"),
      0x00,
      0x02, // kind=func, type index 2
    ]);

    // Function section: 1 function, type T3 (index 3)
    const funcSection = section(3, [...uleb(1), 0x03]);

    // Export section: export "test_roundtrip" as func index 2 (func 0 = write import, 1 = read import, 2 = our func)
    const exportSection = section(7, [
      ...uleb(1),
      ...strBytes("test_roundtrip"),
      0x00, // kind=func
      0x02, // func index 2
    ]);

    // Code section: body for our function
    // (fd: i32, data_ptr: i32, data_len: i32, out_fd: i32) -> i32
    // Locals: none (all params)
    // Body:
    //   local.get 0 (fd for write)
    //   local.get 1 (data_ptr)
    //   local.get 2 (data_len)
    //   i32.const 512   (scratch for bytes_written)
    //   call 0          (host_fs_write)
    //   drop
    //   local.get 3 (out_fd for read)
    //   local.get 1 (data_ptr — reuse same buffer)
    //   local.get 2 (data_len)
    //   i32.const 516   (scratch for bytes_read)
    //   call 1          (host_fs_read)
    //   drop
    //   i32.const 516
    //   i32.load        (alignment=2, offset=0: 0x28 0x02 0x00)
    //   end
    const codeBody = [
      0x00, // 0 local declarations
      0x20,
      0x00, // local.get 0
      0x20,
      0x01, // local.get 1
      0x20,
      0x02, // local.get 2
      0x41,
      ...uleb(512), // i32.const 512
      0x10,
      0x00, // call 0 (host_fs_write)
      0x1a, // drop
      0x20,
      0x03, // local.get 3
      0x20,
      0x01, // local.get 1
      0x20,
      0x02, // local.get 2
      0x41,
      ...uleb(516), // i32.const 516
      0x10,
      0x01, // call 1 (host_fs_read)
      0x1a, // drop
      0x41,
      ...uleb(516), // i32.const 516
      0x28,
      0x02,
      0x00, // i32.load align=2 offset=0
      0x0b, // end
    ];
    const codeSection = section(10, [
      ...uleb(1), // 1 function
      ...uleb(codeBody.length), // body size (0x0b end byte is already the last element of codeBody)
      ...codeBody,
    ]);

    const bytes = [
      0x00,
      0x61,
      0x73,
      0x6d, // magic
      0x01,
      0x00,
      0x00,
      0x00, // version
      ...typeSection,
      ...importSection,
      ...funcSection,
      ...exportSection,
      ...codeSection,
    ];
    return new Uint8Array(bytes);
  }

  it("14. WASM module using host_fs_write + host_fs_read round-trips bytes through a temp file", async () => {
    const host = createHost();
    const yh = getHost(host);
    const hostFsOpen = yh.host_fs_open as (
      pp: number,
      pl: number,
      flags: number,
      outFd: number,
    ) => number;
    const hostFsClose = yh.host_fs_close as (fd: number) => number;
    const hostAlloc = yh.host_alloc as (n: number) => number;

    // Open write fd
    const writeFile = nodePath.join(tmpDir, "wasm-roundtrip.bin");
    const { ptr: wpPtr, len: wpLen } = writeString(host, writeFile);
    const wFdOutPtr = allocSlot(host);
    // flags = O_WRONLY|O_CREAT|O_TRUNC = 1|512|1024 = 1537
    hostFsOpen(wpPtr, wpLen, 1537, wFdOutPtr);
    const writeFd = readI32LE(host, wFdOutPtr);
    expect(writeFd).toBeGreaterThan(0);

    // Open read fd (same file — will read after write via separate fd)
    // We write first, close write fd, then open for read, and use a separate fd for read
    // So: write fd writes the data, we close it, open read fd, then call WASM test_roundtrip
    // with readFd and the same data buffer (module writes scratch, reads back).
    // Simpler: use WASM only for the write pass, verify bytes on Node side.

    // Write payload into linear memory
    const payload = new TextEncoder().encode("wasm-roundtrip-payload");
    const payloadPtr = hostAlloc(payload.length);
    new Uint8Array(host.memory.buffer).set(payload, payloadPtr);

    // Build and instantiate the WASM module.
    // Copy into a concrete ArrayBuffer so TypeScript narrows to BufferSource correctly
    // (Uint8Array<ArrayBufferLike> is not assignable to BufferSource without the copy).
    const wasmBytes = buildTestModule();
    const wasmBuffer = wasmBytes.buffer.slice(
      wasmBytes.byteOffset,
      wasmBytes.byteOffset + wasmBytes.byteLength,
    ) as ArrayBuffer;
    const wasmModule = await WebAssembly.compile(wasmBuffer);
    const instance = await WebAssembly.instantiate(wasmModule, host.importObject);

    // Close write fd after open; open a fresh fd for the WASM module to write through
    hostFsClose(writeFd);

    // Re-open for write+read (O_RDWR|O_CREAT|O_TRUNC = 2|512|1024 = 1538)
    const { ptr: rrPathPtr, len: rrPathLen } = writeString(host, writeFile);
    const rrFdOutPtr = allocSlot(host);
    hostFsOpen(rrPathPtr, rrPathLen, 1538, rrFdOutPtr);
    const rwFd = readI32LE(host, rrFdOutPtr);
    expect(rwFd).toBeGreaterThan(0);

    // Also open a second read-only fd for the read pass (so we read from offset 0)
    const { ptr: rPathPtr, len: rPathLen } = writeString(host, writeFile);
    const rFdOutPtr = allocSlot(host);
    // Write via rwFd first via WASM, then read via rwFd (Node resets position)
    // Actually: call test_roundtrip with (writeFd=rwFd, data, readFd=rFd)
    // But reading from same file immediately after write without seek won't work at EOF.
    // Simplest: write via host import directly, then verify via WASM read call.

    // Use WASM function: test_roundtrip(writeFd, data_ptr, data_len, readFd) -> bytes_read
    // First: write through WASM using rwFd; then open separate read fd positioned at 0
    const testRoundtrip = instance.exports.test_roundtrip as (
      fd: number,
      ptr: number,
      len: number,
      outFd: number,
    ) => number;

    // Open fresh read fd (separate from write fd so position starts at 0)
    hostFsOpen(rPathPtr, rPathLen, 0, rFdOutPtr);
    const rFd = readI32LE(host, rFdOutPtr);

    // Write via WASM (uses host_fs_write), read back via WASM (uses host_fs_read)
    // test_roundtrip writes with rwFd, reads with rFd
    const bytesRead = testRoundtrip(rwFd, payloadPtr, payload.length, rFd);

    expect(bytesRead).toBe(payload.length);

    // Verify on Node side that the file contains the right bytes
    const diskBytes = nodeFs.readFileSync(writeFile);
    expect(Array.from(diskBytes.subarray(0, payload.length))).toEqual(Array.from(payload));

    hostFsClose(rwFd);
    hostFsClose(rFd);
    host.close();
  });
});
