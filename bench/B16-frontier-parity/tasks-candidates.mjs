// SPDX-License-Identifier: MIT
// B16 candidate tasks (not in the set until screened): each is kept only if Haiku from scratch
// finds it hard (pass@1 < 0.6) and Haiku with the module handed over passes it (the spec audit),
// both measured. Included in `tasks` when B16_CANDIDATES=1 (screening runs only).
const pick = (rng, xs) => xs[rng.int(xs.length)];
const str = (rng, alphabet, min, max) =>
  Array.from({ length: min + rng.int(max - min + 1) }, () => pick(rng, alphabet)).join("");
const UPPER = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
const VOWELS = [..."AEIOU"];
const CONSONANTS = [..."BCDFGHJKLMNPQRSTVWXYZ"];
const MONTHS = [..."ABCDEHLMPRST"];
const OMO = [..."LMNPQRSTUV"]; // the letters standing for 0-9
const ODD = {
  A: 1,
  B: 0,
  C: 5,
  D: 7,
  E: 9,
  F: 13,
  G: 15,
  H: 17,
  I: 19,
  J: 21,
  K: 2,
  L: 4,
  M: 18,
  N: 20,
  O: 11,
  P: 3,
  Q: 6,
  R: 8,
  S: 12,
  T: 14,
  U: 16,
  V: 10,
  W: 22,
  X: 25,
  Y: 24,
  Z: 23,
  0: 1,
  1: 0,
  2: 5,
  3: 7,
  4: 9,
  5: 13,
  6: 15,
  7: 17,
  8: 19,
  9: 21,
};
/** The check letter of a codice fiscale's first 15 characters (its digits as digits). */
const cfCheck = (fifteen) => {
  let sum = 0;
  [...fifteen].forEach((c, i) => {
    sum += i % 2 === 0 ? ODD[c] : /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 65;
  });
  return String.fromCharCode(65 + (sum % 26));
};
const pad2 = (n) => String(n).padStart(2, "0");
const nameCode = (rng) => {
  const k = rng.int(4); // consonants, then vowels, then X padding
  const c = Array.from({ length: 3 }, () => pick(rng, CONSONANTS));
  const v = Array.from({ length: 3 }, () => pick(rng, VOWELS));
  return [
    ...c.slice(0, 3 - Math.min(k, 3)),
    ...v.slice(0, Math.min(k, 2)),
    ...(k === 3 ? ["X"] : []),
  ]
    .join("")
    .padEnd(3, "X")
    .slice(0, 3);
};
const VERSIONS = (rng) =>
  `${rng.int(3)}.${rng.int(4)}.${rng.int(4)}${rng.int(4) === 0 ? `-${pick(rng, ["alpha", "beta", "rc"])}.${rng.int(3)}` : ""}`;
const RANGE = (rng) =>
  pick(rng, [
    () => `^${VERSIONS(rng)}`,
    () => `~${VERSIONS(rng)}`,
    () => `${rng.int(3)}.x`,
    () => `${rng.int(3)}.${rng.int(4)}`,
    () => `>=${VERSIONS(rng)} <${VERSIONS(rng)}`,
    () => `${VERSIONS(rng)} - ${VERSIONS(rng)}`,
    () => `^${VERSIONS(rng)} || ~${VERSIONS(rng)}`,
    () => `>${VERSIONS(rng)}`,
    () => `<=${rng.int(3)}.${rng.int(4)}`,
    () => "*",
  ])();

const DIGITS = [..."0123456789"];
const ymdValid = (y, m, d) =>
  m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
const nat = (rng, k) => Array.from({ length: k }, () => pick(rng, DIGITS)).join("");
const cnpCheck = (twelve) => {
  const w = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
  const r = [...twelve].reduce((s, c, i) => s + Number(c) * w[i], 0) % 11;
  return r === 10 ? 1 : r;
};
const HETU = [..."0123456789ABCDEFHJKLMNPRSTUVWXY"];

// (National IDs: check digits by each standard, so a generated input can be valid.)
const d2 = (n) => String(n).padStart(2, "0");
const wsum = (digits, w) => [...digits].reduce((a, c, i) => a + Number(c) * w[i], 0);
const egnCheck = (nine) => {
  const r = wsum(nine, [2, 4, 8, 5, 10, 9, 7, 3, 6]) % 11;
  return r === 10 ? 0 : r;
};
const peselCheck = (ten) => (10 - (wsum(ten, [1, 3, 7, 9, 1, 3, 7, 9, 1, 3]) % 10)) % 10;
const nipCheck = (nine) => wsum(nine, [6, 5, 7, 2, 3, 4, 5, 6, 7]) % 11;
const isikCheck = (ten) => {
  const r1 = wsum(ten, [1, 2, 3, 4, 5, 6, 7, 8, 9, 1]) % 11;
  if (r1 !== 10) return r1;
  const r2 = wsum(ten, [3, 4, 5, 6, 7, 8, 9, 1, 2, 3]) % 11;
  return r2 === 10 ? 0 : r2;
};
const huCheck = (nine) => wsum(nine, [1, 2, 3, 4, 5, 6, 7, 8, 9]) % 11;
const cprOk = (ten) => wsum(ten, [4, 3, 2, 7, 6, 5, 4, 3, 2, 1]) % 11 === 0;
const wrongDigit = (rng, d) => (d + 1 + rng.int(9)) % 10;

export const candidateTasks = [
  {
    id: "codice-fiscale-valid",
    family: "validation",
    lib: { file: "validator-13.15.35/lib/isTaxID.js", name: "isTaxID" },
    spec: "Write `export function solve(code: string): boolean` that returns true when `code` is a valid Italian codice fiscale (a person's tax code), letters in any case. It has 16 characters: 3 letters for the surname and 3 for the given name; 2 for the year of birth; a month letter (A B C D E H L M P R S T for January to December); 2 for the day of birth (01-31, or 41-71 for a woman: the day plus 40); 4 for the place of birth (a letter among A-I, L, M or Z, then 3); and a check letter. Each of the 7 positions that hold a digit (year, day, the place's 3) may instead hold the letter standing for it, L M N P Q R S T U V for 0-9 (codes made unique this way). Each 3-letter name code is consonants first, then vowels, then X padding: an X before any vowel counts as a consonant; once a vowel appears, only vowels may follow until an X, and after that X only X may follow (`GXQ`, `TXI` and `EAX` are valid, `AXE` and `ABE` are not). The date must exist: the day within its month, and February 29 only when the two-digit year is divisible by 4 (00 included). The check letter is computed on the first 15 characters with any letters standing for digits read as those digits: characters at odd positions (1st, 3rd, ..., 15th) count by the odd table (A or 0 = 1, B or 1 = 0, C or 2 = 5, D or 3 = 7, E or 4 = 9, F or 5 = 13, G or 6 = 15, H or 7 = 17, I or 8 = 19, J or 9 = 21, K = 2, L = 4, M = 18, N = 20, O = 11, P = 3, Q = 6, R = 8, S = 12, T = 14, U = 16, V = 10, W = 22, X = 25, Y = 24, Z = 23), characters at even positions by their value (a digit its value, a letter A = 0 to Z = 25); the sum mod 26 as a letter (0 = A) must equal the 16th character.",
    referenceGlue: "export function solve(code: string) { return lib.isTaxID(code, 'it-IT'); }",
    vectors: [
      {
        args: ["RSSMRA85T10A562S"],
        returns: true,
        source: "Agenzia delle Entrate's example (Mario Rossi)",
      },
    ],
    inputs: [
      ["RSSMRA85T10A562S"],
      ["rssmra85t10a562s"],
      ["RSSMRA85T10A562T"],
      ["RSSMRA85T50A562W"],
      ["RSSMRA85B30A562S"],
      ["RSSMRA84B29A562W"],
      ["RSSMRA85T10A56NH"],
      ["RSSMRAURT10A562S"],
      ["RSXMRA85T10A562S"],
      ["RSSMRA85T10A562"],
    ],
    gen: (rng) =>
      Array.from({ length: 40 }, () => {
        const month = pick(rng, MONTHS);
        const mIdx = MONTHS.indexOf(month);
        const year = rng.int(100);
        const dim = [31, year % 4 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mIdx];
        const day = 1 + rng.int(rng.int(5) === 0 ? dim + 2 : dim) + (rng.int(2) ? 40 : 0);
        let body = `${nameCode(rng)}${nameCode(rng)}${pad2(year)}${month}${pad2(day)}${pick(rng, [..."ABCDEFGHILMZ"])}${String(rng.int(1000)).padStart(3, "0")}`;
        let check = cfCheck(body);
        if (rng.int(5) === 0) check = pick(rng, UPPER); // often wrong
        // (Letters for digits in some codes: the check computed on the digits.)
        if (rng.int(3) === 0) {
          const at = pick(rng, [6, 7, 9, 10, 12, 13, 14]);
          body = `${body.slice(0, at)}${OMO[Number(body[at])]}${body.slice(at + 1)}`;
        }
        const code = `${body}${check}`;
        return [rng.int(5) === 0 ? code.toLowerCase() : code];
      }),
  },
  {
    id: "normalize-range",
    family: "versioning",
    lib: { file: "semver-7.8.0/ranges/valid.js", name: "validRange" },
    spec: "Write `export function solve(range: string): string | null` that returns an npm semver range in its normalized form, as node-semver writes it, or null if the range is invalid. Each `||`-separated comparator set becomes its primitive comparators (`>=`, `>`, `<`, `<=`, or an exact version), with X-ranges, partial versions, tilde, caret and hyphen ranges expanded by npm's rules. An upper bound that excludes a version excludes its prereleases too, written with `-0` (`^1.2.3` is `>=1.2.3 <2.0.0-0`). Comparators in a set are separated by one space and sets are joined by `||` with no spaces. A range that matches every version (`*`, `x`, an empty string) is `*`.",
    referenceGlue: "export function solve(range: string) { return lib.validRange(range); }",
    vectors: [
      { args: ["^1.2.3"], returns: ">=1.2.3 <2.0.0-0", source: "npm semver docs (caret ranges)" },
      {
        args: ["1.2.3 - 2.3"],
        returns: ">=1.2.3 <2.4.0-0",
        source: "npm semver docs (hyphen ranges)",
      },
    ],
    inputs: [
      ["^0.0.3"],
      ["~1.2.3-beta.2"],
      ["1 || 2"],
      [">=1.2.3 <2"],
      ["*"],
      [""],
      ["^0.1"],
      ["~0"],
      ["not a range"],
      [">1.2"],
      ["<=1.2"],
      ["1.2.x"],
    ],
    gen: (rng) => Array.from({ length: 35 }, () => [RANGE(rng)]),
  },
  {
    id: "below-range",
    family: "versioning",
    lib: { file: "semver-7.8.0/ranges/ltr.js", name: "ltr" },
    spec: "Write `export function solve(version: string, range: string): boolean` that returns true when `version` is lower than every version the npm semver range `range` could match (node-semver's `ltr`): below the range's lowest bound in every comparator set, so that no version of the range is at or below it. A version in the range, or above any part of it, gives false. Ranges use npm's syntax: comparators, X-ranges, partial versions, tilde, caret, hyphen ranges and `||`. Prerelease versions compare by semver precedence.",
    referenceGlue:
      "export function solve(version: string, range: string) { return lib.ltr(version, range); }",
    inputs: [
      ["1.0.0", "^1.0.1"],
      ["1.0.0", "^1.0.0"],
      ["0.9.9", ">=1.0.0 || <0.5.0"],
      ["1.2.3-beta.1", "^1.2.3"],
      ["0.0.1", "*"],
      ["2.0.0", "1.x"],
    ],
    gen: (rng) => Array.from({ length: 35 }, () => [VERSIONS(rng), RANGE(rng)]),
  },
  {
    id: "lowest-satisfying",
    family: "versioning",
    lib: { file: "semver-7.8.0/ranges/min-satisfying.js", name: "minSatisfying" },
    spec: "Write `export function solve(versions: string[], range: string): string | null` that returns the lowest version in `versions` that satisfies the npm semver range `range` (node-semver's `minSatisfying`), or null if none does. Ranges use npm's syntax: comparators, X-ranges, partial versions, tilde, caret, hyphen ranges and `||`. A prerelease version satisfies a range only if some comparator in the same set has a prerelease on the same major.minor.patch; invalid versions in the list are skipped.",
    referenceGlue:
      "export function solve(versions: string[], range: string) { return lib.minSatisfying(versions, range); }",
    inputs: [
      [["1.2.3-beta.1", "1.2.3", "1.2.4"], "^1.2.3-beta.0"],
      [["1.2.3-beta.1", "1.2.4-beta"], "^1.2.3"],
      [["2.0.0", "1.9.9", "bad"], ">=1.5.0 <2"],
      [[], "*"],
    ],
    gen: (rng) =>
      Array.from({ length: 35 }, () => [
        Array.from({ length: 1 + rng.int(6) }, () => VERSIONS(rng)),
        RANGE(rng),
      ]),
  },
  {
    id: "path-get",
    family: "data",
    lib: { file: "lodash-4.17.21/get.js", name: "get" },
    spec: "Write `export function solve(obj: unknown, path: string): unknown` that reads the value at `path` in `obj` as lodash's `get` does, or undefined when any step is missing or null. The path is lodash's syntax: keys separated by dots (`a.b`); bracketed numbers (`a[0]`, also negative or decimal, `a[-1]`, `a[1.5]`, as the key that number's text is); bracketed keys quoted with single or double quotes, in which a backslash escapes the next character (`a[\"x.y\"]`, `a['it\\'s']`); an empty key between two dots, or after a leading dot, or before `[]` (`a..b` reads key `\"\"` of `a`, then `b`). A key that is the whole path and exists on `obj` is read as that key, not parsed.",
    referenceGlue:
      "export function solve(obj: unknown, path: string) { return lib.get(obj, path); }",
    inputs: [
      [{ a: [{ b: { "c.d": 5 } }] }, 'a[0].b["c.d"]'],
      [{ "a.b": { c: 3 } }, '["a.b"].c'],
      [{ "a.b": 4, a: { b: 5 } }, "a.b"],
      [{ a: { "": { b: 2 } } }, "a..b"],
      [{ a: [[1, 2]] }, "a[0][1]"],
      [{ a: { "-1": 9 } }, "a[-1]"],
      [{ a: { 1.5: 8 } }, "a[1.5]"],
      [{ a: { "it's": 7 } }, "a['it\\'s']"],
      [{ "": { x: 1 } }, ".x"],
      [{ a: null }, "a.b"],
    ],
    gen: (rng) =>
      Array.from({ length: 30 }, () => {
        const keys = ["a", "b", "0", "x.y", "", "1.5", "-1", "q'z"];
        const obj = {};
        let cur = obj;
        const path = [];
        for (let i = 0; i < 1 + rng.int(3); i++) {
          const k = pick(rng, keys);
          cur[k] = {};
          cur = cur[k];
          path.push(k);
        }
        cur.v = rng.int(100);
        path.push(rng.int(4) === 0 ? "w" : "v");
        const write = (k, i) => {
          if (/^-?\d+(\.\d+)?$/.test(k) && rng.int(2)) return `[${k}]`;
          if (/^[A-Za-z_]\w*$/.test(k) && rng.int(3)) return `${i === 0 ? "" : "."}${k}`;
          const q = pick(rng, ['"', "'"]);
          return `[${q}${k.replace(/[\\'"]/g, (c) => (c === q || c === "\\" ? `\\${c}` : c))}${q}]`;
        };
        return [obj, path.map(write).join("")];
      }),
  },
  {
    id: "czech-birth-number-valid",
    family: "validation",
    lib: { file: "validator-13.15.35/lib/isTaxID.js", name: "isTaxID" },
    spec: "Write `export function solve(id: string): boolean` that returns true when `id` is a valid Czech birth number (rodné číslo): 6 digits YYMMDD, an optional slash, then 3 or 4 digits. The year: with 4 final digits, YY below 54 is 20YY and otherwise 19YY; with 3 (numbers issued before 1954), YY must be below 54 and is 19YY, and the 3 digits must not be 000. The month: a woman's has 50 added, and from 2004 on 20 may also be added. So a month over 50 has 50 taken off, then one still over 20 has 20 taken off, which is only allowed when the year is 2004 or later. The date must exist. A 10-digit number (without its slash) must be divisible by 11, except that for years before 1986 one whose first 9 digits mod 11 are 10 is also valid when its last digit is 0.",
    referenceGlue: "export function solve(id: string) { return lib.isTaxID(id, 'cs-CZ'); }",
    inputs: [
      ["7103192745"],
      ["710319/2745"],
      ["5502281234"],
      ["736028/5163"],
      ["0451010004"],
      ["535231/000"],
      ["535231/001"],
      ["8562310011"],
      ["8562315014"],
      ["7103192746"],
    ],
    gen: (rng) =>
      Array.from({ length: 45 }, () => {
        const ten = rng.int(4) !== 0;
        const yy = ten ? rng.int(100) : rng.int(60);
        const year = ten ? (yy < 54 ? 2000 + yy : 1900 + yy) : 1900 + yy;
        let mm = 1 + rng.int(12);
        const d = 1 + rng.int(rng.int(6) === 0 ? 32 : 28);
        if (rng.int(2)) mm += 50;
        if (rng.int(3) === 0) mm += 20;
        const head = `${String(yy).padStart(2, "0")}${String(mm).padStart(2, "0")}${String(d).padStart(2, "0")}`;
        let tail;
        if (ten) {
          const nine = `${head}${nat(rng, 3)}`;
          // (The digit making it divisible by 11: 10 is -1 mod 11, so the first nine mod 11;
          // none when that is 10, then 0, the pre-1986 exception.)
          const r = Number(nine) % 11;
          tail = `${nine.slice(6)}${rng.int(5) === 0 ? rng.int(10) : r === 10 ? 0 : r}`;
        } else tail = rng.int(6) === 0 ? "000" : nat(rng, 3);
        return [`${head}${rng.int(2) ? "/" : ""}${tail}`];
      }),
  },
  {
    id: "romanian-cnp-valid",
    family: "validation",
    lib: { file: "validator-13.15.35/lib/isTaxID.js", name: "isTaxID" },
    spec: "Write `export function solve(cnp: string): boolean` that returns true when `cnp` is a valid Romanian personal numeric code (CNP): exactly 13 digits. A code starting `9000` is accepted with no further check. Otherwise digits 2-7 are a date YYMMDD whose century the first digit gives: 1 or 2 the 1900s, 3 or 4 the 1800s, 5 or 6 the 2000s. With any other first digit (0, 7, 8, 9) the date is checked on its two-digit year alone, February 29 being allowed when YY is divisible by 4. The date must exist. The check digit: digits 1-12 times the weights 2 7 9 1 4 6 3 5 8 2 7 9, summed, mod 11, a remainder of 10 counting as 1, must equal the 13th digit.",
    referenceGlue: "export function solve(cnp: string) { return lib.isTaxID(cnp, 'ro-RO'); }",
    inputs: [
      ["1960101123456"],
      ["1960101123457"],
      ["9000123456789"],
      ["5000229123458"],
      ["1000229123450"],
      ["7000229123453"],
      ["196010112345"],
      ["2961301123456"],
    ],
    gen: (rng) =>
      Array.from({ length: 45 }, () => {
        const c = pick(rng, [..."1234567890"]);
        const yy = rng.int(100);
        const mm = 1 + rng.int(rng.int(8) === 0 ? 13 : 12);
        const dd = 1 + rng.int(rng.int(6) === 0 ? 31 : 28);
        const twelve = `${c}${String(yy).padStart(2, "0")}${String(mm).padStart(2, "0")}${String(dd).padStart(2, "0")}${nat(rng, 5)}`;
        const check = rng.int(5) === 0 ? rng.int(10) : cnpCheck(twelve);
        return [`${twelve}${check}`];
      }),
  },
  {
    id: "finnish-hetu-valid",
    family: "validation",
    lib: { file: "validator-13.15.35/lib/isTaxID.js", name: "isTaxID" },
    spec: "Write `export function solve(hetu: string): boolean` that returns true when `hetu` is a valid Finnish personal identity code (HETU): DDMMYY, a century sign (`+` the 1800s, `-` the 1900s, `A` the 2000s; no other sign), a 3-digit individual number, and a check character. The date must exist. The check character is the 9-digit number DDMMYYZZZ (date and individual number) mod 31, as 0-9 or a letter of `ABCDEFHJKLMNPRSTUVWXY` for 10-30. The century sign `A` may also be written `a`; a check letter must be upper case.",
    referenceGlue: "export function solve(hetu: string) { return lib.isTaxID(hetu, 'fi-FI'); }",
    inputs: [
      ["131052-308T"],
      ["131052A308T"],
      ["131052-308U"],
      ["131052B308T"],
      ["290200A123J"],
      ["290201A123X"],
      ["131052-308t"],
    ],
    gen: (rng) =>
      Array.from({ length: 40 }, () => {
        const sign = pick(rng, ["+", "-", "A", "A", "-", "B"]);
        const dd = 1 + rng.int(rng.int(6) === 0 ? 31 : 28);
        const mm = 1 + rng.int(12);
        const yy = rng.int(100);
        const date = `${String(dd).padStart(2, "0")}${String(mm).padStart(2, "0")}${String(yy).padStart(2, "0")}`;
        const ind = nat(rng, 3);
        const check = rng.int(5) === 0 ? pick(rng, HETU) : HETU[Number(`${date}${ind}`) % 31];
        const code = `${date}${sign}${ind}${check}`;
        return [rng.int(5) === 0 ? code.toLowerCase() : code];
      }),
  },
  {
    id: "bulgarian-egn-valid",
    family: "validation",
    lib: { file: "validator-13.15.35/lib/isTaxID.js", name: "isTaxID" },
    spec: "Write `export function solve(egn: string): boolean` that returns true when `egn` is a valid Bulgarian unified civil number (EGN), by its rules (10 digits: an existing date of birth with the month's century offsets, and the check digit).",
    referenceGlue: "export function solve(egn: string) { return lib.isTaxID(egn, 'bg-BG'); }",
    inputs: [["7523169263"], ["7523169264"], ["0041010006"], ["7552010005"]],
    gen: (rng) =>
      Array.from({ length: 45 }, () => {
        const mm = 1 + rng.int(rng.int(8) === 0 ? 13 : 12) + pick(rng, [0, 0, 20, 40, 60]);
        const nine = `${d2(rng.int(100))}${d2(mm)}${d2(1 + rng.int(rng.int(6) === 0 ? 31 : 28))}${nat(rng, 3)}`;
        const c = egnCheck(nine);
        return [`${nine}${rng.int(5) === 0 ? wrongDigit(rng, c) : c}`];
      }),
  },
  {
    id: "polish-tax-id-valid",
    family: "validation",
    lib: { file: "validator-13.15.35/lib/isTaxID.js", name: "isTaxID" },
    spec: "Write `export function solve(id: string): boolean` that returns true when `id` is a valid Polish tax identifier: a 10-digit NIP with a valid check digit, or an 11-digit PESEL (an existing date of birth with the month's century offsets, and its check digit), by their rules.",
    referenceGlue: "export function solve(id: string) { return lib.isTaxID(id, 'pl-PL'); }",
    inputs: [
      ["44051401359"],
      ["44051401358"],
      ["5260250995"],
      ["5260250996"],
      ["02270803628"],
      ["99923112349"],
    ],
    gen: (rng) =>
      Array.from({ length: 50 }, () => {
        if (rng.int(3) === 0) {
          let nine = nat(rng, 9);
          while (nipCheck(nine) === 10) nine = nat(rng, 9);
          const c = nipCheck(nine);
          return [`${nine}${rng.int(4) === 0 ? wrongDigit(rng, c) : c}`];
        }
        // (The module rejects a PESEL whose check digit is 0, against the standard: none here.)
        let ten;
        do {
          const mm = 1 + rng.int(rng.int(8) === 0 ? 13 : 12) + pick(rng, [0, 0, 20, 40, 60, 80]);
          ten = `${d2(rng.int(100))}${d2(mm)}${d2(1 + rng.int(rng.int(6) === 0 ? 31 : 28))}${nat(rng, 4)}`;
        } while (peselCheck(ten) === 0);
        const c = peselCheck(ten);
        return [`${ten}${rng.int(4) === 0 ? wrongDigit(rng, c) || 1 : c}`];
      }),
  },
  {
    id: "estonian-id-code-valid",
    family: "validation",
    lib: { file: "validator-13.15.35/lib/isTaxID.js", name: "isTaxID" },
    spec: "Write `export function solve(code: string): boolean` that returns true when `code` is a valid Estonian personal identification code (isikukood), by its rules (11 digits: the sex and century digit 1-6, an existing date of birth, a serial number, and the check digit). Choice: the 3-digit serial number must be 001 to 710.",
    referenceGlue: "export function solve(code: string) { return lib.isTaxID(code, 'et-EE'); }",
    inputs: [["37605030299"], ["37605030298"], ["50001010006"], ["37605037119"], ["77605030299"]],
    gen: (rng) =>
      Array.from({ length: 45 }, () => {
        const c0 = rng.int(10) === 0 ? pick(rng, [..."0789"]) : pick(rng, [..."123456"]);
        const serial = rng.int(8) === 0 ? 711 + rng.int(289) : 1 + rng.int(710);
        const ten = `${c0}${d2(rng.int(100))}${d2(1 + rng.int(12))}${d2(1 + rng.int(rng.int(6) === 0 ? 31 : 28))}${String(serial).padStart(3, "0")}`;
        const c = isikCheck(ten);
        return [`${ten}${rng.int(5) === 0 ? wrongDigit(rng, c) : c}`];
      }),
  },
  {
    id: "hungarian-tax-id-valid",
    family: "validation",
    lib: { file: "validator-13.15.35/lib/isTaxID.js", name: "isTaxID" },
    spec: "Write `export function solve(id: string): boolean` that returns true when `id` is a valid Hungarian tax identification number for a person (adóazonosító jel), by its rules (10 digits starting with 8, and the check digit). Choice: the digits encoding the date of birth are not checked.",
    referenceGlue: "export function solve(id: string) { return lib.isTaxID(id, 'hu-HU'); }",
    inputs: [["8071592153"], ["8071592154"], ["7071592153"], ["807159215"]],
    gen: (rng) =>
      Array.from({ length: 40 }, () => {
        let nine = `8${nat(rng, 8)}`;
        while (huCheck(nine) === 10) nine = `8${nat(rng, 8)}`;
        const c = huCheck(nine);
        const id = `${nine}${rng.int(4) === 0 ? wrongDigit(rng, c) : c}`;
        return [rng.int(10) === 0 ? `7${id.slice(1)}` : id];
      }),
  },
  {
    id: "danish-cpr-valid",
    family: "validation",
    lib: { file: "validator-13.15.35/lib/isTaxID.js", name: "isTaxID" },
    spec: "Write `export function solve(cpr: string): boolean` that returns true when `cpr` is a valid Danish personal identification number (CPR), by its rules (DDMMYY, an optional hyphen, 4 digits whose first gives the century, and an existing date of birth). Choice: every number must also pass the modulus-11 check (weights 4 3 2 7 6 5 4 3 2 1), though numbers issued since 2007 need not.",
    referenceGlue: "export function solve(cpr: string) { return lib.isTaxID(cpr, 'dk-DK'); }",
    inputs: [["070761-4285"], ["0707614285"], ["070761-4286"], ["290200-4007"], ["010103-5009"]],
    gen: (rng) =>
      Array.from({ length: 45 }, () => {
        // (Century digits 5-8 only with years the module and the standard agree on.)
        const cd = rng.int(10);
        let yy = rng.int(100);
        if (cd >= 5 && cd <= 8 && yy >= 37 && yy <= 58)
          yy = rng.int(2) ? rng.int(37) : 59 + rng.int(41);
        const head = `${d2(1 + rng.int(rng.int(6) === 0 ? 31 : 28))}${d2(1 + rng.int(12))}${d2(yy)}${cd}`;
        let ten;
        let tries = 0;
        do {
          ten = `${head}${nat(rng, 3)}`;
          tries++;
        } while (!cprOk(ten) && tries < 200);
        if (rng.int(4) === 0) ten = `${ten.slice(0, 9)}${wrongDigit(rng, Number(ten[9]))}`;
        return [rng.int(2) ? `${ten.slice(0, 6)}-${ten.slice(6)}` : ten];
      }),
  },
];

// Brief specs: the need as a developer states it (the standard named, not restated), and only
// the module's choices where it departs from the standard or the standard leaves one open.
const BRIEF = {
  "codice-fiscale-valid":
    "Write `export function solve(code: string): boolean` that returns true when `code` is a valid Italian codice fiscale for a person, by the official rules (its structure and the letters for months, a woman's day of birth, the surname and given-name codes, the codes made unique by letters in digit positions (omocodia), an existing date of birth, and the check character). Letters may be in any case. Choices where the rules leave room: a two-digit year divisible by 4 (00 included) allows February 29; for a code with letters in digit positions, the check character is computed with those letters read as the digits they stand for.",
  "czech-birth-number-valid":
    "Write `export function solve(id: string): boolean` that returns true when `id` is a valid Czech birth number (rodné číslo), by its rules (the date of birth, the month offsets for women and from 2004, the 9-digit form of numbers issued before 1954, and the 10-digit form's check), with or without the slash after the date. Choices where the rules leave room: in the 10-digit form a two-digit year below 54 is 20YY, otherwise 19YY; the 9-digit form needs a year below 54 and a serial other than 000.",
  "romanian-cnp-valid":
    "Write `export function solve(cnp: string): boolean` that returns true when `cnp` is a valid Romanian personal numeric code (CNP), by its rules (the sex and century digit, an existing date of birth, and the check digit). Choices where the rules leave room: the county code is not checked; a code starting `9000` is accepted with no other check; with a first digit of 0, 7, 8 or 9 the date is checked on its two-digit year alone, February 29 being allowed when that year is divisible by 4.",
  "finnish-hetu-valid":
    "Write `export function solve(hetu: string): boolean` that returns true when `hetu` is a valid Finnish personal identity code (HETU), by its rules (an existing date of birth, the century sign, the individual number and the check character). Choices: only the century signs `+`, `-` and `A` are accepted (`A` also as `a`); a check letter must be upper case.",
};
for (const t of candidateTasks)
  if (BRIEF[t.id])
    candidateTasks.push({ ...t, id: `${t.id}-brief`, spec: BRIEF[t.id], briefOf: t.id });

/** Brief specs for tasks already in the set (screening only): added by tasks.mjs as `<id>-brief`. */
export const briefOfExisting = {
  "container-number-valid":
    "Write `export function solve(code: string): boolean` that returns true when `code` is a valid ISO 6346 freight container number (owner code, equipment category U, J or Z, serial number, and the check digit by ISO 6346's rule), letters in any case.",
  "german-tax-id-valid":
    "Write `export function solve(id: string): boolean` that returns true when `id` is a valid German tax identification number (Steuerliche Identifikationsnummer), by its rules (its digits, the rule on repeated digits, and the check digit), after removing any slashes and backslashes.",
  "bump-version":
    "Write `export function solve(version: string, kind: 'major' | 'minor' | 'patch' | 'premajor' | 'preminor' | 'prepatch' | 'prerelease', id?: string): string | null` that returns the next version as node-semver 7's `inc(version, kind, id)` computes it (what `npm version <kind> --preid <id>` gives), or null if `version` is not a valid semver version.",
  "version-change-kind":
    "Write `export function solve(a: string, b: string): string | null` that classifies the change between two valid semver versions as node-semver 7's `diff(a, b)` does: null when they are equal (ignoring build metadata), else one of `major`, `minor`, `patch`, `premajor`, `preminor`, `prepatch`, `prerelease`.",
  "coerce-version":
    "Write `export function solve(text: string): string | null` that coerces `text` to a semver version as node-semver 7's `coerce(text)` does with its default options, returning the version's `major.minor.patch` string, or null when it gives null.",
  "sort-versions":
    "Write `export function solve(versions: string[]): string[]` that returns the valid semver versions sorted ascending by SemVer 2.0.0 precedence (a new array), versions of equal precedence ordered by their build metadata, as node-semver's `sort` does. All inputs are valid versions.",
  "sort-iso-timestamps":
    "Write `export function solve(stamps: string[]): number[]` that parses ISO 8601 date and date-time strings (calendar, week and ordinal dates, times with fractional seconds, `Z` or numeric offsets) and returns their epoch milliseconds sorted ascending; a string without an offset is in UTC. Throw a RangeError if any string is not a valid date. Choice: a week 53 is accepted in any year (in a year of 52 weeks it is the next year's first week).",
  "uuid-v1-to-v6":
    "Write `export function solve(uuid: string): string | null` that converts a version-1 UUID string (either case) to the version-6 UUID with the same timestamp, clock sequence and node, as RFC 9562 defines it, in lower case; null if `uuid` is not a UUID string with RFC 9562's variant.",
};

/**
 * Candidates promoted into the set by screening (results/screen-1 to screen-5): hard for Haiku
 * from scratch (pass@1 0 to 0.2) and passed by Haiku with the module handed over. The brief
 * German spec replaces the full one, which is dropped (PROTOCOL.md §4).
 */
export const PROMOTED = [
  "normalize-range",
  "below-range",
  "lowest-satisfying",
  "czech-birth-number-valid-brief",
  "german-tax-id-valid-brief",
  "bulgarian-egn-valid",
];
export const DROPPED = ["german-tax-id-valid"];
