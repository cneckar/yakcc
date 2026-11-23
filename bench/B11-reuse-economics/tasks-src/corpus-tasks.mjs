// SPDX-License-Identifier: MIT
// B11 corpus composition tasks (GH #1272). Each task needs two or more atoms that the shave
// corpus fixtures already contain (packages/shave/src/__fixtures__/module-graph). The slice
// candidates are `ref`s to those atoms: `harness/build-tasks.mjs` resolves each ref to the
// exact source span and writes tasks/<id>.json with the text and a line-accurate citation.
//
// Fields:
//   id, entry      the task id and the exported function the held-out check calls
//   difficulty     "compose-2" (two atoms) or "compose-3+" (three or more)
//   atoms          the corpus atoms the composition draws on, as pkg:file#name
//   spec           the only task text a model sees
//   reference      a passing solution; used by the self-test and the offline client only
//   heldOut        the check, run in the vm sandbox; never given to any client
//   slice          candidates: { id, score, ref: { file, name } }. Scores are fixture
//                  scores, set by hand to put the needed atoms first; they are not the
//                  output of a retriever (see README, "Limitations").

export const corpusTasks = [
  {
    id: "add-durations",
    entry: "addDurations",
    difficulty: "compose-2",
    atoms: ["ms-2.1.3:index.js#parse", "ms-2.1.3:index.js#fmtShort"],
    spec: "Write `export function addDurations(a: string, b: string): string` that parses two duration strings in the format of the `ms` package and returns their sum in `ms`'s short format. A duration is a number (optionally negative, optionally fractional, such as `-1.5` or `.5`), optional spaces, then an optional unit, case-insensitive: ms, msec(s), millisecond(s); s, sec(s), second(s); m, min(s), minute(s); h, hr(s), hour(s); d, day(s); w, week(s); y, yr(s), year(s). No unit means milliseconds. A year is 365.25 days and a week is 7 days. The short format takes the absolute sum and uses the first of d, h, m, s whose size it reaches, writing `Math.round(sum / size)` followed by the unit letter; below one second it writes the sum followed by `ms`. Throw a RangeError if either input does not parse.",
    reference: `const S = 1000, M = S * 60, H = M * 60, D = H * 24, W = D * 7, Y = D * 365.25;
const UNITS: Record<string, number> = {
  years: Y, year: Y, yrs: Y, yr: Y, y: Y,
  weeks: W, week: W, w: W,
  days: D, day: D, d: D,
  hours: H, hour: H, hrs: H, hr: H, h: H,
  minutes: M, minute: M, mins: M, min: M, m: M,
  seconds: S, second: S, secs: S, sec: S, s: S,
  milliseconds: 1, millisecond: 1, msecs: 1, msec: 1, ms: 1,
};
function parseDuration(str: string): number {
  const match = /^(-?(?:\\d+)?\\.?\\d+) *([a-z]+)?$/i.exec(str);
  if (!match) throw new RangeError('not a duration: ' + str);
  const unit = (match[2] ?? 'ms').toLowerCase();
  const size = UNITS[unit];
  if (size === undefined) throw new RangeError('unknown unit: ' + unit);
  return parseFloat(match[1]) * size;
}
function formatShort(ms: number): string {
  const abs = Math.abs(ms);
  if (abs >= D) return Math.round(ms / D) + 'd';
  if (abs >= H) return Math.round(ms / H) + 'h';
  if (abs >= M) return Math.round(ms / M) + 'm';
  if (abs >= S) return Math.round(ms / S) + 's';
  return ms + 'ms';
}
export function addDurations(a: string, b: string): string {
  return formatShort(parseDuration(a) + parseDuration(b));
}`,
    heldOut: `const cases = [
  ['1h', '30m', '2h'], ['1d', '-1d', '0ms'], ['2 hours', '15 mins', '2h'], ['500', '500ms', '1s'],
  ['1.5s', '0', '2s'], ['1w', '1d', '8d'], ['-3m', '1m', '-2m'], ['10 Seconds', '20s', '30s'],
  ['.5s', '250ms', '750ms'], ['1y', '0d', '365d'], ['59s', '1s', '1m'], ['1 HR', '1min', '1h'],
];
for (const [a, b, want] of cases) { const got = fn(a, b); if (got !== want) throw new Error('addDurations(' + a + ', ' + b + ') = ' + got + ', want ' + want); }
for (const bad of [['abc', '1s'], ['1s', '5 fortnights'], ['', '1s'], ['1s', '1 s s']]) {
  let threw = false; try { fn(bad[0], bad[1]); } catch (e) { threw = e instanceof RangeError; }
  if (!threw) throw new Error('must throw RangeError for ' + JSON.stringify(bad));
}`,
    slice: [
      { id: "ms-parse", score: 0.86, ref: { file: "ms-2.1.3/index.js", name: "parse" } },
      { id: "ms-fmt-short", score: 0.84, ref: { file: "ms-2.1.3/index.js", name: "fmtShort" } },
      { id: "ms-fmt-long", score: 0.62, ref: { file: "ms-2.1.3/index.js", name: "fmtLong" } },
      {
        id: "date-fns-diff-ms",
        score: 0.41,
        ref: {
          file: "date-fns-4.1.0/differenceInMilliseconds.cjs",
          name: "differenceInMilliseconds",
        },
      },
    ],
  },
  {
    id: "sort-versions",
    entry: "sortVersions",
    difficulty: "compose-3+",
    atoms: [
      "semver-7.8.0:classes/semver.js#compareMain",
      "semver-7.8.0:classes/semver.js#comparePre",
      "semver-7.8.0:internal/identifiers.js#compareIdentifiers",
    ],
    spec: "Write `export function sortVersions(versions: readonly string[]): string[]` that returns a new array of semantic versions sorted ascending by SemVer 2.0.0 precedence, without changing the input. A version is MAJOR.MINOR.PATCH (non-negative integers with no leading zeros), then optionally `-` and a pre-release of dot-separated identifiers (each non-empty, of [0-9A-Za-z-], numeric identifiers have no leading zeros), then optionally `+` and build metadata of dot-separated non-empty [0-9A-Za-z-] identifiers. Precedence compares major, minor and patch numerically; a version with a pre-release is lower than the same version without one; pre-releases compare identifier by identifier, numeric identifiers numerically and lower than alphanumeric ones, alphanumeric ones in ASCII order, and a shorter list is lower when all shared identifiers are equal. Build metadata does not affect precedence, and versions of equal precedence keep their input order. Throw a RangeError if any version is invalid (for example `1.0`, `01.0.0` or `v1.0.0`).",
    reference: `const RE = /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$/;
interface Parsed { main: number[]; pre: string[]; }
function parse(v: string): Parsed {
  const m = RE.exec(v);
  if (!m) throw new RangeError('invalid version: ' + v);
  return { main: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}
function compareIdentifiers(a: string, b: string): number {
  const an = /^\\d+$/.test(a), bn = /^\\d+$/.test(b);
  if (an && bn) { const x = Number(a), y = Number(b); return x === y ? 0 : x < y ? -1 : 1; }
  if (an) return -1;
  if (bn) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}
function compare(a: Parsed, b: Parsed): number {
  for (let i = 0; i < 3; i++) if (a.main[i] !== b.main[i]) return a.main[i] < b.main[i] ? -1 : 1;
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length === 0 ? 0 : a.pre.length === 0 ? 1 : -1;
  for (let i = 0; ; i++) {
    if (i >= a.pre.length && i >= b.pre.length) return 0;
    if (i >= a.pre.length) return -1;
    if (i >= b.pre.length) return 1;
    const c = compareIdentifiers(a.pre[i], b.pre[i]);
    if (c !== 0) return c;
  }
}
export function sortVersions(versions: readonly string[]): string[] {
  const parsed = versions.map((v, i) => ({ v, i, p: parse(v) }));
  parsed.sort((x, y) => compare(x.p, y.p) || x.i - y.i);
  return parsed.map((x) => x.v);
}`,
    heldOut: `const input = ['1.0.0', '1.0.0-rc.1', '1.0.0-beta.11', '1.0.0-beta.2', '1.0.0-beta', '1.0.0-alpha.beta', '1.0.0-alpha.1', '1.0.0-alpha', '10.0.0', '2.0.0', '0.9.9', '1.10.0', '1.2.0'];
const frozen = input.slice();
const got = fn(input);
const want = ['0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.2.0', '1.10.0', '2.0.0', '10.0.0'];
if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error('sortVersions = ' + JSON.stringify(got));
if (JSON.stringify(input) !== JSON.stringify(frozen)) throw new Error('the input was changed');
const ties = fn(['1.0.0+b', '1.0.0+a', '0.1.0']);
if (JSON.stringify(ties) !== JSON.stringify(['0.1.0', '1.0.0+b', '1.0.0+a'])) throw new Error('build metadata must not reorder: ' + JSON.stringify(ties));
const mixed = fn(['1.0.0-a-1', '1.0.0-9', '1.0.0-10', '1.0.0-A']);
if (JSON.stringify(mixed) !== JSON.stringify(['1.0.0-9', '1.0.0-10', '1.0.0-A', '1.0.0-a-1'])) throw new Error('identifier order: ' + JSON.stringify(mixed));
if (fn([]).length !== 0) throw new Error('empty input');
for (const bad of ['1.0', '01.0.0', 'v1.0.0', '1.0.0-', '1.0.0-01', '1.0.0+', '1.0.0-a..b']) {
  let threw = false; try { fn(['1.0.0', bad]); } catch (e) { threw = e instanceof RangeError; }
  if (!threw) throw new Error('must throw RangeError for ' + bad);
}`,
    slice: [
      {
        id: "semver-compare-pre",
        score: 0.88,
        ref: { file: "semver-7.8.0/classes/semver.js", name: "comparePre" },
      },
      {
        id: "semver-compare-main",
        score: 0.87,
        ref: { file: "semver-7.8.0/classes/semver.js", name: "compareMain" },
      },
      {
        id: "semver-compare-identifiers",
        score: 0.85,
        ref: { file: "semver-7.8.0/internal/identifiers.js", name: "compareIdentifiers" },
      },
      {
        id: "semver-compare",
        score: 0.83,
        ref: { file: "semver-7.8.0/classes/semver.js", name: "compare" },
      },
      {
        id: "semver-sort",
        score: 0.8,
        ref: { file: "semver-7.8.0/functions/sort.js", name: "sort" },
      },
      {
        id: "semver-compare-fn",
        score: 0.79,
        ref: { file: "semver-7.8.0/functions/compare.js", name: "compare" },
      },
      {
        id: "levenshtein-closest",
        score: 0.34,
        ref: { file: "fastest-levenshtein-1.0.16/esm/mod.js", name: "closest" },
      },
    ],
  },
  {
    id: "base64url-from-string",
    entry: "base64UrlFromString",
    difficulty: "compose-3+",
    atoms: [
      "base64-js-1.5.1:index.js#fromByteArray",
      "base64-js-1.5.1:index.js#encodeChunk",
      "base64-js-1.5.1:index.js#tripletToBase64",
    ],
    spec: "Write `export function base64UrlFromString(text: string): string` that encodes the text as UTF-8 and returns the bytes in base64url (RFC 4648 section 5: the alphabet A-Z a-z 0-9 `-` `_`) with no padding. Encode by code point: a valid surrogate pair is one code point, and a lone surrogate is encoded as U+FFFD. Do not use Buffer, TextEncoder, btoa or any other host API.",
    reference: `const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function utf8(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
export function base64UrlFromString(text: string): string {
  const bytes = utf8(text);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, bytes.length - i + 1);
    for (let k = 0; k < chars; k++) out += ALPHABET[(n >> (18 - 6 * k)) & 63];
  }
  return out;
}`,
    heldOut: `const cases = [
  ['', ''], ['f', 'Zg'], ['fo', 'Zm8'], ['foo', 'Zm9v'], ['foobar', 'Zm9vYmFy'],
  ['\\u00e9', 'w6k'], ['\\u20ac', '4oKs'], ['\\ud83d\\ude00', '8J-YgA'], ['??>', 'Pz8-'], ['??', 'Pz8'],
  ['\\ud800', '77-9'], ['a\\udc00b', 'Ye-_vWI'], ['\\u007f\\u0080\\u07ff\\u0800', 'f8KA37_goIA'],
];
for (const [text, want] of cases) { const got = fn(text); if (got !== want) throw new Error('base64UrlFromString(' + JSON.stringify(text) + ') = ' + got + ', want ' + want); }`,
    slice: [
      {
        id: "b64-from-byte-array",
        score: 0.87,
        ref: { file: "base64-js-1.5.1/index.js", name: "fromByteArray" },
      },
      {
        id: "b64-encode-chunk",
        score: 0.81,
        ref: { file: "base64-js-1.5.1/index.js", name: "encodeChunk" },
      },
      {
        id: "b64-triplet",
        score: 0.8,
        ref: { file: "base64-js-1.5.1/index.js", name: "tripletToBase64" },
      },
      {
        id: "b64-to-byte-array",
        score: 0.66,
        ref: { file: "base64-js-1.5.1/index.js", name: "toByteArray" },
      },
      {
        id: "uuid-unsafe-stringify",
        score: 0.38,
        ref: { file: "uuid-11.1.1/dist/esm/stringify.js", name: "unsafeStringify" },
      },
    ],
  },
  {
    id: "suggest-words",
    entry: "suggest",
    difficulty: "compose-2",
    atoms: [
      "fastest-levenshtein-1.0.16:esm/mod.js#distance",
      "fastest-levenshtein-1.0.16:esm/mod.js#closest",
    ],
    spec: "Write `export function suggest(word: string, candidates: readonly string[], maxDistance: number): string[]` that returns the candidates whose Levenshtein distance from `word` (insertions, deletions and substitutions of UTF-16 code units, each costing 1) is at most `maxDistance`, sorted by distance ascending, with ties in input order and later duplicates of a string removed. Strings may be longer than 32 characters. Throw a RangeError if maxDistance is not a non-negative integer.",
    reference: `function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
export function suggest(word: string, candidates: readonly string[], maxDistance: number): string[] {
  if (!Number.isInteger(maxDistance) || maxDistance < 0) throw new RangeError('maxDistance must be a non-negative integer');
  const seen = new Set<string>();
  const hits: { s: string; d: number; i: number }[] = [];
  candidates.forEach((s, i) => {
    if (seen.has(s)) return;
    seen.add(s);
    const d = distance(word, s);
    if (d <= maxDistance) hits.push({ s, d, i });
  });
  return hits.sort((x, y) => x.d - y.d || x.i - y.i).map((h) => h.s);
}`,
    heldOut: `const eq = (got, want, label) => { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(label + ' = ' + JSON.stringify(got)); };
eq(fn('kitten', ['sitting', 'kitten', 'mitten', 'bitten', 'smitten', 'kit'], 2), ['kitten', 'mitten', 'bitten', 'smitten'], 'kitten');
eq(fn('kitten', ['sitting', 'kit'], 3), ['sitting', 'kit'], 'ties keep input order');
eq(fn('', ['ab', 'a', ''], 1), ['', 'a'], 'empty word');
eq(fn('ab', ['ab', 'ac', 'ab'], 1), ['ab', 'ac'], 'duplicates');
eq(fn('flaw', ['lawn'], 1), [], 'flaw/lawn is 2');
eq(fn('flaw', ['lawn'], 2), ['lawn'], 'flaw/lawn is 2');
const long = 'a'.repeat(40);
eq(fn(long, ['a'.repeat(39) + 'b', 'b'.repeat(40), 'a'.repeat(38)], 2), ['a'.repeat(39) + 'b', 'a'.repeat(38)], 'long strings');
eq(fn('abc', [], 5), [], 'no candidates');
for (const bad of [-1, 1.5, NaN]) { let threw = false; try { fn('a', ['a'], bad); } catch (e) { threw = e instanceof RangeError; } if (!threw) throw new Error('must throw RangeError for ' + bad); }`,
    slice: [
      {
        id: "lev-distance",
        score: 0.9,
        ref: { file: "fastest-levenshtein-1.0.16/esm/mod.js", name: "distance" },
      },
      {
        id: "lev-closest",
        score: 0.86,
        ref: { file: "fastest-levenshtein-1.0.16/esm/mod.js", name: "closest" },
      },
      {
        id: "lev-myers-32",
        score: 0.7,
        ref: { file: "fastest-levenshtein-1.0.16/esm/mod.js", name: "myers_32" },
      },
      {
        id: "semver-sort",
        score: 0.36,
        ref: { file: "semver-7.8.0/functions/sort.js", name: "sort" },
      },
    ],
  },
  {
    id: "pointer-get",
    entry: "pointerGet",
    difficulty: "compose-3+",
    atoms: [
      "jsonpointer-5.0.1:jsonpointer.js#compilePointer",
      "jsonpointer-5.0.1:jsonpointer.js#untilde",
      "jsonpointer-5.0.1:jsonpointer.js#get",
    ],
    spec: "Write `export function pointerGet(doc: unknown, pointer: string): unknown` that evaluates an RFC 6901 JSON Pointer against a parsed JSON value. The empty pointer returns `doc`. Otherwise the pointer must start with `/`, or throw a SyntaxError. Each reference token is unescaped with `~1` to `/` and then `~0` to `~`; a `~` followed by anything other than 0 or 1 throws a SyntaxError. On an object a token names an own property (never an inherited one such as `constructor`); on an array it must be `0` or a decimal index with no leading zeros and below the length. Return undefined when a token does not resolve, including when a value along the way is not an object or array.",
    reference: `function unescapeToken(token: string): string {
  if (/~(?![01])/.test(token)) throw new SyntaxError('invalid escape in ' + token);
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}
export function pointerGet(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  if (pointer[0] !== '/') throw new SyntaxError('a JSON pointer starts with /');
  const tokens = pointer.slice(1).split('/').map(unescapeToken);
  let cur: unknown = doc;
  for (const token of tokens) {
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\\d*)$/.test(token)) return undefined;
      const i = Number(token);
      if (i >= cur.length) return undefined;
      cur = cur[i];
    } else if (cur !== null && typeof cur === 'object') {
      if (!Object.prototype.hasOwnProperty.call(cur, token)) return undefined;
      cur = (cur as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return cur;
}`,
    heldOut: `const doc = { foo: ['bar', 'baz'], '': 0, 'a/b': 1, 'c%d': 2, 'e^f': 3, 'g|h': 4, 'i\\\\j': 5, 'k"l': 6, ' ': 7, 'm~n': 8, nested: { x: { y: null } }, arr: [[10, 11]] };
const cases = [
  ['', doc], ['/foo', doc.foo], ['/foo/0', 'bar'], ['/', 0], ['/a~1b', 1], ['/c%d', 2], ['/e^f', 3], ['/g|h', 4],
  ['/i\\\\j', 5], ['/k"l', 6], ['/ ', 7], ['/m~0n', 8], ['/nested/x/y', null], ['/arr/0/1', 11],
  ['/foo/2', undefined], ['/foo/01', undefined], ['/foo/-', undefined], ['/missing', undefined],
  ['/nested/x/y/z', undefined], ['/constructor', undefined], ['/foo/length', undefined], ['/m~01n', undefined],
];
for (const [p, want] of cases) { const got = fn(doc, p); if (got !== want) throw new Error('pointerGet(' + JSON.stringify(p) + ') = ' + JSON.stringify(got)); }
const tilde = { '~1': 'x' };
if (fn(tilde, '/~01') !== 'x') throw new Error('~01 must unescape to ~1');
for (const bad of ['foo', '/a~2', '/a~']) { let threw = false; try { fn(doc, bad); } catch (e) { threw = e instanceof SyntaxError; } if (!threw) throw new Error('must throw SyntaxError for ' + bad); }`,
    slice: [
      { id: "jp-get", score: 0.9, ref: { file: "jsonpointer-5.0.1/jsonpointer.js", name: "get" } },
      {
        id: "jp-compile-pointer",
        score: 0.86,
        ref: { file: "jsonpointer-5.0.1/jsonpointer.js", name: "compilePointer" },
      },
      {
        id: "jp-untilde",
        score: 0.84,
        ref: { file: "jsonpointer-5.0.1/jsonpointer.js", name: "untilde" },
      },
      {
        id: "jp-escape-replacer",
        score: 0.8,
        ref: { file: "jsonpointer-5.0.1/jsonpointer.js", name: "escapeReplacer" },
      },
      {
        id: "jp-setter",
        score: 0.68,
        ref: { file: "jsonpointer-5.0.1/jsonpointer.js", name: "setter" },
      },
      {
        id: "date-fns-parse-date",
        score: 0.33,
        ref: { file: "date-fns-4.1.0/parseISO.cjs", name: "parseDate" },
      },
    ],
  },
  {
    id: "build-order",
    entry: "buildOrder",
    difficulty: "compose-3+",
    atoms: [
      "toposort-2.0.2:index.js#uniqueNodes",
      "toposort-2.0.2:index.js#makeOutgoingEdges",
      "toposort-2.0.2:index.js#toposort",
    ],
    spec: "Write `export function buildOrder(deps: Readonly<Record<string, readonly string[]>>): string[]` where `deps` maps each item to the items it depends on. Return every item, including items that appear only as a dependency, ordered so that each item comes after all of its dependencies. When several items are ready at once, take the one that is smallest by string comparison (`<`) first. Throw an Error whose message contains the word `cycle` if the dependencies contain a cycle, including an item that depends on itself.",
    reference: `export function buildOrder(deps: Readonly<Record<string, readonly string[]>>): string[] {
  const nodes = new Set<string>();
  const waiting = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const [item, ds] of Object.entries(deps)) {
    nodes.add(item);
    for (const d of ds) nodes.add(d);
  }
  for (const n of nodes) { waiting.set(n, 0); dependents.set(n, []); }
  for (const [item, ds] of Object.entries(deps)) {
    for (const d of new Set(ds)) {
      waiting.set(item, (waiting.get(item) ?? 0) + 1);
      dependents.get(d)!.push(item);
    }
  }
  const ready = [...nodes].filter((n) => waiting.get(n) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const next = ready.shift()!;
    order.push(next);
    for (const t of dependents.get(next)!) {
      const left = waiting.get(t)! - 1;
      waiting.set(t, left);
      if (left === 0) ready.push(t);
    }
  }
  if (order.length !== nodes.size) throw new Error('dependency cycle');
  return order;
}`,
    heldOut: `const eq = (got, want, label) => { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(label + ' = ' + JSON.stringify(got)); };
eq(fn({ b: ['a'], c: ['a', 'b'], a: [] }), ['a', 'b', 'c'], 'chain');
eq(fn({ app: ['lib', 'util'], lib: ['util'] }), ['util', 'lib', 'app'], 'implicit node');
eq(fn({ z: [], y: [], x: [] }), ['x', 'y', 'z'], 'independent');
eq(fn({ d: ['c'], b: ['a'] }), ['a', 'b', 'c', 'd'], 'ready order');
eq(fn({ b: ['a', 'a'] }), ['a', 'b'], 'duplicate dependency');
eq(fn({}), [], 'empty');
eq(fn({ B: [], a: [] }), ['B', 'a'], 'string order');
for (const bad of [{ a: ['b'], b: ['a'] }, { a: ['a'] }, { a: ['b'], b: ['c'], c: ['a'], d: [] }]) {
  let threw = false; try { fn(bad); } catch (e) { threw = /cycle/i.test(String(e && e.message)); }
  if (!threw) throw new Error('must throw a cycle error for ' + JSON.stringify(bad));
}`,
    slice: [
      {
        id: "topo-toposort",
        score: 0.89,
        ref: { file: "toposort-2.0.2/index.js", name: "toposort" },
      },
      {
        id: "topo-unique-nodes",
        score: 0.84,
        ref: { file: "toposort-2.0.2/index.js", name: "uniqueNodes" },
      },
      {
        id: "topo-outgoing",
        score: 0.83,
        ref: { file: "toposort-2.0.2/index.js", name: "makeOutgoingEdges" },
      },
      {
        id: "topo-nodes-hash",
        score: 0.78,
        ref: { file: "toposort-2.0.2/index.js", name: "makeNodesHash" },
      },
      {
        id: "semver-lru",
        score: 0.3,
        ref: { file: "semver-7.8.0/internal/lrucache.js", name: "LRUCache" },
      },
    ],
  },
  {
    id: "days-between",
    entry: "daysBetween",
    difficulty: "compose-3+",
    atoms: [
      "date-fns-4.1.0:parseISO.cjs#parseDate",
      "date-fns-4.1.0:parseISO.cjs#validateDate",
      "date-fns-4.1.0:differenceInMilliseconds.cjs#differenceInMilliseconds",
    ],
    spec: "Write `export function daysBetween(from: string, to: string): number` for two calendar dates written `YYYY-MM-DD` (exactly four, two and two digits; years 0000 to 9999 in the proleptic Gregorian calendar). Return the number of days from `from` to `to`, negative when `to` is earlier. The result must not depend on the host time zone. Throw a RangeError if either string is malformed or is not a real date (a month outside 1 to 12, or a day outside its month, with February 29 only in leap years).",
    reference: `const DAY_MS = 86400000;
function isLeap(y: number): boolean { return y % 400 === 0 || (y % 4 === 0 && y % 100 !== 0); }
function toUtcMs(s: string): number {
  const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(s);
  if (!m) throw new RangeError('malformed date: ' + s);
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const days = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mo < 1 || mo > 12 || d < 1 || d > days[mo - 1]) throw new RangeError('not a date: ' + s);
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  return date.getTime();
}
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}`,
    heldOut: `const cases = [
  ['2024-01-01', '2024-03-01', 60], ['2023-01-01', '2023-03-01', 59], ['2024-03-01', '2024-01-01', -60],
  ['2000-02-29', '2000-03-01', 1], ['1999-12-31', '2000-01-01', 1], ['2024-05-05', '2024-05-05', 0],
  ['0050-01-01', '0051-01-01', 365], ['0000-01-01', '0001-01-01', 366], ['1970-01-01', '2000-01-01', 10957],
  ['2024-03-30', '2024-04-01', 2], ['2024-10-26', '2024-10-28', 2],
];
for (const [a, b, want] of cases) { const got = fn(a, b); if (got !== want) throw new Error('daysBetween(' + a + ', ' + b + ') = ' + got + ', want ' + want); }
for (const bad of ['1900-02-29', '2023-13-01', '2023-00-10', '2023-1-01', '2023-04-31', '2023-04-00', '20230401', '2023-04-01T00:00', '']) {
  let threw = false; try { fn(bad, '2023-01-01'); } catch (e) { threw = e instanceof RangeError; }
  if (!threw) throw new Error('must throw RangeError for ' + JSON.stringify(bad));
}`,
    slice: [
      {
        id: "dfns-parse-date",
        score: 0.84,
        ref: { file: "date-fns-4.1.0/parseISO.cjs", name: "parseDate" },
      },
      {
        id: "dfns-validate-date",
        score: 0.83,
        ref: { file: "date-fns-4.1.0/parseISO.cjs", name: "validateDate" },
      },
      {
        id: "dfns-leap",
        score: 0.82,
        ref: { file: "date-fns-4.1.0/parseISO.cjs", name: "isLeapYearIndex" },
      },
      {
        id: "dfns-diff-ms",
        score: 0.81,
        ref: {
          file: "date-fns-4.1.0/differenceInMilliseconds.cjs",
          name: "differenceInMilliseconds",
        },
      },
      {
        id: "dfns-parse-iso",
        score: 0.78,
        ref: { file: "date-fns-4.1.0/parseISO.cjs", name: "parseISO" },
      },
      { id: "ms-parse", score: 0.4, ref: { file: "ms-2.1.3/index.js", name: "parse" } },
    ],
  },
  {
    id: "add-days-iso",
    entry: "addDaysIso",
    difficulty: "compose-3+",
    atoms: [
      "date-fns-4.1.0:parseISO.cjs#parseDate",
      "date-fns-4.1.0:addDays.cjs#addDays",
      "date-fns-4.1.0:_lib/addLeadingZeros.cjs#addLeadingZeros",
    ],
    spec: "Write `export function addDaysIso(date: string, days: number): string` that adds a whole number of days to a calendar date written `YYYY-MM-DD` (exactly four, two and two digits; proleptic Gregorian) and returns the result in the same form, with the year zero-padded to four digits. The result must not depend on the host time zone. Throw a RangeError if the date is malformed or not a real date, if `days` is not an integer, or if the result falls outside years 0000 to 9999.",
    reference: `function isLeap(y: number): boolean { return y % 400 === 0 || (y % 4 === 0 && y % 100 !== 0); }
const pad = (n: number, w: number): string => String(n).padStart(w, '0');
export function addDaysIso(date: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError('days must be an integer');
  const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(date);
  if (!m) throw new RangeError('malformed date: ' + date);
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const len = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mo < 1 || mo > 12 || d < 1 || d > len[mo - 1]) throw new RangeError('not a date: ' + date);
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d + days);
  const year = t.getUTCFullYear();
  if (Number.isNaN(year) || year < 0 || year > 9999) throw new RangeError('result out of range');
  return pad(year, 4) + '-' + pad(t.getUTCMonth() + 1, 2) + '-' + pad(t.getUTCDate(), 2);
}`,
    heldOut: `const cases = [
  ['2024-02-28', 1, '2024-02-29'], ['2023-02-28', 1, '2023-03-01'], ['2024-01-01', -1, '2023-12-31'],
  ['2024-01-31', 30, '2024-03-01'], ['0099-12-31', 1, '0100-01-01'], ['2024-06-15', 0, '2024-06-15'],
  ['2000-01-01', 366, '2001-01-01'], ['1970-01-01', -1, '1969-12-31'], ['0000-01-01', 0, '0000-01-01'],
  ['2024-03-30', 2, '2024-04-01'], ['2024-10-26', 2, '2024-10-28'], ['9999-12-30', 1, '9999-12-31'],
];
for (const [d, n, want] of cases) { const got = fn(d, n); if (got !== want) throw new Error('addDaysIso(' + d + ', ' + n + ') = ' + got + ', want ' + want); }
for (const [d, n] of [['2024-02-30', 1], ['2024-01-01', 1.5], ['9999-12-31', 1], ['0000-01-01', -1], ['2024-1-01', 1], ['2023-02-29', 0]]) {
  let threw = false; try { fn(d, n); } catch (e) { threw = e instanceof RangeError; }
  if (!threw) throw new Error('must throw RangeError for ' + d + ', ' + n);
}`,
    slice: [
      {
        id: "dfns-add-days",
        score: 0.88,
        ref: { file: "date-fns-4.1.0/addDays.cjs", name: "addDays" },
      },
      {
        id: "dfns-parse-date",
        score: 0.84,
        ref: { file: "date-fns-4.1.0/parseISO.cjs", name: "parseDate" },
      },
      {
        id: "dfns-validate-date",
        score: 0.82,
        ref: { file: "date-fns-4.1.0/parseISO.cjs", name: "validateDate" },
      },
      {
        id: "dfns-leading-zeros",
        score: 0.8,
        ref: { file: "date-fns-4.1.0/_lib/addLeadingZeros.cjs", name: "addLeadingZeros" },
      },
      {
        id: "dfns-format-iso",
        score: 0.79,
        ref: { file: "date-fns-4.1.0/formatISO.cjs", name: "formatISO" },
      },
      { id: "ms-fmt-short", score: 0.37, ref: { file: "ms-2.1.3/index.js", name: "fmtShort" } },
    ],
  },
  {
    id: "uuid-version",
    entry: "uuidVersion",
    difficulty: "compose-2",
    atoms: ["uuid-11.1.1:dist/esm/validate.js#validate", "uuid-11.1.1:dist/esm/version.js#version"],
    spec: "Write `export function uuidVersion(value: string): number` that returns the version of a UUID string. A valid UUID is 8-4-4-4-12 hexadecimal digits separated by hyphens, in any letter case, whose version digit (the first digit of the third group) is 1 to 8 and whose variant digit (the first digit of the fourth group) is 8, 9, a or b; the nil UUID (all zeros) and the max UUID (all f) are also valid. The version is the version digit as a number, which is 0 for the nil UUID and 15 for the max UUID. Throw a TypeError for anything else, including surrounding spaces or braces.",
    reference: `const RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
export function uuidVersion(value: string): number {
  if (typeof value !== 'string' || !RE.test(value)) throw new TypeError('invalid UUID');
  return parseInt(value.slice(14, 15), 16);
}`,
    heldOut: `const cases = [
  ['6ba7b810-9dad-11d1-80b4-00c04fd430c8', 1], ['a3bb189e-8bf9-3888-9912-ace4e6543002', 3],
  ['109156be-c4fb-41ea-b1b4-efe1671c5836', 4], ['A3BB189E-8BF9-5888-9912-ACE4E6543002', 5],
  ['1ef21d2f-1207-6660-8c4f-419efbd44d48', 6], ['017f22e2-79b0-7cc3-98c4-dc0c0c07398f', 7],
  ['320c3d4d-cc00-875b-8ec9-32d5f69181c0', 8], ['00000000-0000-0000-0000-000000000000', 0],
  ['FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF', 15],
];
for (const [u, want] of cases) { const got = fn(u); if (got !== want) throw new Error('uuidVersion(' + u + ') = ' + got + ', want ' + want); }
for (const bad of ['', '109156be-c4fb-01ea-b1b4-efe1671c5836', '109156be-c4fb-91ea-b1b4-efe1671c5836', '109156be-c4fb-41ea-c1b4-efe1671c5836', '109156bec4fb41eab1b4efe1671c5836', ' 109156be-c4fb-41ea-b1b4-efe1671c5836', '{109156be-c4fb-41ea-b1b4-efe1671c5836}', '109156be-c4fb-41ea-b1b4-efe1671c583g', '00000000-0000-0000-0000-00000000000f']) {
  let threw = false; try { fn(bad); } catch (e) { threw = e instanceof TypeError; }
  if (!threw) throw new Error('must throw TypeError for ' + JSON.stringify(bad));
}`,
    slice: [
      {
        id: "uuid-version-fn",
        score: 0.9,
        ref: { file: "uuid-11.1.1/dist/esm/version.js", name: "version" },
      },
      {
        id: "uuid-validate",
        score: 0.88,
        ref: { file: "uuid-11.1.1/dist/esm/validate.js", name: "validate" },
      },
      {
        id: "uuid-parse",
        score: 0.7,
        ref: { file: "uuid-11.1.1/dist/esm/parse.js", name: "parse" },
      },
      {
        id: "semver-compare-identifiers",
        score: 0.32,
        ref: { file: "semver-7.8.0/internal/identifiers.js", name: "compareIdentifiers" },
      },
    ],
  },
  {
    id: "uuid-normalize",
    entry: "normalizeUuid",
    difficulty: "compose-3+",
    atoms: [
      "uuid-11.1.1:dist/esm/validate.js#validate",
      "uuid-11.1.1:dist/esm/parse.js#parse",
      "uuid-11.1.1:dist/esm/stringify.js#unsafeStringify",
    ],
    spec: "Write `export function normalizeUuid(value: string): string` that accepts a UUID written as 32 hexadecimal digits in any letter case, either grouped 8-4-4-4-12 with hyphens or with no hyphens at all, optionally wrapped in braces (`{...}`) or prefixed with `urn:uuid:` (the prefix in any letter case), and returns it as lowercase 8-4-4-4-12 with hyphens. The result must be a valid UUID: version digit (first digit of the third group) 1 to 8 and variant digit (first digit of the fourth group) 8, 9, a or b, or else the nil UUID (all zeros) or the max UUID (all f). Throw a TypeError for anything else, including partial hyphenation, both a brace and a prefix, or surrounding spaces.",
    reference: `const VALID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
export function normalizeUuid(value: string): string {
  let s = value;
  if (/^urn:uuid:/i.test(s)) s = s.slice(9);
  else if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1);
  let hex: string;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) hex = s.replace(/-/g, '');
  else if (/^[0-9a-f]{32}$/i.test(s)) hex = s;
  else throw new TypeError('invalid UUID: ' + value);
  hex = hex.toLowerCase();
  const out = hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  if (!VALID.test(out)) throw new TypeError('invalid UUID: ' + value);
  return out;
}`,
    heldOut: `const want = '109156be-c4fb-41ea-b1b4-efe1671c5836';
for (const input of [want, want.toUpperCase(), want.replace(/-/g, ''), '{' + want + '}', 'urn:uuid:' + want, 'URN:UUID:' + want.toUpperCase(), '{' + want.replace(/-/g, '') + '}']) {
  const got = fn(input); if (got !== want) throw new Error('normalizeUuid(' + input + ') = ' + got);
}
if (fn('00000000000000000000000000000000') !== '00000000-0000-0000-0000-000000000000') throw new Error('nil');
if (fn('{FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF}') !== 'ffffffff-ffff-ffff-ffff-ffffffffffff') throw new Error('max');
for (const bad of ['', '109156be-c4fb41ea-b1b4-efe1671c5836', '109156bec4fb01eab1b4efe1671c5836', '109156be-c4fb-41ea-71b4-efe1671c5836', ' ' + want, '{urn:uuid:' + want + '}', 'urn:uuid:{' + want + '}', '{' + want, want + '0', 'urn:uuid:']) {
  let threw = false; try { fn(bad); } catch (e) { threw = e instanceof TypeError; }
  if (!threw) throw new Error('must throw TypeError for ' + JSON.stringify(bad));
}`,
    slice: [
      {
        id: "uuid-parse",
        score: 0.86,
        ref: { file: "uuid-11.1.1/dist/esm/parse.js", name: "parse" },
      },
      {
        id: "uuid-unsafe-stringify",
        score: 0.85,
        ref: { file: "uuid-11.1.1/dist/esm/stringify.js", name: "unsafeStringify" },
      },
      {
        id: "uuid-validate",
        score: 0.84,
        ref: { file: "uuid-11.1.1/dist/esm/validate.js", name: "validate" },
      },
      {
        id: "uuid-stringify",
        score: 0.82,
        ref: { file: "uuid-11.1.1/dist/esm/stringify.js", name: "stringify" },
      },
      {
        id: "uuid-version-fn",
        score: 0.74,
        ref: { file: "uuid-11.1.1/dist/esm/version.js", name: "version" },
      },
      {
        id: "b64-to-byte-array",
        score: 0.35,
        ref: { file: "base64-js-1.5.1/index.js", name: "toByteArray" },
      },
    ],
  },
  {
    id: "memoize-lru",
    entry: "memoizeLru",
    difficulty: "compose-2",
    atoms: ["lodash-4.17.21:memoize.js#memoize", "semver-7.8.0:internal/lrucache.js#LRUCache"],
    spec: "Write `export function memoizeLru<A, R>(fn: (arg: A) => R, max: number): ((arg: A) => R) & { size(): number }` that returns a memoized version of the one-argument function `fn`. Results are cached by argument, compared as a Map compares keys. The cache holds at most `max` entries and, when full, evicts the least recently used entry, where both a hit and a store count as a use. A result of `undefined` is cached like any other. `size()` returns the number of cached entries. If `fn` throws, nothing is cached and the error propagates. Throw a RangeError if `max` is not a positive integer.",
    reference: `export function memoizeLru<A, R>(fn: (arg: A) => R, max: number): ((arg: A) => R) & { size(): number } {
  if (!Number.isInteger(max) || max < 1) throw new RangeError('max must be a positive integer');
  const cache = new Map<A, R>();
  const memo = ((arg: A): R => {
    if (cache.has(arg)) {
      const v = cache.get(arg) as R;
      cache.delete(arg);
      cache.set(arg, v);
      return v;
    }
    const v = fn(arg);
    if (cache.size >= max) cache.delete(cache.keys().next().value as A);
    cache.set(arg, v);
    return v;
  }) as ((arg: A) => R) & { size(): number };
  memo.size = () => cache.size;
  return memo;
}`,
    heldOut: `let calls = [];
const f = fn((x) => { calls.push(x); return x === 'u' ? undefined : String(x) + '!'; }, 2);
const expect = (got, want, label) => { if (got !== want) throw new Error(label + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); };
expect(f('a'), 'a!', 'a'); expect(f('a'), 'a!', 'a again'); expect(calls.join(','), 'a', 'a is cached');
expect(f('b'), 'b!', 'b'); expect(f('a'), 'a!', 'a hit'); expect(f('c'), 'c!', 'c evicts b');
expect(f('a'), 'a!', 'a stays'); expect(f('b'), 'b!', 'b recomputed'); expect(calls.join(','), 'a,b,c,b', 'eviction order');
expect(f.size(), 2, 'size');
calls = [];
expect(f('u'), undefined, 'u'); expect(f('u'), undefined, 'u again'); expect(calls.join(','), 'u', 'undefined is cached');
const g = fn((x) => { calls.push(x); return 1; }, 3); calls = [];
g(NaN); g(NaN); g(0); g(-0); expect(calls.length, 2, 'SameValueZero keys');
const key = {}; g(key); g({}); expect(calls.length, 4, 'object identity');
let n = 0; const h = fn((x) => { n++; if (x === 'boom') throw new Error('boom'); return x; }, 1);
for (let i = 0; i < 2; i++) { try { h('boom'); } catch (e) { if (e.message !== 'boom') throw e; } }
expect(n, 2, 'errors are not cached'); expect(h.size(), 0, 'nothing cached after a throw');
for (const bad of [0, -1, 1.5, NaN]) { let threw = false; try { fn((x) => x, bad); } catch (e) { threw = e instanceof RangeError; } if (!threw) throw new Error('must throw RangeError for ' + bad); }`,
    slice: [
      {
        id: "lodash-memoize",
        score: 0.87,
        ref: { file: "lodash-4.17.21/memoize.js", name: "memoize" },
      },
      {
        id: "semver-lru",
        score: 0.85,
        ref: { file: "semver-7.8.0/internal/lrucache.js", name: "LRUCache" },
      },
      {
        id: "lodash-memoize-capped",
        score: 0.72,
        ref: { file: "lodash-4.17.21/_memoizeCapped.js", name: "memoizeCapped" },
      },
      {
        id: "topo-nodes-hash",
        score: 0.31,
        ref: { file: "toposort-2.0.2/index.js", name: "makeNodesHash" },
      },
    ],
  },
];
