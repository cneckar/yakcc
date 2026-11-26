// A bundler's module wrapper, as TypeScript's typescript.js has (#1370): one arrow function called
// with an object whose exports accessor sets the module's. Its body's statements are the module's
// own, lifted one by one, the parameter renamed apart from the module's own `module`.
let api = {};
((module) => {
  "use strict";
  let counter = 0;
  // Bindings named as Object.prototype's members are the module's own (TypeScript's hasProperty).
  // biome-ignore lint/suspicious/noShadowRestrictedNames: the name is what is tested (#1370)
  const hasOwnProperty = Object.prototype.hasOwnProperty;
  function hasProperty(map, key) {
    return hasOwnProperty.call(map, key);
  }
  // biome-ignore lint/suspicious/noShadowRestrictedNames: the name is what is tested (#1370)
  const toString = "own";
  function bump(k) {
    counter += k;
    return counter;
  }
  const table = { module: 1, bump };
  class Box {
    constructor(v) {
      this.v = v;
    }
    get twice() {
      return this.v * 2;
    }
  }
  const self = { module };
  module.exports = {
    bump,
    table,
    Box,
    viaShorthand: self.module === module,
    hoisted: typeof later,
    keys: Object.keys(module),
    own: [hasProperty({ a: 1 }, "a"), hasProperty({}, "a"), toString, typeof hasOwnProperty],
  };
  function later() {}
})({
  get exports() {
    return api;
  },
  set exports(v) {
    api = v;
    if (typeof module !== "undefined" && module.exports) {
      module.exports = v;
    }
  },
});
