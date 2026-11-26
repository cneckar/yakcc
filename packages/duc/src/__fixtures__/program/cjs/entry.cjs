// A CommonJS program (#1370): a module required by path, and an optional dependency required in a
// try (it does not resolve: the require throws, and the program goes on).
const lib = require("./lib.cjs");
let optional;
try {
  optional = require("not-a-package-of-this-program");
} catch {
  optional = undefined;
}
exports.probe = (n) => [lib.twice(n), lib.twice(n + 1), lib.count(), typeof optional];
