// Ports in one thread, through the messaging binding (#1361 P2): natively the boot gives the binding
// to a library module; under Node, internal/test/binding does (--expose-internals).
const binding =
  typeof internalBinding === "function"
    ? internalBinding
    : require("internal/test/binding").internalBinding;
const { MessageChannel, receiveMessageOnPort, broadcastChannel, stopMessagePort } =
  binding("messaging");
const { handle_onclose: onclose, no_message_symbol: none } = binding("symbols");
const dispatch = Symbol.for("nodejs.internal.kHybridDispatch");
const seen = [];
const listen = (port, name) => {
  port[dispatch] = (data) => {
    seen.push(`${name} ${JSON.stringify(data)}`);
    process.nextTick(() => seen.push(`tick after ${name}`));
    Promise.resolve().then(() => seen.push(`microtask after ${name}`));
    if (data === "last") port.close();
  };
  port[onclose] = () => seen.push(`${name} closed`);
};
const { port1, port2 } = new MessageChannel();
listen(port1, "port1");
listen(port2, "port2");
port2.start();
port1.postMessage({ n: 1, list: [1, [2, 3]] });
const sent = { n: 2 };
port1.postMessage(sent);
sent.n = 99;
port1.postMessage("last");
port1.postMessage("after the last");
Promise.resolve().then(() => seen.push("microtask of the script"));
process.nextTick(() => seen.push("tick of the script"));
const c = new MessageChannel();
c.port2.postMessage("taken");
c.port2.postMessage("taken too");
seen.push(
  `received ${JSON.stringify(receiveMessageOnPort(c.port1))} ${JSON.stringify(receiveMessageOnPort(c.port1))} ${receiveMessageOnPort(c.port1) === none}`,
);
seen.push(`refs ${port2.hasRef()} ${c.port1.hasRef()}`);
c.port1.unref();
c.port2.unref();
seen.push(`unref ${c.port1.hasRef()}`);
const s = new MessageChannel();
listen(s.port2, "stopped");
s.port2.start();
stopMessagePort(s.port2);
s.port1.postMessage("not delivered");
s.port1.unref();
s.port2.unref();
const b1 = broadcastChannel("group");
const b2 = broadcastChannel("group");
const b3 = broadcastChannel("other");
listen(b2, "b2");
listen(b3, "b3");
b2.start();
b3.start();
b1.postMessage("last");
b1.unref();
b3.unref();
let threw;
try {
  new port1.constructor();
} catch (e) {
  threw = e.code;
}
seen.push(`constructing ${threw}`);
process.on("exit", () => console.log(seen.join("\n")));
