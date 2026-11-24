// SPDX-License-Identifier: MIT
// B14 tasks: module-scale work where reusing a corpus module could replace writing a lot of
// code. Each task:
//   id, spec        the only task text a model sees (exports `solve`)
//   lib             the corpus module that implements the hard part (hidden from the model; used
//                   to grade whether the reuse arm found it, and by the offline client)
//   referenceGlue   a passing solution that reuses lib (the offline client's reuse answer)
//   referenceScratch  a passing standalone solution, for the small tasks only (the offline
//                   client's scratch answer; the large ones have none on purpose)
//   cases / check   the held-out test: tagged-JSON cases ({args, returns} or {args, throws})
//                   and, where values need it, a custom check that receives `fn`. Never shown
//                   to any client.
// Expected values follow the published semantics (semver, ISO 8601, RFC 4122, RFC 1321), and
// were cross-checked against the corpus modules.

export const tasks = [
  {
    id: "best-compatible-version",
    size: "large",
    lib: { file: "semver-7.8.0/ranges/max-satisfying.js", name: "maxSatisfying" },
    spec: "Write `export function solve(installed: string[], range: string): string | null` that returns the highest version in `installed` that satisfies the npm semver range expression `range`, or null when none does. Ranges use npm semantics: caret, tilde and x-ranges, hyphen ranges, space-separated comparator sets, and alternatives joined by `||`. A prerelease version only satisfies a range that names a prerelease on the same major.minor.patch. Ignore strings in `installed` that are not valid versions.",
    referenceGlue:
      "export function solve(installed: string[], range: string) { return lib.maxSatisfying(installed, range); }",
    cases: [
      { args: [["1.2.3", "1.4.0", "2.0.0", "1.5.0-beta.1"], "^1.2.0"], returns: "1.4.0" },
      { args: [["0.2.1", "0.3.0"], "^0.2.0"], returns: "0.2.1" },
      { args: [["1.0.0", "2.5.0", "3.0.0"], "1.x || >=2.5 <3"], returns: "2.5.0" },
      {
        args: [["1.2.3-alpha.3", "1.2.3-alpha.7", "1.2.4"], ">=1.2.3-alpha.4 <1.2.4"],
        returns: "1.2.3-alpha.7",
      },
      { args: [["1.0.0"], "^2"], returns: null },
      { args: [["1.2.3", "1.2.9", "1.3.0"], "~1.2.1"], returns: "1.2.9" },
      { args: [["1.0.0", "1.2.0", "1.3.0"], "1.0.0 - 1.2.0"], returns: "1.2.0" },
      { args: [["abc", "1.0.0"], "*"], returns: "1.0.0" },
    ],
  },
  {
    id: "range-within-range",
    size: "large",
    lib: { file: "semver-7.8.0/ranges/subset.js", name: "subset" },
    spec: "Write `export function solve(sub: string, sup: string): boolean` that returns true when every version matched by the npm semver range `sub` is also matched by the range `sup`, with npm range semantics (caret, tilde, x-ranges, hyphen ranges, comparator sets, `||` alternatives).",
    referenceGlue:
      "export function solve(sub: string, sup: string) { return lib.subset(sub, sup); }",
    cases: [
      { args: ["^1.2.0", "^1.0.0"], returns: true },
      { args: ["^1.0.0", "^1.2.0"], returns: false },
      { args: ["1.2.x", ">=1.2.0 <1.3.0"], returns: true },
      { args: ["^1.0.0 || ^2.0.0", ">=1.0.0 <3.0.0"], returns: true },
      { args: [">=1.0.0", "^1.0.0"], returns: false },
      { args: ["~1.2.3", "^1.2.3"], returns: true },
    ],
  },
  {
    id: "sort-iso-timestamps",
    size: "large",
    lib: { file: "date-fns-4.1.0/parseISO.cjs", name: "parseISO" },
    spec: "Write `export function solve(stamps: string[]): number[]` that parses ISO 8601 strings and returns their epoch milliseconds sorted ascending. Accept calendar dates (`2024-02-29`), week dates (`2024-W09-4`), ordinal dates (`2024-060`), an optional time with fractional seconds, and an optional `Z` or `±hh:mm` offset; a string without an offset is in UTC. Throw a RangeError if any string is not a valid date.",
    referenceGlue:
      "export function solve(stamps: string[]) { const ms = stamps.map((s) => lib.parseISO(s).getTime()); if (ms.some((m) => Number.isNaN(m))) throw new RangeError('invalid date'); return ms.sort((a, b) => a - b); }",
    cases: [
      { args: [["2024-02-29T10:00:00Z", "2024-02-29"]], returns: [1709164800000, 1709200800000] },
      { args: [["2024-W09-4", "2024-060"]], returns: [1709164800000, 1709164800000] },
      {
        args: [["2024-03-01T01:30:00.250+02:00", "2024-02-29T10:00:00Z"]],
        returns: [1709200800000, 1709249400250],
      },
      { args: [["2024-02-30"]], throws: true },
      { args: [["not a date"]], throws: true },
    ],
  },
  {
    id: "deep-copy",
    size: "large",
    lib: { file: "lodash-4.17.21/cloneDeep.js", name: "cloneDeep" },
    spec: "Write `export function solve<T>(value: T): T` that returns a deep copy: nested plain objects and arrays, Maps, Sets, Dates, RegExps and typed arrays are copied, not shared, and a circular reference in the input becomes the same circular reference in the copy.",
    referenceGlue: "export function solve(value: any) { return lib.cloneDeep(value); }",
    check: `const src = { a: [1, { b: 2 }], m: new Map([["k", { v: 1 }]]), s: new Set([1, 2]), d: new Date(0), r: /x/g, t: new Uint8Array([1, 2]) };
src.self = src;
const c = fn(src);
if (c === src || c.a === src.a || c.a[1] === src.a[1]) throw new Error("not deep");
if (c.a[1].b !== 2 || c.m.get("k").v !== 1 || c.m.get("k") === src.m.get("k")) throw new Error("map");
if (!(c.s instanceof Set) || c.s.size !== 2 || c.s === src.s) throw new Error("set");
if (!(c.d instanceof Date) || c.d === src.d || c.d.getTime() !== 0) throw new Error("date");
if (!(c.r instanceof RegExp) || c.r === src.r || c.r.source !== "x" || !c.r.global) throw new Error("regexp");
if (!(c.t instanceof Uint8Array) || c.t === src.t || c.t[1] !== 2) throw new Error("typed array");
if (c.self !== c) throw new Error("cycle");`,
  },
  {
    id: "apply-path-updates",
    size: "large",
    lib: { file: "lodash-4.17.21/set.js", name: "set" },
    spec: "Write `export function solve(obj: object, updates: [string | (string | number)[], unknown][]): object` that applies each update to `obj` in order: the path is a string like `a.b[0].c` or an array of keys, and missing containers along the way are created, an array when the next key is an integer index and an object otherwise. Mutate and return `obj`.",
    referenceGlue:
      "export function solve(obj: object, updates: any[]) { for (const [p, v] of updates) lib.set(obj, p, v); return obj; }",
    cases: [
      { args: [{}, [["a.b[0].c", 1]]], returns: { a: { b: [{ c: 1 }] } } },
      {
        args: [
          { a: { x: 1 } },
          [
            ["a.y", 2],
            [["a", "z"], 3],
          ],
        ],
        returns: { a: { x: 1, y: 2, z: 3 } },
      },
      {
        args: [
          {},
          [
            ["list[0].name", "b"],
            ["list[1]", "c"],
          ],
        ],
        returns: { list: [{ name: "b" }, "c"] },
      },
      { args: [{ a: 1 }, [["a", 5]]], returns: { a: 5 } },
    ],
  },
  {
    id: "canonical-emails",
    size: "medium",
    lib: { file: "validator-13.15.35/lib/normalizeEmail.js", name: "normalizeEmail" },
    spec: "Write `export function solve(emails: string[]): string[]` that canonicalizes email addresses for deduplication and returns the distinct canonical forms in first-seen order. Lowercase the whole address. For gmail.com and googlemail.com, also remove dots and any `+suffix` from the local part, and use the domain gmail.com. For outlook.com, hotmail.com and live.com, remove any `+suffix`. Leave other domains lowercased only.",
    referenceGlue:
      "export function solve(emails: string[]) { const out: string[] = []; for (const e of emails) { const n = lib.normalizeEmail(e); if (typeof n === 'string' && !out.includes(n)) out.push(n); } return out; }",
    cases: [
      {
        args: [["Foo.Bar+news@Gmail.com", "foobar@googlemail.com", "Alice@Example.org"]],
        returns: ["foobar@gmail.com", "alice@example.org"],
      },
      {
        args: [["x+y@outlook.com", "X@Outlook.com", "a.b@example.com"]],
        returns: ["x@outlook.com", "a.b@example.com"],
      },
    ],
  },
  {
    id: "keep-valid-urls",
    size: "large",
    lib: { file: "validator-13.15.35/lib/isURL.js", name: "isURL" },
    spec: "Write `export function solve(urls: string[]): string[]` that keeps, in order, the strings that are valid absolute http or https URLs whose host is a fully qualified domain name (a top-level domain is required, so `localhost` is rejected). Ports, paths and query strings are allowed. Reject other protocols, strings without a protocol, and strings with spaces.",
    referenceGlue:
      "export function solve(urls: string[]) { return urls.filter((u) => lib.isURL(u, { protocols: ['http', 'https'], require_protocol: true, require_tld: true })); }",
    cases: [
      {
        args: [
          [
            "https://example.com/a?b=1",
            "http://example.com:8080",
            "ftp://example.com",
            "example.com",
          ],
        ],
        returns: ["https://example.com/a?b=1", "http://example.com:8080"],
      },
      {
        args: [["http://localhost:3000", "https://sub.example.co.uk/x", "http://exa mple.com"]],
        returns: ["https://sub.example.co.uk/x"],
      },
    ],
  },
  {
    id: "name-based-uuid",
    size: "large",
    lib: { file: "uuid-11.1.1/dist/cjs-browser/v5.js", name: "v5" },
    spec: "Write `export function solve(name: string, namespace: string): string` that returns the RFC 4122 version-5 UUID for `name` in `namespace` (a UUID string): SHA-1 over the namespace's 16 bytes followed by the UTF-8 bytes of the name, with the version and variant bits set, formatted lowercase 8-4-4-4-12. Do not use any host crypto API.",
    referenceGlue:
      "export function solve(name: string, namespace: string) { return lib.v5(name, namespace); }",
    cases: [
      {
        args: ["www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"],
        returns: "2ed6657d-e927-568b-95e1-2665a8aea6a2",
      },
      {
        args: ["https://example.com/a", "6ba7b811-9dad-11d1-80b4-00c04fd430c8"],
        returns: "6639460f-3425-5329-8097-a58f06127860",
      },
    ],
  },
  {
    id: "md5-hex",
    size: "large",
    lib: { file: "uuid-11.1.1/dist/cjs-browser/md5.js", name: "md5" },
    spec: "Write `export function solve(text: string): string` that returns the MD5 digest (RFC 1321) of the UTF-8 bytes of `text` as 32 lowercase hex characters. Do not use any host crypto API.",
    referenceGlue:
      "export function solve(text: string) { const b: number[] = []; for (const ch of text) { const c = ch.codePointAt(0)!; if (c < 0x80) b.push(c); else if (c < 0x800) b.push(0xc0 | (c >> 6), 0x80 | (c & 63)); else if (c < 0x10000) b.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); else b.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); } return Array.from(lib.md5(Uint8Array.from(b)) as Uint8Array).map((x) => x.toString(16).padStart(2, '0')).join(''); }",
    cases: [
      { args: ["abc"], returns: "900150983cd24fb0d6963f7d28e17f72" },
      { args: [""], returns: "d41d8cd98f00b204e9800998ecf8427e" },
      {
        args: ["The quick brown fox jumps over the lazy dog"],
        returns: "9e107d9d372bb6826bd81d3542a419d6",
      },
    ],
  },
  {
    id: "spell-suggest",
    size: "medium",
    lib: { file: "fastest-levenshtein-1.0.16/esm/mod.js", name: "closest" },
    spec: "Write `export function solve(word: string, dictionary: string[]): string` that returns the dictionary entry with the smallest Levenshtein edit distance (single-character insertions, deletions and substitutions) from `word`, taking the first on a tie.",
    referenceGlue:
      "export function solve(word: string, dictionary: string[]) { return lib.closest(word, dictionary); }",
    referenceScratch:
      "export function solve(word: string, dictionary: string[]) { const d = (a: string, b: string) => { let p = Array.from({ length: b.length + 1 }, (_, j) => j); for (let i = 1; i <= a.length; i++) { const c = [i]; for (let j = 1; j <= b.length; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; } return p[b.length]; }; let best = dictionary[0], bd = Infinity; for (const w of dictionary) { const x = d(word, w); if (x < bd) { bd = x; best = w; } } return best; }",
    cases: [
      { args: ["kiten", ["sitting", "kitten", "bitten"]], returns: "kitten" },
      { args: ["abc", ["xyz", "abd", "abe"]], returns: "abd" },
      {
        args: ["a".repeat(40), ["b".repeat(40), `${"a".repeat(39)}b`]],
        returns: `${"a".repeat(39)}b`,
      },
    ],
  },
  {
    id: "build-order",
    size: "small",
    lib: { file: "toposort-2.0.2/index.js", name: "toposort" },
    spec: "Write `export function solve(nodes: string[], edges: [string, string][]): string[]` that orders `nodes` so that for every edge [a, b], a comes before b. Throw an Error when the edges contain a cycle or mention a node that is not in `nodes`.",
    referenceGlue:
      "export function solve(nodes: string[], edges: [string, string][]) { return lib.toposort(nodes, edges); }",
    referenceScratch:
      "export function solve(nodes: string[], edges: [string, string][]) { const set = new Set(nodes); const indeg = new Map(nodes.map((n) => [n, 0])); const out = new Map(nodes.map((n) => [n, [] as string[]])); for (const [a, b] of edges) { if (!set.has(a) || !set.has(b)) throw new Error('unknown node'); out.get(a)!.push(b); indeg.set(b, indeg.get(b)! + 1); } const q = nodes.filter((n) => indeg.get(n) === 0); const r: string[] = []; while (q.length) { const n = q.shift()!; r.push(n); for (const m of out.get(n)!) { indeg.set(m, indeg.get(m)! - 1); if (indeg.get(m) === 0) q.push(m); } } if (r.length !== nodes.length) throw new Error('cycle'); return r; }",
    check: `const order = fn(["c", "b", "a"], [["a", "b"], ["b", "c"]]);
if (JSON.stringify(order) !== JSON.stringify(["a", "b", "c"])) throw new Error("order " + JSON.stringify(order));
let threw = false; try { fn(["x", "y"], [["x", "y"], ["y", "x"]]); } catch (e) { threw = true; } if (!threw) throw new Error("cycle must throw");
threw = false; try { fn(["x"], [["x", "z"]]); } catch (e) { threw = true; } if (!threw) throw new Error("unknown node must throw");`,
  },
  {
    id: "base64-decode",
    size: "small",
    lib: { file: "base64-js-1.5.1/index.js", name: "toByteArray" },
    spec: "Write `export function solve(text: string): number[]` that decodes standard base64 (alphabet A-Z a-z 0-9 + /, with `=` padding) into an array of byte values. Throw an Error when the length is not a multiple of 4. Do not use Buffer or atob.",
    referenceGlue:
      "export function solve(text: string) { return Array.from(lib.toByteArray(text) as Uint8Array); }",
    referenceScratch:
      "export function solve(text: string) { if (text.length % 4 !== 0) throw new Error('length'); const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; const out: number[] = []; for (let i = 0; i < text.length; i += 4) { const q = text.slice(i, i + 4); const v = [...q].map((c) => (c === '=' ? 0 : A.indexOf(c))); const n = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3]; out.push((n >> 16) & 255); if (q[2] !== '=') out.push((n >> 8) & 255); if (q[3] !== '=') out.push(n & 255); } return out; }",
    cases: [
      { args: ["Zm9v"], returns: [102, 111, 111] },
      { args: ["Zg=="], returns: [102] },
      { args: ["//8="], returns: [255, 255] },
      { args: ["abc"], throws: true },
    ],
  },
  {
    id: "iso-utc-string",
    size: "small",
    lib: { file: "date-fns-4.1.0/formatISO.cjs", name: "formatISO" },
    spec: "Write `export function solve(epochMs: number): string` that formats the instant as an ISO 8601 date-time in UTC without fractional seconds, like `2024-02-29T10:00:00Z`.",
    referenceGlue:
      "export function solve(epochMs: number) { return lib.formatISO(new Date(epochMs)); }",
    referenceScratch:
      "export function solve(epochMs: number) { return new Date(epochMs).toISOString().replace(/\\.\\d{3}Z$/, 'Z'); }",
    cases: [
      { args: [1709200800000], returns: "2024-02-29T10:00:00Z" },
      { args: [0], returns: "1970-01-01T00:00:00Z" },
      { args: [1709249400250], returns: "2024-02-29T23:30:00Z" },
    ],
  },
];
