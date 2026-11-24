// SPDX-License-Identifier: MIT
// B16's new tasks (B14's 13 are imported in tasks.mjs). Same shape as B14's tasks, plus:
//   family     the task family (results are reported per family)
//   inputs     argument lists whose expected values are computed from the reference (lib + glue)
//              at build time (harness/build-cases.mjs); never shown to a model
//   gen(rng)   optional: more argument lists from a seeded generator (fuzz)
//   vectors    published known answers ({args, returns}, with their source), asserted against the
//              reference at build time so a reference bug cannot become the expected value
// Every spec states the behavior from the standard (and the module's stated choices where the
// standard leaves one), never from the module's code.

const hex = (rng, n) => Array.from({ length: n }, () => "0123456789abcdef"[rng.int(16)]).join("");
const pick = (rng, xs) => xs[rng.int(xs.length)];
const str = (rng, alphabet, min, max) =>
  Array.from({ length: min + rng.int(max - min + 1) }, () => pick(rng, alphabet)).join("");
const TEXT = [..."abcxyzABC 019 -_.~/é漢😀\n\t\"'"];
const version = (rng) => {
  const core = `${rng.int(4)}.${rng.int(12)}.${rng.int(12)}`;
  return rng.int(3) === 0 ? `${core}-${pick(rng, ["alpha", "beta", "rc"])}.${rng.int(12)}` : core;
};
const range = (rng) =>
  pick(rng, [
    () => `^${version(rng)}`,
    () => `~${version(rng)}`,
    () => `>=${version(rng)} <${version(rng)}`,
    () => `${rng.int(4)}.x`,
    () => `${version(rng)} - ${version(rng)}`,
    () => `^${version(rng)} || ~${version(rng)}`,
    () => `>${version(rng)}`,
    () => "*",
  ])();

export const newTasks = [
  // ---------------------------------------------------------------- semver
  {
    id: "ranges-overlap",
    family: "versioning",
    lib: { file: "semver-7.8.0/ranges/intersects.js", name: "intersects" },
    spec: "Write `export function solve(a: string, b: string): boolean` that returns true when some version satisfies both npm semver range expressions `a` and `b`. Use npm range semantics: caret, tilde and x-ranges, hyphen ranges, space-separated comparator sets (all must hold) and `||` alternatives (any may hold). Prerelease versions are not considered unless a range names one.",
    referenceGlue: "export function solve(a: string, b: string) { return lib.intersects(a, b); }",
    vectors: [
      { args: ["^1.2.0", "~1.3.5"], returns: true, source: "npm semver docs" },
      { args: [">=2.0.0", "<1.0.0"], returns: false, source: "npm semver docs" },
    ],
    inputs: [
      ["1.x", "^1.9 || ^3"],
      [">1.0.0 <1.0.1", "1.0.0"],
      ["^0.2.3", "0.3.x"],
      ["~0.0.1", "0.0.x"],
      ["1.2.3 - 2.3.4", ">=2.3.4"],
      ["1.2.3 - 2.3.4", ">2.3.4"],
      ["*", "<0.0.1"],
      ["<1.0.0", ">=0.9.9"],
    ],
    gen: (rng) => Array.from({ length: 30 }, () => [range(rng), range(rng)]),
  },
  {
    id: "lowest-allowed-version",
    family: "versioning",
    lib: { file: "semver-7.8.0/ranges/min-version.js", name: "minVersion" },
    spec: "Write `export function solve(range: string): string | null` that returns the lowest version (as `major.minor.patch` with any prerelease suffix) that satisfies the npm semver range expression `range`, or null when no version does or the range is invalid. Use npm range semantics (caret, tilde, x-ranges, hyphen ranges, comparator sets, `||` alternatives). `0.0.0` is the lowest version; a prerelease version is a candidate only when the range names a prerelease on that same major.minor.patch; `>x.y.z` is satisfied first by `x.y.(z+1)`.",
    referenceGlue:
      "export function solve(range: string) { try { const v = lib.minVersion(range); return v ? v.version : null; } catch (e) { return null; } }",
    inputs: [
      [">=1.2.3 <2"],
      ["^0.0.1"],
      [">1.2.3"],
      ["<1"],
      [">=1.0.0-beta"],
      [">1.0.0-beta.2"],
      ["^1.2.3 || ^0.5"],
      [">2.0.0 <2.0.1"],
      ["1.x"],
      ["*"],
      ["not a range"],
    ],
    gen: (rng) => Array.from({ length: 30 }, () => [range(rng)]),
  },
  {
    id: "coerce-version",
    family: "versioning",
    lib: { file: "semver-7.8.0/functions/coerce.js", name: "coerce" },
    spec: "Write `export function solve(text: string): string | null` that finds the first version-like run in `text` and returns it as a full `major.minor.patch` string, or null if there is none. A version-like run is one to three dot-separated runs of digits (each at most 16 digits); missing minor or patch become 0, anything after the third number is ignored, and prerelease or build suffixes are dropped. Examples: `v2` gives `2.0.0`, `1.2.3.4` gives `1.2.3`, `version 3.4 beta` gives `3.4.0`.",
    referenceGlue:
      "export function solve(text: string) { const v = lib.coerce(text); return v ? v.version : null; }",
    inputs: [
      ["v2"],
      ["1.2.3.4"],
      ["version 3.4 beta"],
      ["abc"],
      ["release-10.20"],
      ["0.0.0"],
      ["12345678901234567.1.1"],
      ["x1y2z"],
      ["2024.06.30-hotfix"],
      [""],
    ],
    gen: (rng) => Array.from({ length: 25 }, () => [str(rng, [..."v0123456789.. -abx"], 0, 14)]),
  },
  {
    id: "bump-version",
    family: "versioning",
    lib: { file: "semver-7.8.0/functions/inc.js", name: "inc" },
    spec: "Write `export function solve(version: string, kind: 'major' | 'minor' | 'patch' | 'premajor' | 'preminor' | 'prepatch' | 'prerelease', id?: string): string | null` that returns the next semver version, or null if `version` is not a valid version. `major`/`minor`/`patch` bump that part and zero the lower parts; bumping a prerelease with `patch` (or `minor`/`major` when the lower parts are already zero) releases it (`1.2.3-beta.1` patch gives `1.2.3`). `premajor`/`preminor`/`prepatch` bump that part and add a prerelease `<id>.0` (or `0` with no id). `prerelease` on a release bumps the patch and adds `<id>.0`; on a prerelease with the same id it increments the last numeric part; with a different id it switches to `<id>.0` on the same major.minor.patch.",
    referenceGlue:
      "export function solve(version: string, kind: any, id?: string) { return lib.inc(version, kind, id); }",
    inputs: [
      ["1.2.3", "minor"],
      ["1.2.3", "prerelease", "beta"],
      ["1.2.3-beta.1", "prerelease", "beta"],
      ["1.2.3-alpha.1", "prerelease", "beta"],
      ["1.2.3-beta.1", "patch"],
      ["1.2.3", "premajor", "rc"],
      ["x", "major"],
      ["1.0.0-rc.1", "major"],
      ["1.1.0-rc.1", "major"],
      ["0.0.1", "preminor"],
      ["1.2.3-4", "prerelease"],
    ],
    gen: (rng) =>
      Array.from({ length: 30 }, () => [
        version(rng),
        pick(rng, ["major", "minor", "patch", "premajor", "preminor", "prepatch", "prerelease"]),
        pick(rng, ["alpha", "beta", "rc"]),
      ]),
  },
  {
    id: "version-change-kind",
    family: "versioning",
    lib: { file: "semver-7.8.0/functions/diff.js", name: "diff" },
    spec: "Write `export function solve(a: string, b: string): string | null` that classifies the change between two valid semver versions: null when they are equal (ignoring build metadata), else one of `major`, `minor`, `patch`, `premajor`, `preminor`, `prepatch`, `prerelease`. Compare the lower and higher of the two. If the lower is a prerelease and the higher is a release, the change is the highest part that differs between the lower's core and the higher's core, except that when the lower's minor and patch are 0 and only the major changed (or the cores are equal) it is `major` (or `patch`/`minor` by the same rule for those parts). If the higher is a prerelease, prefix `pre` to the highest differing core part, or answer `prerelease` when the cores are equal.",
    referenceGlue: "export function solve(a: string, b: string) { return lib.diff(a, b); }",
    vectors: [
      { args: ["1.2.3", "1.3.0"], returns: "minor", source: "npm semver docs" },
      { args: ["1.2.3", "1.2.3"], returns: null, source: "npm semver docs" },
    ],
    inputs: [
      ["1.2.3-beta.1", "1.2.3"],
      ["1.2.3", "2.0.0-rc.1"],
      ["1.0.0", "1.0.0-beta"],
      ["1.0.0-alpha", "2.0.0"],
      ["1.1.0-alpha", "1.1.0"],
      ["1.2.3-alpha.1", "1.2.3-alpha.2"],
      ["2.0.0", "1.9.9"],
      ["1.2.3+build1", "1.2.3+build2"],
    ],
    gen: (rng) => Array.from({ length: 30 }, () => [version(rng), version(rng)]),
  },
  {
    id: "sort-versions",
    family: "versioning",
    lib: { file: "semver-7.8.0/functions/sort.js", name: "sort" },
    spec: "Write `export function solve(versions: string[]): string[]` that returns the valid semver versions in ascending semver precedence (a new array). Precedence follows SemVer 2.0.0: compare major, minor, patch numerically; a prerelease is lower than its release; prerelease identifiers compare left to right, numeric ones numerically, alphanumeric ones lexically in ASCII, numeric lower than alphanumeric, and a shorter identifier list is lower when all earlier ones are equal. Versions equal in precedence keep build-metadata order lexically by full string. All inputs are valid versions.",
    referenceGlue: "export function solve(versions: string[]) { return lib.sort([...versions]); }",
    vectors: [
      {
        args: [
          [
            "1.0.0",
            "1.0.0-rc.1",
            "1.0.0-beta.11",
            "1.0.0-beta.2",
            "1.0.0-beta",
            "1.0.0-alpha.beta",
            "1.0.0-alpha.1",
            "1.0.0-alpha",
          ],
        ],
        returns: [
          "1.0.0-alpha",
          "1.0.0-alpha.1",
          "1.0.0-alpha.beta",
          "1.0.0-beta",
          "1.0.0-beta.2",
          "1.0.0-beta.11",
          "1.0.0-rc.1",
          "1.0.0",
        ],
        source: "SemVer 2.0.0 §11",
      },
    ],
    inputs: [[["1.10.0", "1.2.0", "1.2.0-rc.1", "1.2.0-beta.11", "1.2.0-beta.2", "0.9.9"]]],
    gen: (rng) =>
      Array.from({ length: 15 }, () => [
        Array.from({ length: 3 + rng.int(8) }, () => version(rng)),
      ]),
  },
  {
    id: "above-range",
    family: "versioning",
    lib: { file: "semver-7.8.0/ranges/gtr.js", name: "gtr" },
    spec: "Write `export function solve(version: string, range: string): boolean` that returns true when the valid semver `version` is greater than every version the npm range expression `range` could match (it is above the range's upper bounds, in every `||` alternative), and false otherwise, including when it satisfies the range or is below it. Use npm range semantics (caret, tilde, x-ranges, hyphen ranges, comparator sets, `||`). A range with no upper bound (such as `>=1.0.0` or `*`) is never exceeded.",
    referenceGlue:
      "export function solve(version: string, range: string) { return lib.gtr(version, range); }",
    inputs: [
      ["2.0.0", "^1.2"],
      ["1.5.0", "^1.2"],
      ["0.9.0", "^1.2"],
      ["1.3.0", "1.0.0 - 1.2.0 || 2.x"],
      ["3.0.0", "1.0.0 - 1.2.0 || 2.x"],
      ["5.0.0", ">=1.0.0"],
      ["1.0.1", "~1.0.0"],
      ["1.1.0", "~1.0.0"],
      ["0.3.0", "^0.2.5"],
    ],
    gen: (rng) => Array.from({ length: 30 }, () => [version(rng).replace(/-.*/, ""), range(rng)]),
  },
  // ---------------------------------------------------------------- hashes and encodings
  {
    id: "sha1-hex",
    family: "hashing",
    lib: { file: "uuid-11.1.1/dist/cjs-browser/sha1.js", name: "sha1" },
    spec: "Write `export function solve(text: string): string` that returns the SHA-1 digest (FIPS 180-4) of the UTF-8 encoding of `text`, as 40 lowercase hex digits.",
    referenceGlue:
      "export function solve(text: string) { const b = unescape(encodeURIComponent(text)); const bytes = []; for (let i = 0; i < b.length; i++) bytes.push(b.charCodeAt(i)); return Array.from(lib.sha1(bytes)).map((x: number) => x.toString(16).padStart(2, '0')).join(''); }",
    vectors: [
      {
        args: ["abc"],
        returns: "a9993e364706816aba3e25717850c26c9cd0d89d",
        source: "FIPS 180-4 example",
      },
      { args: [""], returns: "da39a3ee5e6b4b0d3255bfef95601890afd80709", source: "FIPS 180-4" },
      {
        args: ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"],
        returns: "84983e441c3bd26ebaae4aa1f95129e5e54670f1",
        source: "FIPS 180-4 example",
      },
    ],
    inputs: [
      ["The quick brown fox jumps over the lazy dog"],
      ["é漢😀"],
      ["a".repeat(55)],
      ["a".repeat(56)],
      ["a".repeat(64)],
      ["a".repeat(1000)],
    ],
    gen: (rng) => Array.from({ length: 20 }, () => [str(rng, TEXT, 0, 130)]),
  },
  {
    id: "uuid-v3",
    family: "hashing",
    lib: { file: "uuid-11.1.1/dist/cjs-browser/v3.js", name: "v3" },
    spec: "Write `export function solve(name: string, namespace: string): string` that returns the RFC 4122 version-3 (MD5, name-based) UUID for `name` (UTF-8 encoded) in the namespace UUID `namespace` (canonical string form), formatted as 36 lowercase characters `xxxxxxxx-xxxx-3xxx-yxxx-xxxxxxxxxxxx`. Throw a TypeError if `namespace` is not a valid UUID.",
    referenceGlue:
      "export function solve(name: string, namespace: string) { return lib.v3(name, namespace); }",
    vectors: [
      {
        args: ["www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"],
        returns: "5df41881-3aed-3515-88a7-2f4a814cf09e",
        source: "uuid test vectors (DNS namespace)",
      },
    ],
    inputs: [
      ["", "6ba7b811-9dad-11d1-80b4-00c04fd430c8"],
      ["é漢😀", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"],
      ["x", "not-a-uuid"],
    ],
    gen: (rng) =>
      Array.from({ length: 20 }, () => [
        str(rng, TEXT, 0, 60),
        `${hex(rng, 8)}-${hex(rng, 4)}-4${hex(rng, 3)}-a${hex(rng, 3)}-${hex(rng, 12)}`,
      ]),
  },
  // ---------------------------------------------------------------- validation rules
  {
    id: "iban-valid",
    family: "validation",
    lib: { file: "validator-13.15.35/lib/isIBAN.js", name: "isIBAN" },
    spec: "Write `export function solve(iban: string): boolean` that returns true when `iban` is a valid IBAN (ISO 13616): spaces and hyphens are ignored and letters may be any case; the country code must be one that uses IBANs, the total length and the BBAN's format (which positions are digits, letters or alphanumerics) must match that country's registry entry, and the mod-97 check (move the first four characters to the end, letters A=10…Z=35) must give 1.",
    referenceGlue: "export function solve(iban: string) { return lib.isIBAN(iban); }",
    inputs: [
      ["GB82WEST12345698765432"],
      ["GB82 WEST 1234 5698 7654 32"],
      ["gb82west12345698765432"],
      ["GB82WEST12345698765433"],
      ["DE89370400440532013000"],
      ["DE89-3704-0044-0532-0130-00"],
      ["FR1420041010050500013M02606"],
      ["NO9386011117947"],
      ["MT84MALT011000012345MTLCAST001S"],
      ["XX82WEST12345698765432"],
      ["GB82WEST1234569876543"],
      ["DE8937040044053201300A"],
    ],
    gen: (rng) =>
      Array.from({ length: 25 }, () => {
        const base = pick(rng, [
          "GB82WEST12345698765432",
          "DE89370400440532013000",
          "FR1420041010050500013M02606",
          "NO9386011117947",
          "BE68539007547034",
          "NL91ABNA0417164300",
        ]);
        const i = 2 + rng.int(base.length - 2);
        const c = base[i];
        const swap = /\d/.test(c)
          ? String((Number(c) + 1 + rng.int(8)) % 10)
          : pick(rng, [..."ABCXYZ"]);
        return [rng.int(3) === 0 ? base : base.slice(0, i) + swap + base.slice(i + 1)];
      }),
  },
  {
    id: "isbn-valid",
    family: "validation",
    lib: { file: "validator-13.15.35/lib/isISBN.js", name: "isISBN" },
    spec: "Write `export function solve(isbn: string, version?: 10 | 13): boolean` that returns true when `isbn` is a valid ISBN-10 or ISBN-13 (or only the given `version`). Spaces and hyphens are ignored. ISBN-10: nine digits and a check character (a digit or `X` = 10, upper case only) such that Σ (10 − i)·dᵢ ≡ 0 (mod 11). ISBN-13: thirteen digits with the EAN-13 check (weights 1,3 alternating) ≡ 0 (mod 10).",
    referenceGlue:
      "export function solve(isbn: string, version?: number) { return lib.isISBN(isbn, version === undefined ? undefined : String(version)); }",
    inputs: [
      ["978-0-306-40615-7"],
      ["0-306-40615-2"],
      ["0306406152", 10],
      ["0306406152", 13],
      ["080442957X"],
      ["080442957x"],
      ["978 0 306 40615 7"],
      ["9780306406158"],
      ["030640615"],
      ["97803064061577"],
    ],
    gen: (rng) =>
      Array.from({ length: 25 }, () => [
        pick(rng, [
          "9780306406157",
          "0306406152",
          "080442957X",
          "9781861972712",
          "1861972717",
        ]).replace(/\d/, (d) => (rng.int(2) ? d : String((Number(d) + 1) % 10))),
      ]),
  },
  {
    id: "ip-address-valid",
    family: "validation",
    lib: { file: "validator-13.15.35/lib/isIP.js", name: "isIP" },
    spec: "Write `export function solve(text: string, version?: 4 | 6): boolean` that returns true when `text` is an IPv4 or IPv6 address (or only the given version). IPv4: four decimal octets 0–255 separated by dots, no leading zeros (`0` itself is fine). IPv6 (RFC 4291 text forms): up to eight groups of 1–4 hex digits, at most one `::` compressing one or more zero groups, an optional trailing dotted IPv4 address in place of the last two groups, and an optional zone index `%` followed by one or more alphanumerics after a link-local address.",
    referenceGlue:
      "export function solve(text: string, version?: number) { return lib.isIP(text, version === undefined ? undefined : String(version)); }",
    inputs: [
      ["192.168.1.1"],
      ["256.1.1.1"],
      ["::1"],
      ["2001:db8::1", 6],
      ["2001:db8::1", 4],
      ["::ffff:192.168.1.1"],
      ["fe80::1%eth0"],
      ["01.1.1.1"],
      ["1:2:3:4:5:6:7:8:9"],
      ["1::2::3"],
      ["0.0.0.0"],
      ["1:2:3:4:5:6:7::"],
      ["::"],
      ["12345::1"],
    ],
    gen: (rng) =>
      Array.from({ length: 30 }, () => [
        rng.int(2)
          ? Array.from({ length: 3 + rng.int(3) }, () => String(rng.int(300))).join(".")
          : Array.from({ length: 2 + rng.int(8) }, () => hex(rng, rng.int(5))).join(":"),
      ]),
  },
  {
    id: "credit-card-valid",
    family: "validation",
    lib: { file: "validator-13.15.35/lib/isCreditCard.js", name: "isCreditCard" },
    spec: "Write `export function solve(card: string): boolean` that returns true when `card` is a plausible payment card number: spaces and hyphens are ignored; the digits must match a known issuer's prefix and length (Visa 4…, 13/16/19 digits; Mastercard 51–55 or 2221–2720, 16; American Express 34/37, 15; Discover 6011, 622126–622925, 644–649, 65, 16 or 19; Diners Club 300–305, 36, 38, 14–19; JCB 3528–3589, 16–19; UnionPay 62, 16–19) and pass the Luhn check.",
    referenceGlue: "export function solve(card: string) { return lib.isCreditCard(card); }",
    inputs: [
      ["4111111111111111"],
      ["4111 1111 1111 1111"],
      ["4111-1111-1111-1112"],
      ["378282246310005"],
      ["6011111111111117"],
      ["1234567812345670"],
      ["5555555555554444"],
      ["2223003122003222"],
      ["30569309025904"],
      ["3530111333300000"],
      ["4111111111111"],
    ],
    gen: (rng) =>
      Array.from({ length: 25 }, () => [
        pick(rng, [
          "4111111111111111",
          "5555555555554444",
          "378282246310005",
          "6011111111111117",
          "3530111333300000",
        ]).replace(/\d$/, (d) => (rng.int(2) ? d : String((Number(d) + 1 + rng.int(8)) % 10))),
      ]),
  },
  {
    id: "isin-valid",
    family: "validation",
    lib: { file: "validator-13.15.35/lib/isISIN.js", name: "isISIN" },
    spec: "Write `export function solve(isin: string): boolean` that returns true when `isin` is a valid ISIN (ISO 6166): two upper-case letters, nine upper-case alphanumerics, and a check digit, where the check digit is computed by converting letters to numbers (A=10…Z=35), then applying the Luhn algorithm to the resulting digit string.",
    referenceGlue: "export function solve(isin: string) { return lib.isISIN(isin); }",
    vectors: [{ args: ["US0378331005"], returns: true, source: "ISO 6166 example (Apple)" }],
    inputs: [
      ["US0378331004"],
      ["AU0000XVGZA3"],
      ["us0378331005"],
      ["GB0002634946"],
      ["US037833100"],
      ["DE000BAY0017"],
    ],
    gen: (rng) =>
      Array.from({ length: 20 }, () => [
        pick(rng, [
          "US0378331005",
          "AU0000XVGZA3",
          "GB0002634946",
          "DE000BAY0017",
          "US5949181045",
        ]).replace(/\d$/, (d) => (rng.int(2) ? d : String((Number(d) + 1 + rng.int(8)) % 10))),
      ]),
  },
  {
    id: "mac-address-valid",
    family: "validation",
    lib: { file: "validator-13.15.35/lib/isMACAddress.js", name: "isMACAddress" },
    spec: "Write `export function solve(mac: string): boolean` that returns true when `mac` is a MAC address: six (EUI-48) or eight (EUI-64) octets of two hex digits (any case) separated consistently by `:` or by `-`, or the dotted form of three (or four) groups of four hex digits (`0123.4567.89ab`). A string without separators is not accepted, and separators may not be mixed.",
    referenceGlue: "export function solve(mac: string) { return lib.isMACAddress(mac); }",
    inputs: [
      ["01:23:45:67:89:ab"],
      ["01-23-45-67-89-AB"],
      ["0123.4567.89ab"],
      ["0123456789ab"],
      ["01:23:45:67:89:ab:cd:ef"],
      ["01:23:45-67:89:ab"],
      ["01:23:45:67:89"],
      ["0g:23:45:67:89:ab"],
    ],
    gen: (rng) =>
      Array.from({ length: 20 }, () => {
        const sep = pick(rng, [":", "-", ":", "-", "."]);
        if (sep === ".")
          return [Array.from({ length: 3 + rng.int(2) }, () => hex(rng, 4)).join(".")];
        return [Array.from({ length: pick(rng, [5, 6, 6, 8, 7]) }, () => hex(rng, 2)).join(sep)];
      }),
  },
  {
    id: "lat-long-valid",
    family: "validation",
    lib: { file: "validator-13.15.35/lib/isLatLong.js", name: "isLatLong" },
    spec: "Write `export function solve(text: string): boolean` that returns true when `text` is a decimal latitude,longitude pair: a latitude in [−90, 90] and a longitude in [−180, 180], each with an optional sign and optional decimal fraction, separated by a comma with optional spaces after it, optionally wrapped together in one pair of parentheses. Degrees-minutes-seconds forms and space-only separators are not accepted.",
    referenceGlue: "export function solve(text: string) { return lib.isLatLong(text); }",
    inputs: [
      ["40.7128,-74.0060"],
      ["(40.7128, -74.0060)"],
      ["91,0"],
      ["-90,180"],
      ["40.7128 -74.0060"],
      ["+45.5,+120"],
      ["90.0001,0"],
      ["45,180.5"],
      ["(45,10"],
    ],
    gen: (rng) =>
      Array.from({ length: 20 }, () => [
        `${(rng.int(200) - 100 + rng.int(1000) / 1000).toFixed(rng.int(4))},${pick(rng, ["", " "])}${(rng.int(380) - 190).toString()}`,
      ]),
  },
  {
    id: "ean-valid",
    family: "validation",
    lib: { file: "validator-13.15.35/lib/isEAN.js", name: "isEAN" },
    spec: "Write `export function solve(code: string): boolean` that returns true when `code` is a valid EAN-8, EAN-13 or EAN-14 (GTIN-14) barcode number: only digits, of one of those lengths, whose last digit is the GS1 check digit (weights 3 and 1 alternating from the rightmost data digit; check = (10 − sum mod 10) mod 10).",
    referenceGlue: "export function solve(code: string) { return lib.isEAN(code); }",
    inputs: [
      ["4006381333931"],
      ["4006381333932"],
      ["96385074"],
      ["12345678901231"],
      ["400638133393"],
      ["4006381333931 "],
    ],
    gen: (rng) =>
      Array.from({ length: 20 }, () => [
        pick(rng, ["4006381333931", "96385074", "12345678901231", "5901234123457"]).replace(
          /\d$/,
          (d) => (rng.int(2) ? d : String((Number(d) + 1 + rng.int(8)) % 10)),
        ),
      ]),
  },
  {
    id: "issn-valid",
    family: "validation",
    lib: { file: "validator-13.15.35/lib/isISSN.js", name: "isISSN" },
    spec: "Write `export function solve(issn: string): boolean` that returns true when `issn` is a valid ISSN (ISO 3297): seven digits and a check character, written as `NNNN-NNNC` or without the hyphen, where the check character is a digit or `X` (either case) and Σ (8 − i)·dᵢ for the first seven digits plus the check value (X = 10) is ≡ 0 (mod 11).",
    referenceGlue: "export function solve(issn: string) { return lib.isISSN(issn); }",
    inputs: [
      ["0378-5955"],
      ["03785955"],
      ["2434-561X"],
      ["2434-561x"],
      ["0378-5954"],
      ["0378 5955"],
      ["0378-59555"],
    ],
    gen: (rng) =>
      Array.from({ length: 20 }, () => [
        `${String(rng.int(10000)).padStart(4, "0")}-${String(rng.int(1000)).padStart(3, "0")}${pick(rng, [..."0123456789X"])}`,
      ]),
  },
  {
    id: "domain-name-valid",
    family: "validation",
    lib: { file: "validator-13.15.35/lib/isFQDN.js", name: "isFQDN" },
    spec: "Write `export function solve(name: string): boolean` that returns true when `name` is a fully qualified domain name: at least two dot-separated labels and no trailing dot; each label 1–63 characters of letters, digits and hyphens (no underscores), not starting or ending with a hyphen; the last label (the TLD) is at least two characters and is either all letters (international letters allowed) or a punycode label starting with `xn--`, and contains no digits otherwise; the whole name is at most 253 characters. Other labels may be all digits.",
    referenceGlue: "export function solve(name: string) { return lib.isFQDN(name); }",
    inputs: [
      ["example.com"],
      ["sub.example.co.uk"],
      ["localhost"],
      ["-bad.com"],
      ["a_b.com"],
      ["example.com."],
      ["xn--bcher-kva.example"],
      ["ex..com"],
      ["123.com"],
      ["example.c"],
      ["example.123"],
      [`${"a".repeat(64)}.com`],
      ["bücher.de"],
    ],
    gen: (rng) =>
      Array.from({ length: 25 }, () => [
        Array.from({ length: 1 + rng.int(4) }, () => str(rng, [..."abcxyz019-_"], 0, 8)).join("."),
      ]),
  },
  // ---------------------------------------------------------------- data and algorithms
  {
    id: "json-pointer-get",
    family: "data",
    lib: { file: "jsonpointer-5.0.1/jsonpointer.js", name: "get" },
    spec: "Write `export function solve(doc: unknown, pointer: string): unknown` that evaluates the JSON Pointer `pointer` (RFC 6901) against `doc` and returns the referenced value, or undefined if a step does not exist. The empty pointer refers to the whole document; each `/`-prefixed token names an object member or an array index, with `~1` decoding to `/` and `~0` to `~` (in that order). Throw an Error if `pointer` is not empty and does not start with `/`.",
    referenceGlue:
      "export function solve(doc: unknown, pointer: string) { return lib.get(doc, pointer); }",
    vectors: [
      {
        args: [{ foo: ["bar", "baz"], "": 0, "a/b": 1, "m~n": 8 }, "/foo/0"],
        returns: "bar",
        source: "RFC 6901 §5",
      },
      {
        args: [{ foo: ["bar", "baz"], "": 0, "a/b": 1, "m~n": 8 }, "/a~1b"],
        returns: 1,
        source: "RFC 6901 §5",
      },
      {
        args: [{ foo: ["bar", "baz"], "": 0, "a/b": 1, "m~n": 8 }, "/m~0n"],
        returns: 8,
        source: "RFC 6901 §5",
      },
      {
        args: [{ foo: ["bar", "baz"], "": 0, "a/b": 1, "m~n": 8 }, "/"],
        returns: 0,
        source: "RFC 6901 §5",
      },
    ],
    inputs: [
      [{ a: { "b/c": [1, { "~x": 5 }] } }, "/a/b~1c/1/~0x"],
      [{ a: 1 }, ""],
      [{ a: [1] }, "/a/5"],
      [{ "~1": 3 }, "/~01"],
      [{ a: 1 }, "a"],
    ],
    gen: (rng) => {
      const doc = {
        a: { "b/c": [1, { "~x": 5, "": [true] }], d: null },
        "m~n": { 0: "zero" },
        list: [[1, 2], { k: "v" }],
      };
      const tokens = [
        "a",
        "b~1c",
        "0",
        "1",
        "~0x",
        "",
        "d",
        "m~0n",
        "list",
        "k",
        "2",
        "-",
        "b/c",
        "~01",
      ];
      return Array.from({ length: 25 }, () => [
        doc,
        Array.from({ length: rng.int(4) }, () => `/${pick(rng, tokens)}`).join(""),
      ]);
    },
  },
  {
    id: "edit-distance",
    family: "data",
    lib: { file: "fastest-levenshtein-1.0.16/esm/mod.js", name: "distance" },
    spec: "Write `export function solve(a: string, b: string): number` that returns the Levenshtein distance between `a` and `b`: the minimum number of single-character insertions, deletions and substitutions turning one into the other, where a character is a UTF-16 code unit.",
    referenceGlue: "export function solve(a: string, b: string) { return lib.distance(a, b); }",
    vectors: [
      { args: ["kitten", "sitting"], returns: 3, source: "Levenshtein (1965) standard example" },
    ],
    inputs: [
      ["", ""],
      ["flaw", "lawn"],
      ["😀a", "a"],
      ["a".repeat(40), "b".repeat(33)],
      [
        "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        "zyxwvutsrqponmlkjihgfedcba9876543210ZYXWVUTSRQPONMLKJIHGFEDCBA",
      ],
    ],
    gen: (rng) =>
      Array.from({ length: 30 }, () => [
        str(rng, [..."abcde"], 0, 70),
        str(rng, [..."abcde"], 0, 70),
      ]),
  },
];
