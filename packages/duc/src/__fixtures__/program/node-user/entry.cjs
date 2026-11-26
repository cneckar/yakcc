// A user program over Node's library (#1361 P2): its own module by path, and Node's modules by
// name (with node: or not), each the library's own as Node's realm loads it.
// biome-ignore lint/style/useNodejsImportProtocol: a require without node: is what is tested
const path = require("path");
const { EventEmitter } = require("node:events");
// biome-ignore lint/style/useNodejsImportProtocol: a require without node: is what is tested
const util = require("util");
const querystring = require("node:querystring");
const own = require("./own.cjs");
let missing;
try {
  missing = require("no-such-package");
} catch (e) {
  missing = e.code;
}
const em = new EventEmitter();
const heard = [];
em.on("tick", (n) => heard.push(own.double(n)));
em.emit("tick", 2);
em.emit("tick", 5);
const text = querystring.stringify({ q: "a b", n: [1, 2] });
console.log(path.join("/srv", own.name, "..", "x.txt"), heard.join(","), missing);
console.log(
  util.format("%s has %d", own.name, own.double(21)),
  util.inspect({ text, parsed: querystring.parse(text), ok: true }),
);
// biome-ignore lint/style/useNodejsImportProtocol: a require without node: is what is tested
console.log(require("path") === path, require("node:path") === path);
