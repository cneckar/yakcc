// A CommonJS program (#1370): a module required by path, and an optional dependency required in a
// try (it does not resolve: the require throws, and the program goes on).
const lib = require("./lib.cjs");
const wrapped = require("./wrapped.cjs");
let optional;
try {
  optional = require("not-a-package-of-this-program");
} catch {
  optional = undefined;
}
exports.probe = (n) => {
  const g = lib.upTo(3);
  return [
    lib.twice(n),
    lib.twice(n + 1),
    lib.count(),
    typeof optional,
    [...lib.upTo(n)],
    g.next(),
    [...g],
    lib.upTo.name,
    wrapped.bump(n),
    wrapped.bump(1),
    wrapped.table.module,
    new wrapped.Box(n).twice,
    wrapped.viaShorthand,
    wrapped.hoisted,
    wrapped.keys,
    wrapped.own,
  ];
};
