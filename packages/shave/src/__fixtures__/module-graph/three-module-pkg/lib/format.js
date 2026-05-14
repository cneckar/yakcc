// Fixture: three-module-pkg/lib/format.js
// Module C — a pure formatter helper with no further in-package imports.
// Used by the connected-forest unit tests to verify cross-module peer-addressability.

function formatValue(n, opts) {
  opts = opts || {};
  if (opts.long) return n + ' units';
  return String(n);
}

module.exports = formatValue;
