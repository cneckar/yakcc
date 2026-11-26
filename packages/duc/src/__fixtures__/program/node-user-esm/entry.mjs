// An ECMAScript user program over Node's library (#1361 P2): Node's modules imported by name (a
// default, named and namespace import), its own ECMAScript and CommonJS modules, and import.meta.
import { EventEmitter } from "node:events";
import path from "node:path";
import * as util from "node:util";
import * as utilAgain from "node:util";
// biome-ignore lint/style/useNodejsImportProtocol: an import without node: is what is tested
import { join } from "path";
import cjs, { named } from "./lib.cjs";
import * as cjsNs from "./lib.cjs";
import { double } from "./own.mjs";

const em = new EventEmitter();
const seen = [];
em.on("x", (n) => seen.push(double(n)));
em.emit("x", 4);
console.log(path.basename("/a/b.txt"), join("a", "b"), seen, util.format("%d!", 3));
console.log(util === utilAgain);
console.log(
  typeof import.meta,
  import.meta.url.endsWith("/node-user-esm/entry.mjs"),
  import.meta.url === `file://${import.meta.filename}`,
  `${import.meta.dirname}/entry.mjs` === import.meta.filename,
);
console.log(cjs.named, named, Object.keys(cjsNs), cjsNs.default === cjs, cjsNs.named);
// Object.keys reads no value, so a getter does not run.
console.log(
  Object.keys({
    get g() {
      throw new Error("ran");
    },
  }),
);
