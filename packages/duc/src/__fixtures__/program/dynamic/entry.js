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
Promise.all([first, missing]).then(([v, rejected]) =>
  console.log(JSON.stringify([v, rejected, order])),
);
order.push("sync end");
