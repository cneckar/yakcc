// A JSON module imported (packages/cli/src/index.ts: `import pkg from "../package.json" with
// { type: "json" }`) and required: Node's value for both, the same object (#1370).
import data from "./data.json" with { type: "json" };
import reader from "./reader.cjs";
console.log(
  JSON.stringify([
    data.name,
    data.version,
    data.list,
    data.nested,
    Object.keys(data),
    Object.getPrototypeOf(data) === Object.prototype,
    data.__proto__,
    reader.version,
    reader.same(),
  ]),
);
