// SPDX-License-Identifier: Apache-2.0
/**
 * Per-target base sets of platform primitives (#1275 D5, #1282). A platform primitive is a name the
 * target provides; it is the only thing a closed graph does not contain. Each primitive can carry
 * labels: a capability (it reaches the environment, schedules code, or does I/O), and
 * nondeterminism (two reads can differ). Labels can be on a whole symbol, or on one member
 * (`Math` is deterministic, `Math.random` is not).
 *
 * `require`, `module` and `exports` are not primitives on any target: under D5 they are contract
 * references, or holes until the dependency is shaved.
 */
import { mayInfluence } from "./influence.js";
import type { DucGraph, ValueId } from "./types.js";

export interface PrimitiveLabels {
  /** The authority it grants, when it grants one: "process", "timers", "io", "network", "module-location". */
  readonly capability?: string;
  /** True when two uses can give different values. */
  readonly nondeterministic?: true;
  /** Labels on members, by member name, when they differ from the symbol's. */
  readonly members?: Readonly<Record<string, Omit<PrimitiveLabels, "members">>>;
}

export interface BaseSet {
  readonly target: string;
  readonly version: number;
  readonly primitives: Readonly<Record<string, PrimitiveLabels>>;
  /**
   * The modules the platform provides to `require` (#1290), with their labels: a module's
   * labels cover everything reached through it. A `node:` prefix names the same module.
   */
  readonly modules?: Readonly<Record<string, Omit<PrimitiveLabels, "members">>>;
}

/** The base set's labels for a module specifier, or undefined when the platform does not provide it. */
export function platformModule(
  base: BaseSet,
  specifier: string,
): Omit<PrimitiveLabels, "members"> | undefined {
  const name = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return base.modules?.[name];
}

const pure = (names: readonly string[]): Record<string, PrimitiveLabels> =>
  Object.fromEntries(names.map((n) => [n, {}]));

/** ECMAScript built-ins: available on every JavaScript target. */
export const ECMASCRIPT: BaseSet = {
  target: "ecmascript",
  version: 1,
  primitives: {
    // What the language gives a call made with `new` (#1173).
    "new.target": {},
    ...pure([
      "JSON",
      "Object",
      "Array",
      "Number",
      "String",
      "Boolean",
      "Symbol",
      "BigInt",
      "RegExp",
      "Map",
      "Set",
      "WeakMap",
      "WeakSet",
      "Promise",
      "Reflect",
      "Proxy",
      "Error",
      "TypeError",
      "RangeError",
      "SyntaxError",
      "ReferenceError",
      "EvalError",
      "URIError",
      "AggregateError",
      "parseInt",
      "parseFloat",
      "isNaN",
      "isFinite",
      "encodeURIComponent",
      "decodeURIComponent",
      "encodeURI",
      "decodeURI",
      "escape",
      "unescape",
      "Uint8Array",
      "Uint8ClampedArray",
      "Uint16Array",
      "Uint32Array",
      "Int8Array",
      "Int16Array",
      "Int32Array",
      "Float32Array",
      "Float64Array",
      "BigInt64Array",
      "BigUint64Array",
      "ArrayBuffer",
      "SharedArrayBuffer",
      "DataView",
      "Intl",
      "undefined",
      "NaN",
      "Infinity",
      "arguments",
      "globalThis",
    ]),
    Math: { members: { random: { nondeterministic: true } } },
    // `new Date()` and `Date.now()` read the clock.
    Date: { nondeterministic: true },
    // What a weak reference holds, and when a finalizer runs, depend on the collector.
    WeakRef: { nondeterministic: true },
    FinalizationRegistry: { nondeterministic: true },
    Atomics: {},
    // Code made from a string at run time: the authority to run any code (#1297).
    Function: { capability: "dynamic-code" },
    eval: { capability: "dynamic-code" },
    // A try statement as the lifter writes it (#1276): the body's result, or the handler's for a throw.
    __yakccTry: {},
    // A try statement whose blocks await: the same, over async closures, as a promise.
    __yakccTryAsync: {},
    // A try statement whose blocks yield: the same, over generator closures, delegated to (#1330).
    __yakccTryGen: {},
    __yakccTryAsyncGen: {},
    // An object rest as the TypeScript lowering writes it (#1330).
    __yakccObjectRest: {},
  },
};

/** Node.js: ECMAScript, plus the host's data APIs and its authority-bearing APIs, and its modules. */
export const NODE: BaseSet = {
  target: "node",
  version: 2,
  modules: {
    ...pure([
      "assert",
      "buffer",
      "events",
      "path",
      "querystring",
      "string_decoder",
      "url",
      "util",
      "zlib",
    ]),
    // A module that reaches the environment carries the authority it grants.
    fs: { capability: "io" },
    stream: { capability: "io" },
    readline: { capability: "io" },
    tty: { capability: "io" },
    http: { capability: "network" },
    https: { capability: "network" },
    http2: { capability: "network" },
    net: { capability: "network" },
    tls: { capability: "network" },
    dgram: { capability: "network" },
    dns: { capability: "network" },
    os: { capability: "process" },
    // An ES module's own URL (#1173).
    "import.meta": { capability: "module-location" },
    process: { capability: "process" },
    child_process: { capability: "process" },
    cluster: { capability: "process" },
    worker_threads: { capability: "process" },
    module: { capability: "module-location" },
    timers: { capability: "timers" },
    crypto: { nondeterministic: true },
    perf_hooks: { nondeterministic: true },
  },
  primitives: {
    ...ECMASCRIPT.primitives,
    ...pure([
      "Buffer",
      "TextEncoder",
      "TextDecoder",
      "URL",
      "URLSearchParams",
      "structuredClone",
      "WebAssembly",
      "atob",
      "btoa",
      "AbortController",
      "Event",
      "EventTarget",
      "Blob",
    ]),
    // `AbortSignal.timeout` arms a timer.
    AbortSignal: { members: { timeout: { capability: "timers" } } },
    process: { capability: "process" },
    console: { capability: "io" },
    setTimeout: { capability: "timers" },
    setInterval: { capability: "timers" },
    setImmediate: { capability: "timers" },
    clearTimeout: { capability: "timers" },
    clearInterval: { capability: "timers" },
    clearImmediate: { capability: "timers" },
    queueMicrotask: { capability: "timers" },
    fetch: { capability: "network" },
    __dirname: { capability: "module-location" },
    __filename: { capability: "module-location" },
    // An ES module's own URL, as `__filename` is a CommonJS module's (#1297).
    "import.meta": { capability: "module-location" },
    performance: { nondeterministic: true },
    crypto: {
      members: {
        randomUUID: { nondeterministic: true },
        getRandomValues: { nondeterministic: true },
      },
    },
  },
};

/**
 * Browsers and workers (#1173): ECMAScript, plus the web platform's globals. A package written for
 * several platforms names them (`self.crypto` in a worker, a UMD wrapper's `window`); on Node they
 * are not on the target, and the closure check says so.
 */
export const WEB: BaseSet = {
  target: "web",
  version: 1,
  primitives: {
    ...ECMASCRIPT.primitives,
    ...pure([
      "TextEncoder",
      "TextDecoder",
      "URL",
      "URLSearchParams",
      "structuredClone",
      "WebAssembly",
      "atob",
      "btoa",
      "AbortController",
      "Event",
      "EventTarget",
      "Blob",
    ]),
    // The global object, by its web names: what is reached through it carries its own labels.
    self: {},
    window: {},
    document: { capability: "io" },
    navigator: { capability: "process" },
    location: { capability: "module-location" },
    localStorage: { capability: "io" },
    sessionStorage: { capability: "io" },
    console: { capability: "io" },
    setTimeout: { capability: "timers" },
    setInterval: { capability: "timers" },
    clearTimeout: { capability: "timers" },
    clearInterval: { capability: "timers" },
    queueMicrotask: { capability: "timers" },
    requestAnimationFrame: { capability: "timers" },
    fetch: { capability: "network" },
    XMLHttpRequest: { capability: "network" },
    WebSocket: { capability: "network" },
    performance: { nondeterministic: true },
    crypto: {
      members: {
        randomUUID: { nondeterministic: true },
        getRandomValues: { nondeterministic: true },
      },
    },
  },
};

/** Every name that is a primitive on some target: the lifter classifies these as platform primitives. */
export const KNOWN_PRIMITIVES: readonly string[] = [
  ...new Set([ECMASCRIPT, NODE, WEB].flatMap((base) => Object.keys(base.primitives))),
];

export interface PrimitiveUse {
  readonly symbol: string;
  /** The members read from it directly (`.random` gives "random"). */
  readonly members: readonly string[];
  readonly capabilities: readonly string[];
  readonly nondeterministic: boolean;
}

export interface PrimitiveReport {
  readonly uses: readonly PrimitiveUse[];
  /** Platform primitives the graph uses that the target does not provide: holes on this target. */
  readonly notOnTarget: readonly string[];
}

/** The platform primitives a graph uses on a target, with their labels. Closures are included. */
export function primitiveReport(g: DucGraph, base: BaseSet): PrimitiveReport {
  const uses = new Map<
    string,
    { members: Set<string>; capabilities: Set<string>; nondeterministic: boolean }
  >();
  const notOnTarget = new Set<string>();
  const visit = (graph: DucGraph): void => {
    const symbolOf = new Map<ValueId, string>();
    for (const node of graph.nodes) {
      if (node.kind === "diamond-source" && node.diamond?.reason === "platform-primitive") {
        symbolOf.set(node.outputs[0] as ValueId, node.diamond.symbol);
      }
    }
    for (const [, symbol] of symbolOf) {
      const labels = base.primitives[symbol];
      if (labels === undefined) {
        notOnTarget.add(symbol);
        continue;
      }
      const use = uses.get(symbol) ?? {
        members: new Set(),
        capabilities: new Set(),
        nondeterministic: false,
      };
      if (labels.capability !== undefined) use.capabilities.add(labels.capability);
      if (labels.nondeterministic) use.nondeterministic = true;
      uses.set(symbol, use);
    }
    for (const node of graph.nodes) {
      const label = node.label ?? "";
      const symbol = symbolOf.get(node.inputs[0] as ValueId);
      if (node.kind !== "op" || symbol === undefined || !/^\??\.[^=]+$/.test(label)) continue;
      const member = label.replace(/^\??\./, "");
      const use = uses.get(symbol);
      if (use === undefined) continue;
      use.members.add(member);
      const labels = base.primitives[symbol]?.members?.[member];
      if (labels?.capability !== undefined) use.capabilities.add(labels.capability);
      if (labels?.nondeterministic) use.nondeterministic = true;
    }
    for (const node of graph.nodes) if (node.closure !== undefined) visit(node.closure);
  };
  visit(g);
  return {
    uses: [...uses.entries()]
      .map(([symbol, u]) => ({
        symbol,
        members: [...u.members].sort(),
        capabilities: [...u.capabilities].sort(),
        nondeterministic: u.nondeterministic,
      }))
      .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)),
    notOnTarget: [...notOnTarget].sort(),
  };
}

/**
 * The observations a nondeterministic primitive may reach (#1270): a result that can differ
 * between two runs with the same inputs. Reported by observation index, with the primitive.
 */
export function nondeterministicObservations(
  g: DucGraph,
  base: BaseSet,
): { readonly obs: number; readonly source: string }[] {
  const sources: { value: ValueId; name: string }[] = [];
  const symbolOf = new Map<ValueId, string>();
  for (const node of g.nodes) {
    if (node.kind === "diamond-source" && node.diamond?.reason === "platform-primitive") {
      const symbol = node.diamond.symbol;
      symbolOf.set(node.outputs[0] as ValueId, symbol);
      if (base.primitives[symbol]?.nondeterministic)
        sources.push({ value: node.outputs[0] as ValueId, name: symbol });
    }
  }
  for (const node of g.nodes) {
    const symbol = symbolOf.get(node.inputs[0] as ValueId);
    const label = node.label ?? "";
    if (node.kind !== "op" || symbol === undefined || !/^\??\.[^=]+$/.test(label)) continue;
    const member = label.replace(/^\??\./, "");
    if (base.primitives[symbol]?.members?.[member]?.nondeterministic) {
      sources.push({ value: node.outputs[0] as ValueId, name: `${symbol}.${member}` });
    }
  }
  const found: { obs: number; source: string }[] = [];
  g.obs.forEach((o, k) => {
    for (const s of sources)
      if (s.value === o || mayInfluence(g, s.value, o)) found.push({ obs: k, source: s.name });
  });
  return found;
}
