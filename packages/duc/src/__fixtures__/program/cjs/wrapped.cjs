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
  // Methods set on a Map, a Set and an array themselves (TypeScript's multi-map): called as
  // theirs, before their prototype's, and listed as their own keys.
  function multiMapAdd(key, value) {
    let values = this.get(key);
    if (values !== undefined) values.push(value);
    else {
      values = [value];
      this.set(key, values);
    }
    return values;
  }
  function ownMethods(n) {
    const m = new Map();
    m.add = multiMapAdd;
    m.add("a", n);
    m.add("a", n + 1);
    m.add("b", 0);
    const s = new Set();
    s.tag = "t";
    s.has2 = function (x) {
      return this.has(x);
    };
    s.add(n);
    const a = [1, 2, 3];
    a.extra = function () {
      return this.length * 10;
    };
    return [
      [...m],
      Object.keys(m),
      s.tag,
      s.has2(n),
      s.has2(n + 1),
      Object.keys(s),
      a.extra(),
      m.size,
    ];
  }
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
    ownMethods,
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
