// Fixture: three-module-pkg/lib/parse.js
// Module B — a pure parser helper with no further in-package imports.
// Used by the connected-forest unit tests to verify cross-module peer-addressability.

function parseValue(str) {
  var n = parseFloat(str);
  if (isNaN(n)) return undefined;
  return n;
}

module.exports = parseValue;
