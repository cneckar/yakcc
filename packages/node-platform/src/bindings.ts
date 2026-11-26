// SPDX-License-Identifier: Apache-2.0
/**
 * Node's `internalBinding` classified (#1331, DEC-DUC-NODE-BASE-SET-001): below its JavaScript, Node
 * calls C++ through 65 bindings (about 800 members in v22.23.5, `manifest.json`). Each binding is
 * one of:
 *
 * - `logic`: computation, shaved from `node/src`'s C++ and the dependency it calls (#1367, lane:c),
 *   never rewritten by hand;
 * - `os`: operating-system primitives. Natively they are libuv over libc, both shaved (#1367,
 *   #1365), down to the system-call leaf; a target with no shaved libc keeps them in its base set;
 * - `runtime`: what the runtime that runs the atoms provides itself (V8's role): compiling code at
 *   run time, the module table, stack traces, microtasks, async hooks, heap statistics;
 * - `data`: constant tables (errno codes, build flags, symbols), shaved as constant memory;
 * - `later`: out of scope until the self-rebuild needs it (#1361): the inspector, QUIC, snapshots,
 *   SEA, tracing, reports, WASI.
 *
 * A binding that mixes kinds names the exceptions in `members`.
 */

export type BindingLayer = "logic" | "os" | "runtime" | "data" | "later";

export interface BindingClass {
  readonly layer: BindingLayer;
  /** Where its implementation comes from: the C++ unit or dependency shaved, or the primitive. */
  readonly source: string;
  /** Members of another layer than the binding's, by member. */
  readonly members?: Readonly<Record<string, BindingLayer>>;
}

const c = (
  layer: BindingLayer,
  source: string,
  members?: Readonly<Record<string, BindingLayer>>,
): BindingClass => ({ layer, source, ...(members !== undefined ? { members } : {}) });

/** Every binding Node v22.23.5's library names, classified. */
export const BINDINGS: Readonly<Record<string, BindingClass>> = {
  // Logic: shaved from node/src and its dependencies (#1367).
  buffer: c("logic", "src/node_buffer.cc, simdutf, nbytes"),
  string_decoder: c("logic", "src/string_decoder.cc"),
  encoding_binding: c("logic", "src/encoding_binding.cc, simdutf, ada (toASCII/toUnicode)"),
  url: c("logic", "src/node_url.cc, ada"),
  icu: c("logic", "src/node_i18n.cc, ICU"),
  zlib: c("logic", "src/node_zlib.cc, zlib, brotli, zstd"),
  crypto: c("logic", "src/crypto/*, OpenSSL", { RandomBytesJob: "os" }),
  http_parser: c("logic", "src/node_http_parser.cc, llhttp"),
  http2: c("logic", "src/node_http2.cc, nghttp2"),
  cares_wrap: c("logic", "src/cares_wrap.cc, c-ares (sockets through libuv)", {
    GetAddrInfoReqWrap: "os",
    GetNameInfoReqWrap: "os",
  }),
  block_list: c("logic", "src/node_sockaddr.cc"),
  blob: c("logic", "src/node_blob.cc", { createBlobFromFilePath: "os" }),
  serdes: c("logic", "src/node_serdes.cc, V8's ValueSerializer"),
  sqlite: c("logic", "src/node_sqlite.cc, SQLite"),
  modules: c("logic", "src/node_modules.cc, simdjson (package.json reading)", {
    readPackageJSON: "os",
  }),
  options: c("logic", "src/node_options.cc (command-line parsing)"),
  util: c("logic", "src/node_util.cc", {
    getCallSites: "runtime",
    getCallerLocation: "runtime",
    getPromiseDetails: "runtime",
    getProxyDetails: "runtime",
    getExternalValue: "runtime",
    isInsideNodeModules: "runtime",
    privateSymbols: "runtime",
    shouldAbortOnUncaughtToggle: "runtime",
    guessHandleType: "os",
  }),
  types: c("runtime", "V8's value predicates (isDate, isProxy, ...): the runtime's object model"),
  messaging: c("runtime", "src/node_messaging.cc: ports between threads", {
    structuredClone: "logic",
  }),

  // Operating-system primitives: libuv over libc, both shaved, down to system calls.
  fs: c("os", "src/node_file.cc over libuv's fs"),
  fs_dir: c("os", "src/node_dir.cc over libuv"),
  fs_event_wrap: c("os", "src/fs_event_wrap.cc over libuv (inotify)"),
  os: c("os", "src/node_os.cc over libuv", { isBigEndian: "data" }),
  credentials: c("os", "src/node_credentials.cc (getuid, getenv, ...)"),
  process_methods: c("os", "src/node_process_methods.cc", {
    _rawDebug: "os",
    causeSegfault: "later",
    _debugProcess: "later",
    _debugEnd: "later",
    dlopen: "later",
  }),
  spawn_sync: c("os", "src/spawn_sync.cc over libuv"),
  process_wrap: c("os", "src/process_wrap.cc over libuv"),
  pipe_wrap: c("os", "src/pipe_wrap.cc over libuv"),
  tcp_wrap: c("os", "src/tcp_wrap.cc over libuv"),
  udp_wrap: c("os", "src/udp_wrap.cc over libuv"),
  tty_wrap: c("os", "src/tty_wrap.cc over libuv"),
  signal_wrap: c("os", "src/signal_wrap.cc over libuv"),
  stream_wrap: c("os", "src/stream_wrap.cc over libuv"),
  stream_pipe: c("os", "src/stream_pipe.cc over libuv"),
  js_stream: c("logic", "src/js_stream.cc: a stream whose ends are JavaScript"),
  timers: c("os", "src/timers.cc over libuv's loop"),
  performance: c("os", "src/node_perf.cc (clock)", {
    installGarbageCollectionTracking: "runtime",
    removeGarbageCollectionTracking: "runtime",
  }),
  tls_wrap: c("logic", "src/crypto/crypto_tls.cc, OpenSSL over a stream"),
  permission: c("logic", "src/permission/*"),

  // The runtime's own: what V8 does for Node.
  builtins: c("runtime", "the module table: the program record of Node's library"),
  contextify: c("runtime", "compiling JavaScript at run time (vm, eval)"),
  module_wrap: c("runtime", "ES module linking"),
  errors: c("runtime", "stack traces and the uncaught-exception path"),
  task_queue: c("runtime", "the microtask queue and the tick callback"),
  async_wrap: c("runtime", "async hooks"),
  async_context_frame: c("runtime", "async context"),
  v8: c("runtime", "heap statistics", { cachedDataVersionTag: "data" }),
  heap_utils: c("runtime", "heap snapshots"),
  worker: c("runtime", "threads", { isMainThread: "data", threadId: "data" }),
  wasm_web_api: c("runtime", "WebAssembly streaming"),
  webstorage: c("runtime", "localStorage"),

  // Constant tables.
  constants: c("data", "src/node_constants.cc"),
  uv: c("data", "libuv's error names and codes", { errname: "logic", getErrorMap: "logic" }),
  symbols: c("data", "src/env_properties.h's symbols"),
  config: c("data", "build configuration"),

  // Later (#1361): not needed to rebuild yakcc.
  inspector: c("later", "the inspector"),
  profiler: c("later", "coverage and profiling"),
  trace_events: c("later", "tracing"),
  report: c("later", "diagnostic reports"),
  sea: c("later", "single executable applications"),
  mksnapshot: c("later", "startup snapshots"),
  wasi: c("later", "WASI"),
  watchdog: c("later", "the SIGINT watchdog of the REPL"),
  quic: c("later", "QUIC (not in this build)"),
  internal_only_v8: c("later", "V8 internals (not in this build)"),
};

/** A member's layer: its own exception, else its binding's. */
export function memberLayer(binding: string, member: string): BindingLayer | undefined {
  const b = BINDINGS[binding];
  if (b === undefined) return undefined;
  return b.members?.[member] ?? b.layer;
}
