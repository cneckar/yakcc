// SPDX-License-Identifier: Apache-2.0
// The environment module of the native Node-library tests (#1331, #1361 P2): Node's wrapper names.
// The bindings lane:c shaves from node/src (#1367) are test stand-ins here until those land;
// the runtime's own (types) come from the runtime.
const primordials = { __proto__: null };
const standIns = {
  constants: { os: { signals: { SIGINT: 2, SIGTERM: 15 } } },
  util: {
    privateSymbols: {
      arrow_message_private_symbol: Symbol("arrow"),
      decorated_private_symbol: Symbol("decorated"),
    },
    constants: { kPending: 0, kFulfilled: 1, kRejected: 2 },
    guessHandleType: () => "UNKNOWN",
    defineLazyProperties: () => {},
    sleep: () => {},
  },
  string_decoder: {
    encodings: [
      "ascii",
      "base64",
      "base64url",
      "buffer",
      "hex",
      "latin1",
      "ucs2",
      "utf8",
      "utf16le",
    ],
  },
  options: {
    getCLIOptionsValues: () => new Map(),
    getCLIOptionsInfo: () => ({ options: new Map(), aliases: new Map() }),
    getEmbedderOptions: () => ({}),
    getEnvOptionsInputType: () => new Map(),
  },
};
function internalBinding(name) {
  const b = __yakccRuntimeBinding(name) ?? standIns[name];
  if (b === undefined) throw new Error(`no binding ${name}`);
  return b;
}
module.exports = { primordials, internalBinding, process };
require("internal/per_context/primordials");
