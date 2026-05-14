// Fixture: circular-pkg/a.js
// Part of a deliberate circular import: a.js -> b.js -> a.js
// Used by the cycle-guard unit test to verify the visited-set prevents non-termination.
var b = require('./b');

function fromA(x) {
  return b.fromB(x) + 1;
}

module.exports = { fromA };
