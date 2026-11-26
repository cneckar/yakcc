// SPDX-License-Identifier: Apache-2.0
// Node's OpenSSL (#1367: vendor/node/deps/openssl, 3.5.9, linux-x86_64 no-asm as Node configures
// it: openssl.gyp, openssl_common.gypi and the generated headers of its config/archs), shaved from
// its C sources (each file a unit) over musl shaved to the leaves. Against Node's crypto module:
// digests (createHash, XOFs), HMAC (createHmac), ciphers (createCipheriv/createDecipheriv: CBC,
// CTR, GCM, ChaCha20-Poly1305 and their tags), pbkdf2Sync, hkdfSync and scryptSync give the same
// bytes.
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { shaveCFiles } from "./__fixtures__/c-files.js";
import { type Fn, hex, link } from "./__fixtures__/c-link.js";
import { shaveMusl, withMuslInit } from "./__fixtures__/c-musl.js";
import { createCMemory, createCSystem, shaveCUnit } from "./raise-c.js";

const hasClang = (() => {
  try {
    execFileSync("clang", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const OSSL = fileURLToPath(new URL("../vendor/node/deps/openssl/", import.meta.url));
const ARCH = join(OSSL, "config/archs/linux-x86_64/no-asm");
const FIXTURE = fileURLToPath(new URL("./__fixtures__/c/node-openssl.c", import.meta.url));
/** openssl.gyp, openssl_common.gypi, openssl_no_asm.gypi and the arch's openssl.gypi (Linux). */
const DEFINES = [
  "-DNDEBUG",
  "-DOPENSSL_USE_NODELETE",
  "-DL_ENDIAN",
  "-DOPENSSL_PIC",
  "-DOPENSSL_NO_ASM",
  "-DOPENSSL_NO_HW",
  "-DOPENSSL_API_COMPAT=0x10100001L",
  "-DOPENSSL_TLS_SECURITY_LEVEL=1",
  "-DSTATIC_LEGACY",
  '-DOPENSSLDIR="/etc/ssl"',
  '-DENGINESDIR="/dev/null"',
  '-DMODULESDIR="out/Release/obj.target/deps/openssl/lib/openssl-modules"',
  "-DTERMIOS",
];
const INCLUDES = [
  "openssl",
  "openssl/include",
  "openssl/crypto",
  "openssl/crypto/include",
  "openssl/crypto/modes",
  "openssl/crypto/ec/curve448",
  "openssl/crypto/ec/curve448/arch_32",
  "openssl/providers/common/include",
  "openssl/providers/fips/include",
  "openssl/providers/implementations/include",
  "config",
  "config/archs/linux-x86_64/no-asm",
  "config/archs/linux-x86_64/no-asm/include",
  "config/archs/linux-x86_64/no-asm/crypto",
  "config/archs/linux-x86_64/no-asm/crypto/include/internal",
  "config/archs/linux-x86_64/no-asm/providers/common/include",
].map((d) => `-I${join(OSSL, d)}`);
const ARGS = ["-std=gnu11", ...DEFINES, "-DOPENSSL_BUILDING_OPENSSL", ...INCLUDES];
const FIXTURE_ARGS = ["-std=gnu11", ...DEFINES, ...INCLUDES];
/** The arch's openssl.gypi's sources (paths from deps/openssl). */
const FILES = [
  ...readFileSync(join(ARCH, "openssl.gypi"), "utf8").matchAll(
    /'((?:openssl\/|\.\/config\/archs\/)[^']+\.c)'/g,
  ),
].map((m) => join(OSSL, (m[1] as string).replace(/^\.\//, "")));

const DIGESTS: [string, string, number?][] = [
  ["SHA256", "sha256"],
  ["SHA1", "sha1"],
  ["SHA512", "sha512"],
  ["SHA512-256", "sha512-256"],
  ["SHA3-256", "sha3-256"],
  ["SHA3-512", "sha3-512"],
  ["MD5", "md5"],
  ["BLAKE2b512", "blake2b512"],
  ["BLAKE2s256", "blake2s256"],
  ["SM3", "sm3"],
  ["RIPEMD160", "ripemd160"],
  ["SHAKE128", "shake128", 37],
  ["SHAKE256", "shake256", 64],
];
const CIPHERS: [string, string, number, number, number][] = [
  // OpenSSL's name, Node's, key length, IV length, tag length (0: no tag)
  ["AES-128-CBC", "aes-128-cbc", 16, 16, 0],
  ["AES-256-CBC", "aes-256-cbc", 32, 16, 0],
  ["AES-192-CTR", "aes-192-ctr", 24, 16, 0],
  ["AES-256-GCM", "aes-256-gcm", 32, 12, 16],
  ["AES-128-GCM", "aes-128-gcm", 16, 12, 16],
  ["ChaCha20-Poly1305", "chacha20-poly1305", 32, 12, 16],
];

describe.skipIf(!hasClang)("Node's OpenSSL, shaved from C, against node:crypto", () => {
  const fixture = shaveCUnit(
    FIXTURE,
    ["yk_digest", "yk_hmac", "yk_cipher", "yk_pbkdf2", "yk_hkdf", "yk_scrypt"],
    FIXTURE_ARGS,
    "clang",
    "node-openssl.c",
  );
  const roots = [...new Set([...fixture.atoms.values()].flatMap((a) => a.externals))];
  const ossl = shaveCFiles(FILES, roots, ARGS);
  const libc = [...new Set([...ossl.externals, ...roots])].filter(
    (x) => !fixture.atoms.has(x) && !ossl.atoms.has(x),
  );
  const musl = withMuslInit(shaveMusl(libc));

  it("OpenSSL shaves with no refusal, its C library down to the leaves", () => {
    expect([...fixture.refused]).toEqual([]);
    expect(ossl.refused.slice(0, 60)).toEqual([]);
    expect(musl.refused).toEqual([]);
    expect(musl.missing).toEqual([]);
  });

  it("digests, HMACs, ciphers and key derivations equal Node's crypto (as raised)", () => {
    const memory = createCMemory();
    const system = createCSystem(memory);
    const env = link(
      new Map([...musl.atoms, ...ossl.atoms, ...fixture.atoms]),
      false,
      memory,
      [...musl.units, ...ossl.units, fixture],
      system.leaves as unknown as Record<string, Fn>,
    );
    env.yk_musl_init?.();
    const L = memory.leaves;
    const out = L.__ykAlloc(1 << 16, 16);
    const W = (n: number): bigint => BigInt(n);
    const str = (s: string): number => memory.put([...Buffer.from(`${s}\0`, "latin1")]);
    const buf = (b: Uint8Array | number[]): number => memory.put(b.length > 0 ? [...b] : [0]);
    const get = (n: number): string => (n > 0 ? hex(memory.get(out, n)) : String(n));
    const call = (f: string, ...a: unknown[]): number => Number((env[f] as Fn)(...a));
    const bad: string[] = [];
    const check = (label: string, shaved: () => string, node: () => string): void => {
      let g: string;
      try {
        g = shaved();
      } catch (e) {
        g = `trap: ${(e as Error).message}`;
      }
      const w = node();
      if (g !== w) bad.push(`${label}\n  shaved ${g.slice(0, 200)}\n  Node   ${w.slice(0, 200)}`);
    };
    const data = fc.sample(fc.uint8Array({ maxLength: 300 }), { numRuns: 6, seed: 1367 });
    for (const d of [new Uint8Array(0), Buffer.from("abc"), ...data])
      for (const [o, n, xof] of DIGESTS)
        check(
          `${o} of ${d.length} bytes`,
          () => get(call("yk_digest", str(o), buf(d), W(d.length), W(xof ?? 0), out)),
          () =>
            crypto
              .createHash(n, xof === undefined ? {} : { outputLength: xof })
              .update(d)
              .digest("hex"),
        );
    for (const [md, n] of [
      ["SHA256", "sha256"],
      ["SHA512", "sha512"],
      ["SHA3-256", "sha3-256"],
    ] as const)
      for (const [k, d] of fc.sample(
        fc.tuple(fc.uint8Array({ maxLength: 200 }), fc.uint8Array({ maxLength: 200 })),
        { numRuns: 4, seed: 7 },
      ))
        check(
          `HMAC-${md} key ${k.length} data ${d.length}`,
          () => get(call("yk_hmac", str(md), buf(k), W(k.length), buf(d), W(d.length), out)),
          () => crypto.createHmac(n, k).update(d).digest("hex"),
        );
    for (const [o, n, kl, ivl, tl] of CIPHERS)
      for (const [key, iv, aad, pt] of fc.sample(
        fc.tuple(
          fc.uint8Array({ minLength: kl, maxLength: kl }),
          fc.uint8Array({ minLength: ivl, maxLength: ivl }),
          fc.uint8Array({ maxLength: 40 }),
          fc.uint8Array({ maxLength: 200 }),
        ),
        { numRuns: 4, seed: kl * 31 + ivl },
      )) {
        const node = (): Buffer => {
          const c = crypto.createCipheriv(
            n,
            key,
            iv,
            (tl > 0 ? { authTagLength: tl } : {}) as never,
          ) as crypto.CipherGCM;
          if (tl > 0 && aad.length > 0) c.setAAD(aad, { plaintextLength: pt.length });
          const ct = Buffer.concat([c.update(pt), c.final()]);
          return tl > 0 ? Buffer.concat([ct, c.getAuthTag()]) : ct;
        };
        check(
          `${o} encrypt ${pt.length} bytes, aad ${aad.length}`,
          () =>
            get(
              call(
                "yk_cipher",
                str(o),
                buf(key),
                buf(iv),
                W(ivl),
                buf(aad),
                W(tl > 0 ? aad.length : 0),
                buf(pt),
                W(pt.length),
                1,
                W(tl),
                0,
                out,
              ),
            ),
          () => node().toString("hex"),
        );
        // And back: the ciphertext (its tag after it) decrypted.
        const ct = node();
        const body = tl > 0 ? ct.subarray(0, ct.length - tl) : ct;
        const tag = tl > 0 ? ct.subarray(ct.length - tl) : Buffer.alloc(0);
        check(
          `${o} decrypt ${body.length} bytes`,
          () =>
            get(
              call(
                "yk_cipher",
                str(o),
                buf(key),
                buf(iv),
                W(ivl),
                buf(aad),
                W(tl > 0 ? aad.length : 0),
                buf(body),
                W(body.length),
                0,
                W(tl),
                buf(tag),
                out,
              ),
            ),
          () =>
            // (The plaintext back; none, 0 bytes.)
            pt.length > 0 ? Buffer.from(pt).toString("hex") : "0",
        );
      }
    for (const [pw, salt, iter, len] of [
      ["password", "salt", 1, 32],
      ["", "NaCl", 1000, 64],
      ["pässwörd", "", 37, 17],
    ] as const)
      for (const [md, n] of [
        ["SHA256", "sha256"],
        ["SHA512", "sha512"],
        ["SHA1", "sha1"],
      ] as const)
        check(
          `PBKDF2-${md} ${iter}`,
          () =>
            get(
              call(
                "yk_pbkdf2",
                str(pw),
                W(Buffer.byteLength(pw, "latin1")),
                buf(Buffer.from(salt, "latin1")),
                W(Buffer.byteLength(salt, "latin1")),
                W(iter),
                str(md),
                W(len),
                out,
              ),
            ),
          () =>
            crypto
              .pbkdf2Sync(Buffer.from(pw, "latin1"), Buffer.from(salt, "latin1"), iter, len, n)
              .toString("hex"),
        );
    for (const [k, s, i, len] of fc.sample(
      fc.tuple(
        fc.uint8Array({ minLength: 1, maxLength: 80 }),
        fc.uint8Array({ maxLength: 40 }),
        fc.uint8Array({ maxLength: 40 }),
        fc.integer({ min: 1, max: 200 }),
      ),
      { numRuns: 4, seed: 11 },
    ))
      check(
        `HKDF-SHA256 ${len}`,
        () =>
          get(
            call(
              "yk_hkdf",
              str("SHA256"),
              buf(k),
              W(k.length),
              buf(s),
              W(s.length),
              buf(i),
              W(i.length),
              W(len),
              out,
            ),
          ),
        () => Buffer.from(crypto.hkdfSync("sha256", k, s, i, len)).toString("hex"),
      );
    for (const [pw, salt, N, r, p, len] of [
      ["password", "NaCl", 16, 1, 1, 64],
      ["", "", 32, 2, 2, 32],
    ] as const)
      check(
        `scrypt N=${N} r=${r} p=${p}`,
        () =>
          get(
            call(
              "yk_scrypt",
              str(pw),
              W(pw.length),
              buf(Buffer.from(salt)),
              W(salt.length),
              W(N),
              W(r),
              W(p),
              W(len),
              out,
            ),
          ),
        () => crypto.scryptSync(pw, salt, len, { N, r, p }).toString("hex"),
      );
    expect(bad.slice(0, 8)).toEqual([]);
  }, 7_200_000);
});
