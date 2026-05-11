// SPDX-License-Identifier: MIT
//
// bench/B1-latency/integer-math/yakcc-as/source.ts
//
// @decision DEC-BENCH-B1-AS-SOURCE-001
// @title SHA-256 kernel written in flat-memory AssemblyScript for yakcc AS-backend
// @status accepted
// @rationale
//   SHA-256 is implemented using only WASM intrinsics compatible with --runtime stub:
//     - load<u32>() / store<u32>(): 32-bit word reads/writes into linear memory
//     - u32 arithmetic: addition (wrapping), XOR, AND, NOT, bit rotations via shifts
//     - No managed types, no GC, no closures, no managed strings or arrays
//   This satisfies the flat-memory protocol documented in as-backend.ts under
//   DEC-AS-ARRAYS-STRATEGY-001 and DEC-AS-STRINGS-STRATEGY-001.
//
//   Memory layout (must match run.mjs host):
//     DATA_BASE_PTR = 65536          (page 1 start — input buffer written here by host)
//     100MB corpus ends at: 65536 + 104857600 = 104923136 (page 1601.something)
//     Safe working area starts at page 1602: 1602 * 65536 = 104988672
//
//     W_PTR        = 104988672       (page 1602 — 64-word message schedule: 256 bytes)
//     OUT_PTR      = 104988928       (W_PTR + 256 — digest output: 32 bytes = 8 x u32)
//     K_PTR        = 104989184       (OUT_PTR + 256 — SHA-256 K constants: 256 bytes)
//     SCRATCH_PTR  = 104989440       (K_PTR + 256 — padding scratch: 128 bytes)
//
//   Total working area: 896 bytes (fits in page 1602, well clear of corpus)
//   Required memory: 1603 pages minimum. run.mjs uses --initialMemory 1700 for headroom.
//
//   The host (run.mjs):
//     1. Instantiates with --initialMemory 1700 (pages) to fit 100MB input + scratch
//     2. Copies the 100MB corpus buffer into WASM memory at DATA_BASE_PTR
//     3. Calls sha256(DATA_BASE_PTR, byteLength) repeatedly
//     4. Result digest is at OUT_PTR (not verified per iteration for timing purity)
//
//   SHA-256 algorithm follows FIPS 180-4 exactly using flat-memory scratch for
//   the 64-word message schedule (W[0..63]) and 8 working variables (a-h).
//   All arithmetic is 32-bit unsigned (u32) — wrapping on overflow as per spec.

// ---------------------------------------------------------------------------
// SHA-256 constants (first 32 bits of fractional parts of cube roots of first 64 primes)
// ---------------------------------------------------------------------------

// Working area starts at page 1602 (safely after 100MB corpus which ends at page ~1602)
// Page 1602 start = 1602 * 65536 = 104988672
// W_PTR = 104988672   (64-word message schedule, 256 bytes)
// OUT_PTR = 104988928 (W_PTR + 256, digest output 32 bytes)
// K_PTR = 104989184   (OUT_PTR + 256, K constants 256 bytes)
const K_PTR: i32 = 104989184;

function initK(): void {
  store<u32>(K_PTR + 0 * 4, 0x428a2f98);
  store<u32>(K_PTR + 1 * 4, 0x71374491);
  store<u32>(K_PTR + 2 * 4, 0xb5c0fbcf);
  store<u32>(K_PTR + 3 * 4, 0xe9b5dba5);
  store<u32>(K_PTR + 4 * 4, 0x3956c25b);
  store<u32>(K_PTR + 5 * 4, 0x59f111f1);
  store<u32>(K_PTR + 6 * 4, 0x923f82a4);
  store<u32>(K_PTR + 7 * 4, 0xab1c5ed5);
  store<u32>(K_PTR + 8 * 4, 0xd807aa98);
  store<u32>(K_PTR + 9 * 4, 0x12835b01);
  store<u32>(K_PTR + 10 * 4, 0x243185be);
  store<u32>(K_PTR + 11 * 4, 0x550c7dc3);
  store<u32>(K_PTR + 12 * 4, 0x72be5d74);
  store<u32>(K_PTR + 13 * 4, 0x80deb1fe);
  store<u32>(K_PTR + 14 * 4, 0x9bdc06a7);
  store<u32>(K_PTR + 15 * 4, 0xc19bf174);
  store<u32>(K_PTR + 16 * 4, 0xe49b69c1);
  store<u32>(K_PTR + 17 * 4, 0xefbe4786);
  store<u32>(K_PTR + 18 * 4, 0x0fc19dc6);
  store<u32>(K_PTR + 19 * 4, 0x240ca1cc);
  store<u32>(K_PTR + 20 * 4, 0x2de92c6f);
  store<u32>(K_PTR + 21 * 4, 0x4a7484aa);
  store<u32>(K_PTR + 22 * 4, 0x5cb0a9dc);
  store<u32>(K_PTR + 23 * 4, 0x76f988da);
  store<u32>(K_PTR + 24 * 4, 0x983e5152);
  store<u32>(K_PTR + 25 * 4, 0xa831c66d);
  store<u32>(K_PTR + 26 * 4, 0xb00327c8);
  store<u32>(K_PTR + 27 * 4, 0xbf597fc7);
  store<u32>(K_PTR + 28 * 4, 0xc6e00bf3);
  store<u32>(K_PTR + 29 * 4, 0xd5a79147);
  store<u32>(K_PTR + 30 * 4, 0x06ca6351);
  store<u32>(K_PTR + 31 * 4, 0x14292967);
  store<u32>(K_PTR + 32 * 4, 0x27b70a85);
  store<u32>(K_PTR + 33 * 4, 0x2e1b2138);
  store<u32>(K_PTR + 34 * 4, 0x4d2c6dfc);
  store<u32>(K_PTR + 35 * 4, 0x53380d13);
  store<u32>(K_PTR + 36 * 4, 0x650a7354);
  store<u32>(K_PTR + 37 * 4, 0x766a0abb);
  store<u32>(K_PTR + 38 * 4, 0x81c2c92e);
  store<u32>(K_PTR + 39 * 4, 0x92722c85);
  store<u32>(K_PTR + 40 * 4, 0xa2bfe8a1);
  store<u32>(K_PTR + 41 * 4, 0xa81a664b);
  store<u32>(K_PTR + 42 * 4, 0xc24b8b70);
  store<u32>(K_PTR + 43 * 4, 0xc76c51a3);
  store<u32>(K_PTR + 44 * 4, 0xd192e819);
  store<u32>(K_PTR + 45 * 4, 0xd6990624);
  store<u32>(K_PTR + 46 * 4, 0xf40e3585);
  store<u32>(K_PTR + 47 * 4, 0x106aa070);
  store<u32>(K_PTR + 48 * 4, 0x19a4c116);
  store<u32>(K_PTR + 49 * 4, 0x1e376c08);
  store<u32>(K_PTR + 50 * 4, 0x2748774c);
  store<u32>(K_PTR + 51 * 4, 0x34b0bcb5);
  store<u32>(K_PTR + 52 * 4, 0x391c0cb3);
  store<u32>(K_PTR + 53 * 4, 0x4ed8aa4a);
  store<u32>(K_PTR + 54 * 4, 0x5b9cca4f);
  store<u32>(K_PTR + 55 * 4, 0x682e6ff3);
  store<u32>(K_PTR + 56 * 4, 0x748f82ee);
  store<u32>(K_PTR + 57 * 4, 0x78a5636f);
  store<u32>(K_PTR + 58 * 4, 0x84c87814);
  store<u32>(K_PTR + 59 * 4, 0x8cc70208);
  store<u32>(K_PTR + 60 * 4, 0x90befffa);
  store<u32>(K_PTR + 61 * 4, 0xa4506ceb);
  store<u32>(K_PTR + 62 * 4, 0xbef9a3f7);
  store<u32>(K_PTR + 63 * 4, 0xc67178f2);
}

// W scratch: 64 x u32 = 256 bytes at page 1602 start
const W_PTR: i32 = 104988672;  // 1602 * 65536
// Output digest: 8 x u32 = 32 bytes, placed after W scratch
const OUT_PTR: i32 = 104988928; // W_PTR + 256

// ---------------------------------------------------------------------------
// Inline 32-bit rotation
// ---------------------------------------------------------------------------

// @ts-ignore: asc rotr built-in
function rotr32(x: u32, n: u32): u32 {
  return (x >>> n) | (x << (32 - n));
}

// ---------------------------------------------------------------------------
// SHA-256: process one 64-byte (512-bit) block
//
// block_ptr: pointer to the 64-byte input block in WASM linear memory
// h0..h7: current hash state (passed by value, returned via OUT_PTR update)
// ---------------------------------------------------------------------------

function processBlock(
  block_ptr: i32,
  h0: u32, h1: u32, h2: u32, h3: u32,
  h4: u32, h5: u32, h6: u32, h7: u32,
): void {
  // Build W[0..15] from big-endian block bytes
  for (let i: i32 = 0; i < 16; i++) {
    const bp: i32 = block_ptr + i * 4;
    const w: u32 =
      (load<u8>(bp + 0) as u32) << 24 |
      (load<u8>(bp + 1) as u32) << 16 |
      (load<u8>(bp + 2) as u32) << 8  |
      (load<u8>(bp + 3) as u32);
    store<u32>(W_PTR + i * 4, w);
  }

  // Extend W[16..63]
  for (let i: i32 = 16; i < 64; i++) {
    const w15: u32 = load<u32>(W_PTR + (i - 15) * 4);
    const w2:  u32 = load<u32>(W_PTR + (i -  2) * 4);
    const s0: u32 = rotr32(w15, 7) ^ rotr32(w15, 18) ^ (w15 >>> 3);
    const s1: u32 = rotr32(w2, 17) ^ rotr32(w2,  19) ^ (w2  >>> 10);
    const w16: u32 = load<u32>(W_PTR + (i - 16) * 4);
    const w7:  u32 = load<u32>(W_PTR + (i -  7) * 4);
    store<u32>(W_PTR + i * 4, w16 + s0 + w7 + s1);
  }

  // Compression
  let a: u32 = h0;
  let b: u32 = h1;
  let c: u32 = h2;
  let d: u32 = h3;
  let e: u32 = h4;
  let f: u32 = h5;
  let g: u32 = h6;
  let h: u32 = h7;

  for (let i: i32 = 0; i < 64; i++) {
    const S1: u32 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
    const ch: u32 = (e & f) ^ (~e & g);
    const temp1: u32 = h + S1 + ch + load<u32>(K_PTR + i * 4) + load<u32>(W_PTR + i * 4);
    const S0: u32 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
    const maj: u32 = (a & b) ^ (a & c) ^ (b & c);
    const temp2: u32 = S0 + maj;

    h = g;
    g = f;
    f = e;
    e = d + temp1;
    d = c;
    c = b;
    b = a;
    a = temp1 + temp2;
  }

  // Write updated hash state to OUT_PTR
  store<u32>(OUT_PTR + 0 * 4, h0 + a);
  store<u32>(OUT_PTR + 1 * 4, h1 + b);
  store<u32>(OUT_PTR + 2 * 4, h2 + c);
  store<u32>(OUT_PTR + 3 * 4, h3 + d);
  store<u32>(OUT_PTR + 4 * 4, h4 + e);
  store<u32>(OUT_PTR + 5 * 4, h5 + f);
  store<u32>(OUT_PTR + 6 * 4, h6 + g);
  store<u32>(OUT_PTR + 7 * 4, h7 + h);
}

// ---------------------------------------------------------------------------
// Exported entry: sha256(data_ptr, byte_len) — FIPS 180-4 compliant
//
// data_ptr: pointer to input bytes in WASM linear memory
// byte_len: number of input bytes
// Returns: 0 (digest written to OUT_PTR as 8 x u32 big-endian)
// ---------------------------------------------------------------------------

export function sha256(data_ptr: i32, byte_len: i32): i32 {
  initK();

  // Initial hash values (first 32 bits of fractional parts of sqrt of first 8 primes)
  let h0: u32 = 0x6a09e667;
  let h1: u32 = 0xbb67ae85;
  let h2: u32 = 0x3c6ef372;
  let h3: u32 = 0xa54ff53a;
  let h4: u32 = 0x510e527f;
  let h5: u32 = 0x9b05688c;
  let h6: u32 = 0x1f83d9ab;
  let h7: u32 = 0x5be0cd19;

  // Pre-padding scratch: we pad in place after the message.
  // The padded message length is: original_len + 1 (0x80) + zero_bytes + 8 (length)
  // padded up to a multiple of 64 bytes.
  //
  // We process all full 64-byte blocks from the input first, then handle
  // the final partial block + padding in a 128-byte scratch buffer.
  //
  // Scratch area: K_PTR + 256 bytes (K constants) = 104989184 + 256 = 104989440
  // This is safely after the corpus end (104923136) and K constants.
  const SCRATCH_PTR: i32 = 104989440; // K_PTR + 256

  const full_blocks: i32 = byte_len >> 6; // byte_len / 64
  const remainder: i32 = byte_len & 63;   // byte_len % 64

  // Process full blocks
  for (let blk: i32 = 0; blk < full_blocks; blk++) {
    processBlock(data_ptr + blk * 64, h0, h1, h2, h3, h4, h5, h6, h7);
    // Read updated state back from OUT_PTR for next block
    h0 = load<u32>(OUT_PTR + 0 * 4);
    h1 = load<u32>(OUT_PTR + 1 * 4);
    h2 = load<u32>(OUT_PTR + 2 * 4);
    h3 = load<u32>(OUT_PTR + 3 * 4);
    h4 = load<u32>(OUT_PTR + 4 * 4);
    h5 = load<u32>(OUT_PTR + 5 * 4);
    h6 = load<u32>(OUT_PTR + 6 * 4);
    h7 = load<u32>(OUT_PTR + 7 * 4);
  }

  // Copy remainder into scratch and apply SHA-256 padding
  const remainder_src: i32 = data_ptr + full_blocks * 64;
  for (let i: i32 = 0; i < remainder; i++) {
    store<u8>(SCRATCH_PTR + i, load<u8>(remainder_src + i));
  }
  // Append 0x80 bit
  store<u8>(SCRATCH_PTR + remainder, 0x80);
  // Zero remaining bytes up to padding
  let pad_end: i32 = remainder + 1;
  while (pad_end < 128) {
    store<u8>(SCRATCH_PTR + pad_end, 0);
    pad_end++;
  }

  // If remainder < 56, the length fits in one final block (64 bytes).
  // If remainder >= 56, we need two final blocks (128 bytes).
  const blocks_needed: i32 = (remainder < 56) ? 1 : 2;
  const len_block_offset: i32 = (blocks_needed - 1) * 64;

  // Write 64-bit big-endian bit length at offset (len_block_offset + 56)
  // bit_len = byte_len * 8 (as 64-bit big-endian)
  // For 100MB: byte_len = 104857600, bit_len = 838860800 (fits in u32 high word = 0)
  const bit_len_lo: u32 = (byte_len as u32) << 3;
  const bit_len_hi: u32 = (byte_len as u32) >>> 29; // high bits of *8
  store<u8>(SCRATCH_PTR + len_block_offset + 56, (bit_len_hi >>> 24) as u8);
  store<u8>(SCRATCH_PTR + len_block_offset + 57, (bit_len_hi >>> 16) as u8);
  store<u8>(SCRATCH_PTR + len_block_offset + 58, (bit_len_hi >>>  8) as u8);
  store<u8>(SCRATCH_PTR + len_block_offset + 59, (bit_len_hi       ) as u8);
  store<u8>(SCRATCH_PTR + len_block_offset + 60, (bit_len_lo >>> 24) as u8);
  store<u8>(SCRATCH_PTR + len_block_offset + 61, (bit_len_lo >>> 16) as u8);
  store<u8>(SCRATCH_PTR + len_block_offset + 62, (bit_len_lo >>>  8) as u8);
  store<u8>(SCRATCH_PTR + len_block_offset + 63, (bit_len_lo       ) as u8);

  // Process final block(s)
  for (let blk: i32 = 0; blk < blocks_needed; blk++) {
    processBlock(SCRATCH_PTR + blk * 64, h0, h1, h2, h3, h4, h5, h6, h7);
    h0 = load<u32>(OUT_PTR + 0 * 4);
    h1 = load<u32>(OUT_PTR + 1 * 4);
    h2 = load<u32>(OUT_PTR + 2 * 4);
    h3 = load<u32>(OUT_PTR + 3 * 4);
    h4 = load<u32>(OUT_PTR + 4 * 4);
    h5 = load<u32>(OUT_PTR + 5 * 4);
    h6 = load<u32>(OUT_PTR + 6 * 4);
    h7 = load<u32>(OUT_PTR + 7 * 4);
  }

  return 0;
}
