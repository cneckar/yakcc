// A CommonJS library module (#1370): its exports an object, its state its own.
let calls = 0;
module.exports = {
  twice(x) {
    calls++;
    return x * 2;
  },
  count: () => calls,
};
