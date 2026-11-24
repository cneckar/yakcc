// SPDX-License-Identifier: MIT
// B16 tasks: B14's 13 module-scale tasks plus B16's new ones (tasks-new.mjs), each tagged with a
// family. B14's tasks had 0–8 hand cases each; B16 adds seeded fuzz inputs to them (EXTRA
// below), with expected values from the same reference, so a solution that is right on the
// hand cases but wrong on the general behavior fails. Held-out cases are built by
// harness/build-cases.mjs into cases/<id>.json; see PROTOCOL.md.
import { tasks as b14 } from "../B14-module-reuse/tasks.mjs";
import { newTasks } from "./tasks-new.mjs";

const pick = (rng, xs) => xs[rng.int(xs.length)];
const str = (rng, alphabet, min, max) =>
  Array.from({ length: min + rng.int(max - min + 1) }, () => pick(rng, alphabet)).join("");
const hex = (rng, n) => Array.from({ length: n }, () => "0123456789abcdef"[rng.int(16)]).join("");
const pad = (n, w = 2) => String(n).padStart(w, "0");
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
  ])();
const isoStamp = (rng) => {
  const y = 1990 + rng.int(60);
  const time = () =>
    rng.int(2)
      ? `T${pad(rng.int(24))}:${pad(rng.int(60))}${rng.int(2) ? `:${pad(rng.int(60))}${rng.int(2) ? `.${pad(rng.int(1000), 3)}` : ""}` : ""}${pick(rng, ["", "Z", `+${pad(rng.int(14))}:${pad(pick(rng, [0, 30, 45]))}`, `-${pad(rng.int(12))}:00`])}`
      : "";
  return pick(rng, [
    () => `${y}-${pad(1 + rng.int(12))}-${pad(1 + rng.int(31))}${time()}`,
    () => `${y}-W${pad(1 + rng.int(53))}-${1 + rng.int(7)}${time()}`,
    () => `${y}-${pad(1 + rng.int(366), 3)}${time()}`,
  ])();
};

/** Fuzz generators for B14's tasks (tasks with only a custom check keep it as their test). */
const EXTRA = {
  // Half the ranges are built around a listed version, so most cases have a match.
  "best-compatible-version": (rng) =>
    Array.from({ length: 30 }, () => {
      const vs = Array.from({ length: 2 + rng.int(7) }, () => version(rng));
      const v = pick(rng, vs).replace(/-.*/, "");
      return [
        vs,
        rng.int(2)
          ? range(rng)
          : pick(rng, [`^${v}`, `~${v}`, `>=${v}`, `<=${v}`, `${v.split(".")[0]}.x`]),
      ];
    }),
  // Half the pairs are built to nest (tilde inside caret, x-range inside caret, caret inside >=).
  "range-within-range": (rng) =>
    Array.from({ length: 30 }, () => {
      if (rng.int(2)) return [range(rng), range(rng)];
      const [ma, mi, pa] = [1 + rng.int(3), rng.int(5), rng.int(5)];
      return pick(rng, [
        [`~${ma}.${mi}.${pa}`, `^${ma}.${mi}.${pa}`],
        [`${ma}.${mi}.x`, `^${ma}.0.0`],
        [`^${ma}.${mi}.${pa}`, `>=${ma}.0.0`],
        [`^${ma}.${mi}.${pa}`, `~${ma}.${mi}.${pa}`],
        [`${ma}.${mi}.${pa} - ${ma}.${mi + 1}.0`, `^${ma}.${mi}.0 || ^${ma + 1}.0.0`],
      ]);
    }),
  "sort-iso-timestamps": (rng) => [
    // Invalid dates must throw: no Feb 29 in a common year, no day 366 in a common year, no
    // month 13, no hour 25. (Week 53 of a 52-week year is left out: date-fns accepts it, and
    // the spec does not say either way.)
    [["2023-02-29"]],
    [["2023-366"]],
    [["2024-13-01"]],
    [["2024-02-29T25:00"]],
    [["2020-W53-7", "2020-366", "2020-02-29T23:59:59.999-00:30"]],
    ...Array.from({ length: 30 }, () => [
      Array.from({ length: 1 + rng.int(4) }, () => isoStamp(rng)),
    ]),
  ],
  "apply-path-updates": (rng) =>
    Array.from({ length: 20 }, () => [
      {},
      Array.from({ length: 1 + rng.int(4) }, () => {
        const keys = Array.from({ length: 1 + rng.int(3) }, () =>
          rng.int(3) ? pick(rng, ["a", "b", "c"]) : 0,
        );
        const path = rng.int(2)
          ? keys
          : keys.map((k, i) => (typeof k === "number" ? `[${k}]` : `${i ? "." : ""}${k}`)).join("");
        return [path, rng.int(100)];
      }),
    ]),
  "canonical-emails": (rng) =>
    Array.from({ length: 20 }, () => [
      Array.from({ length: 1 + rng.int(5) }, () => {
        const local = `${str(rng, [..."abcAB."], 1, 6).replace(/^\.|\.$/g, "x")}${rng.int(2) ? `+${str(rng, [..."xyz"], 1, 4)}` : ""}`;
        return `${local}@${pick(rng, ["gmail.com", "GoogleMail.com", "outlook.com", "Hotmail.com", "live.com", "example.org", "Company.com"])}`;
      }),
    ]),
  "keep-valid-urls": (rng) =>
    Array.from({ length: 20 }, () => [
      Array.from({ length: 1 + rng.int(5) }, () => {
        const proto = pick(rng, ["http://", "https://", "https://", "ftp://", ""]);
        const host = pick(rng, [
          "example.com",
          "sub.example.co.uk",
          "localhost",
          "exa mple.com",
          "example",
          "a-b.example.org",
        ]);
        return `${proto}${host}${pick(rng, ["", ":8080", ":443"])}${pick(rng, ["", "/", "/a/b", "/p?q=1&r=2", "#frag"])}`;
      }),
    ]),
  "name-based-uuid": (rng) =>
    Array.from({ length: 20 }, () => [
      str(rng, TEXT, 0, 60),
      `${hex(rng, 8)}-${hex(rng, 4)}-4${hex(rng, 3)}-a${hex(rng, 3)}-${hex(rng, 12)}`,
    ]),
  "md5-hex": (rng) => [
    ...[55, 56, 63, 64, 65, 119, 120].map((n) => ["a".repeat(n)]),
    ...Array.from({ length: 20 }, () => [str(rng, TEXT, 0, 130)]),
  ],
  "spell-suggest": (rng) =>
    Array.from({ length: 20 }, () => [
      str(rng, [..."abcde"], 1, 8),
      Array.from({ length: 1 + rng.int(6) }, () => str(rng, [..."abcde"], 1, 8)),
    ]),
  "base64-decode": (rng) =>
    Array.from({ length: 20 }, () => {
      const b64 = Buffer.from(Array.from({ length: rng.int(40) }, () => rng.int(256))).toString(
        "base64",
      );
      return [rng.int(5) === 0 ? b64.slice(0, -1) || "A" : b64];
    }),
  "iso-utc-string": (rng) =>
    Array.from({ length: 20 }, () => [Math.floor(rng.next() * 4102444800000)]),
};

export const tasks = [
  ...b14.map((t) => {
    const family = {
      "best-compatible-version": "versioning",
      "range-within-range": "versioning",
      "sort-iso-timestamps": "dates",
      "iso-utc-string": "dates",
      "deep-copy": "data",
      "apply-path-updates": "data",
      "spell-suggest": "data",
      "build-order": "data",
      "canonical-emails": "validation",
      "keep-valid-urls": "validation",
      "name-based-uuid": "hashing",
      "md5-hex": "hashing",
      "base64-decode": "hashing",
    }[t.id];
    return EXTRA[t.id] ? { ...t, family, gen: EXTRA[t.id] } : { ...t, family };
  }),
  ...newTasks,
];
export const FAMILIES = [...new Set(tasks.map((t) => t.family))];
