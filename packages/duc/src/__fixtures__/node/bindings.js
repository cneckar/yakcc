// SPDX-License-Identifier: Apache-2.0
// Bindings for the native Node-library tests (#1331, #1361 P2): test stand-ins for those lane:c
// shaves from node/src (#1367) until they land. The runtime's own come from the runtime.
module.exports = {
  constants: { os: { signals: { SIGINT: 2, SIGTERM: 15 } } },
  util: {
    constants: { kPending: 0, kFulfilled: 1, kRejected: 2 },
    guessHandleType: () => "UNKNOWN",
    defineLazyProperties: () => {},
    sleep: () => {},
  },
  buffer: {
    kMaxLength: 2 ** 53 - 1,
    kStringMaxLength: 2 ** 29 - 24,
    createUnsafeArrayBuffer: (size) => new ArrayBuffer(size),
  },
  process_methods: {
    hrtimeBuffer: new Uint32Array(3),
    hrtime: () => {},
    hrtimeBigInt: () => {},
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
