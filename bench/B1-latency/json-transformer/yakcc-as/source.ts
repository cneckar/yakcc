// SPDX-License-Identifier: MIT
//
// bench/B1-latency/json-transformer/yakcc-as/source.ts
//
// @decision DEC-BENCH-B1-JSON-AS-SOURCE-001
// @title Sum-of-numeric-leaves kernel in flat-memory AssemblyScript (--runtime stub)
// @status accepted
// @rationale
//   The AS-backend is constrained to --runtime stub: no GC, no managed strings,
//   no heap allocation. The camelCase key transform (Slice 2's primary candidate)
//   requires managed string operations incompatible with this constraint.
//   See DEC-AS-JSON-STRATEGY-001 in as-backend.ts for the full probe results.
//
//   Fallback chosen: sum-of-all-numeric-leaves via DFS over a pre-serialized
//   binary tagged-union format. The host (run.mjs) pre-parses JSON and writes
//   a flat binary tree into WASM linear memory. This kernel reads the tree and
//   returns the f64 sum of all numeric leaf values.
//
// Binary tagged-union format (written by host, read by WASM):
//
//   The tree is serialized as a sequence of tagged-union records in a flat byte array.
//   Each record starts with a 1-byte tag:
//
//     TAG_NUMBER  = 1  — followed by 8 bytes (f64 little-endian)
//     TAG_STRING  = 2  — followed by 4 bytes (u32 LE) length, then N bytes of UTF-8
//                        (strings are present but not summed; they are skipped)
//     TAG_BOOL    = 3  — followed by 1 byte (0 or 1)
//     TAG_NULL    = 4  — no payload
//     TAG_ARRAY   = 5  — followed by 4 bytes (u32 LE) item count, then that many records
//     TAG_OBJECT  = 6  — followed by 4 bytes (u32 LE) key-value pair count, then:
//                        for each pair: key record (always TAG_STRING), then value record
//
//   This format is a depth-first pre-order serialization: reading the buffer linearly
//   corresponds to a DFS pre-order traversal of the original tree.
//
// Memory layout:
//   TREE_BASE_PTR = 65536  (page 1 start — host writes binary tree here)
//   OUT_PTR       = 32     (4 bytes of page 0 — f64 result written here by kernel)
//
//   Maximum tree size: limited by WASM memory. run.mjs allocates enough pages
//   to hold the entire binary tree representation (typically 120-160MB for 100MB JSON).
//
// The exported function:
//   sumNumericLeaves(treePtr: i32, byteLen: i32): f64
//     Reads the binary tree at treePtr (must be TREE_BASE_PTR),
//     returns the sum of all numeric leaf values.

// Tag constants (must match run.mjs serializer)
const TAG_NUMBER: u8 = 1;
const TAG_STRING: u8 = 2;
const TAG_BOOL: u8 = 3;
const TAG_NULL: u8 = 4;
const TAG_ARRAY: u8 = 5;
const TAG_OBJECT: u8 = 6;

// ---------------------------------------------------------------------------
// DFS traversal — reads flat binary tree, returns f64 sum of all numbers
// ---------------------------------------------------------------------------
//
// offset is passed by reference via a pointer into WASM memory (OUT_PTR = 32,
// which we repurpose as a cursor during traversal, then overwrite with result).
// However AssemblyScript --runtime stub has no pass-by-ref for local vars.
// We use a global mutable cursor instead.

let cursor: i32 = 0;

function readU8(): u8 {
  const v: u8 = load<u8>(cursor);
  cursor += 1;
  return v;
}

function readU32LE(): u32 {
  const v: u32 = load<u32>(cursor);  // little-endian native on WASM
  cursor += 4;
  return v;
}

function readF64LE(): f64 {
  const v: f64 = load<f64>(cursor);  // little-endian native on WASM
  cursor += 8;
  return v;
}

function skipBytes(n: i32): void {
  cursor += n;
}

function dfsSum(): f64 {
  const tag: u8 = readU8();

  if (tag == TAG_NUMBER) {
    return readF64LE();
  }

  if (tag == TAG_STRING) {
    const len: u32 = readU32LE();
    skipBytes(len as i32);
    return 0.0;
  }

  if (tag == TAG_BOOL) {
    skipBytes(1);
    return 0.0;
  }

  if (tag == TAG_NULL) {
    return 0.0;
  }

  if (tag == TAG_ARRAY) {
    const count: u32 = readU32LE();
    let sum: f64 = 0.0;
    for (let i: u32 = 0; i < count; i++) {
      sum += dfsSum();
    }
    return sum;
  }

  if (tag == TAG_OBJECT) {
    const count: u32 = readU32LE();
    let sum: f64 = 0.0;
    for (let i: u32 = 0; i < count; i++) {
      // key: always a TAG_STRING — skip it
      dfsSum();
      // value: any tag
      sum += dfsSum();
    }
    return sum;
  }

  // Unknown tag: stop traversal (should not happen if host serializer is correct)
  return 0.0;
}

// ---------------------------------------------------------------------------
// Exported entry: sumNumericLeaves(treePtr, byteLen) -> f64
// ---------------------------------------------------------------------------

export function sumNumericLeaves(treePtr: i32, _byteLen: i32): f64 {
  cursor = treePtr;
  return dfsSum();
}
