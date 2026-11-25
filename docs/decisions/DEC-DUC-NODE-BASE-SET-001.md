# DEC-DUC-NODE-BASE-SET-001: Node's bindings classified; the layer-0 base set is system calls

**Status:** Decided (lane:core, #1331). It applies DEC-DUC-OPERATIONS-AS-ATOMS-001 (*"shave EVERYTHING"*) to the layer below Node's JavaScript.
**Date:** 2026-11-24
**Issues:** #1329 (shaving the platform), #1331 (this), #1361 (the self-rebuild plan), #1365 (libc), #1367 (Node's C++)
**Data:** `packages/node-platform/src/bindings.ts`, checked against `packages/node-platform/vendor/node-v22.23.5/manifest.json` by `node-platform.test.ts`.

## Question

Node's library is JavaScript, and it shaves (#1330: 9,011 / 9,011 statements lift with no opaque summary; #1331: the library through the real pipeline). Below it, the library calls C++ through `internalBinding(name)`. Node v22.23.5's library names 65 bindings, which expose about 800 members.

- Which of these are shaved?
- Which are what a target provides?

## Decision

### 1. Every binding is one of five kinds

| Kind | What it is | How it is made |
|---|---|---|
| **logic** | computation: `buffer`, `string_decoder`, `url`, `encoding_binding`, `zlib`, `crypto`, `http_parser`, `sqlite`, … | shaved from `node/src`'s C++ and the dependency it calls (simdutf, ada, zlib, OpenSSL, llhttp, SQLite, …) by the C/C++ front end (#1364, #1367) |
| **os** | operating-system primitives: `fs`, `os`, `process_methods`, `tcp_wrap`, `timers`, `spawn_sync`, … | `node/src` over libuv over libc, **all shaved** (#1367, #1365), down to the system-call leaf |
| **runtime** | what the runtime running the atoms provides, which V8 provides for Node: `builtins` (the module table), `contextify` (compiling code at run time), `module_wrap`, `errors`, `task_queue`, `async_wrap`, `types`, … | the native runtime (lane:native): the program record, the collector, the microtask queue, stack traces |
| **data** | constant tables: `constants`, `uv`'s error codes, `symbols`, `config` | shaved as constant memory (`__ykData`) |
| **later** | the inspector, QUIC, snapshots, SEA, tracing, reports, WASI | out of scope until the self-rebuild needs them |

- **A mixed binding** names its exceptions per member. For example:
  - `crypto` is logic, but `RandomBytesJob` is `os` (it reads `getrandom`);
  - `util` is logic, but `getCallSites` is `runtime`.
- **The table** in `bindings.ts` is the classification.
- **Kept in step:** a test checks that the table covers exactly the bindings the vendored library names, and that every exception is a member the binding has.

### 2. The layer-0 base set is the system calls

#1282's per-target base sets named operating-system primitives at the level of libc: file, clock, environment, argv, exit, spawn, random, memory.

- **Natively, below that:** libc is shaved from musl (#1365), so a native target's base set is the system-call leaf (`__syscall(n, …)`) and nothing more.
  - Every `os` binding above reaches it through libuv's and musl's atoms.
- **Targets with no shaved libc** keep a base set at #1282's level: wasm (WASI), the JVM, and Windows and macOS until their system libraries are in scope.
  - Each primitive's contract is its libc or libuv function's: inputs, outputs and the error codes `uv` names.

### 3. The wrapper's names are bindings, resolved by the program record

Node runs each module of its library as the body of `function (exports, require, module, process, internalBinding, primordials)`. In the program record of Node's library (#1333):

| Name | Resolves to |
|---|---|
| `exports`, `require`, `module` | the module record's own (#1290); `require('x')` is the builtin module `x` |
| `primordials` | the exports of `internal/per_context/primordials`. This is JavaScript that copies the platform's built-ins (layer 1, #1332), so it is shaved like any module |
| `process` | the object `internal/bootstrap/node` builds, over `process_methods` and the other `os` bindings |
| `internalBinding(name)` | the binding's shaved atoms (`logic`, `os`, `data`), or the runtime's (`runtime`) |

The shave gate takes the wrapper's names as enclosing bindings (`WRAPPER_PARAMS`). An atom reading them is explained, as a CommonJS module's `require` is.

## Evidence

- **The six milestone modules** of #1331 shave through `shavePackage` and `collectForestSlicePlans`: `path`, `util`, `url`, `events`, `buffer` and `string_decoder`.
  - Every atom passes the shave's own gate: no unexplained name, no lift error, a faithful lift.
  - Test: `node-platform.test.ts`.
- **The whole library:** the full per-module measurement is in #1331.

## Consequences

- **One list.** What Node's platform is made of is one list, checked against the library it serves. A new Node version is a new vendored library and a new manifest; the test then names what is unclassified.
- **The `runtime` kind** is the native runtime's specification for running Node's library, and one of its largest items is `contextify` (compiling JavaScript at run time). Two open options, decided when a program needs them:
  - the native yakcc carries its own lifter and lowering, so it can compile JavaScript at run time;
  - programs that need it are refused natively.
- **`later` is not "never."** Each `later` binding becomes one of the other kinds when the self-rebuild, or a program after it, needs it.
