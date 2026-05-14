// Fixture: degradation-pkg/helper.js
// The resolvable in-package module. Must appear in the forest even when
// the external dep (some-external-pkg) in index.js is unresolvable.

function double(x) {
  return x * 2;
}

module.exports = { double };
