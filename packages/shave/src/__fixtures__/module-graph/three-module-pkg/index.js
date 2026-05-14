// Fixture: three-module-pkg/index.js
// Module A — imports from B and C within the package boundary.
// Used by the connected-forest unit tests.
var parse = require('./lib/parse');
var format = require('./lib/format');

module.exports = function threeModuleMain(val, opts) {
  if (typeof val === 'string') return parse(val);
  return format(val, opts);
};
