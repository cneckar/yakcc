// Fixture: circular-pkg/b.js
// Part of a deliberate circular import: a.js -> b.js -> a.js
// Used by the cycle-guard unit test to verify the visited-set prevents non-termination.
var a = require('./a');

function fromB(x) {
  return x * 2;
}

module.exports = { fromB };
