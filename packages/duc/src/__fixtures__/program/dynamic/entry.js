// import() of a module the program has, and of one it does not (#1370).
import { order } from "./log.js";

order.push("entry");
const first = import("./lazy.js").then((m) => {
  order.push(`loaded ${m.value}`);
  return m.twice(21);
});
const missing = import("./not-a-module.js").then(
  () => "loaded",
  (e) => e instanceof Error,
);
// A computed specifier (assemblyscript's `--wasm <file>`): a module this one links, and one it
// does not, which rejects.
const name = ["./lazy", "js"].join(".");
const computed = import(name).then((m) => m.value);
const computedMissing = import(`./${"absent"}.js`).then(
  () => "loaded",
  (e) => e instanceof Error,
);
Promise.all([first, missing, computed, computedMissing]).then(([v, rejected, c, cr]) =>
  console.log(JSON.stringify([v, rejected, c, cr, order])),
);
order.push("sync end");
