// A CommonJS library module (#1370): its exports an object, its state its own.
let calls = 0;
// A generator declared at a module's top level: a coroutine, as a nested one is.
function* upTo(n) {
  for (let i = 0; i < n; i++) yield i * i;
  return "done";
}
module.exports = {
  twice(x) {
    calls++;
    return x * 2;
  },
  count: () => calls,
  upTo,
};
