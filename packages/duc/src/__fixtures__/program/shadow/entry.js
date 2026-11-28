// Module bindings that shadow platform globals, read and written inside nested functions
// (Node's internal/modules/esm/hooks.js: `let MessageChannel;` set in a class constructor, #1370).
let MessageChannel;
let URL = "not the global";
let TextEncoder;
let made = 0;

class Hooks {
  #channel;
  constructor() {
    MessageChannel ??= class Box {
      constructor() {
        made += 1;
        this.n = made;
      }
    };
    this.#channel = new MessageChannel();
  }
  get n() {
    return this.#channel.n;
  }
  static rename(value) {
    URL = value;
    return () => URL;
  }
}

function later() {
  return function inner() {
    TextEncoder = TextEncoder === undefined ? 1 : TextEncoder + 1;
    return TextEncoder;
  };
}

const a = new Hooks();
const b = new Hooks();
const read = Hooks.rename("renamed");
const bump = later();
console.log(
  JSON.stringify([
    a.n,
    b.n,
    typeof MessageChannel,
    MessageChannel.name,
    read(),
    URL,
    bump(),
    bump(),
    TextEncoder,
    typeof globalThis.MessageChannel,
  ]),
);
