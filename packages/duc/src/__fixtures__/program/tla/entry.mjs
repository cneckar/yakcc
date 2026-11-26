// Top-level await (#1361 P2): a module that awaits is evaluated asynchronously, and so is each one
// importing it; an importer's body runs once its dependencies' evaluations are done, and import()
// of such a module resolves when it has been evaluated.
import { y } from "./mid.mjs";
import { order, x } from "./own.mjs";

order.push("entry start");
const own = await import("./own.mjs");
const v = await Promise.resolve(41);
console.log(own.x + v, x, y, order.join(","));
const late = await import("./late.mjs");
console.log(late.z, order.join(","));
