// Fixture: degradation-pkg/index.js
// Has one real resolvable in-package import (./helper) and one external
// npm dep (some-external-pkg) that is deliberately unresolvable.
// Used by the best-effort-degradation test: the forest must still contain
// the resolvable helper module even though the external dep is a stub.
var helper = require('./helper');
var external = require('some-external-pkg');

function mainFn(x) {
  return helper.double(x) + external.something(x);
}

module.exports = { mainFn };
