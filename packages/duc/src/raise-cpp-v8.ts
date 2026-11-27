// SPDX-License-Identifier: Apache-2.0
/**
 * V8's public API as leaves over the JavaScript the atoms run in (#1367): the boundary node/src's
 * bindings are written against (`isV8Api`), so that Node's bindings are shaved from node/src's C++
 * rather than rewritten. The runtime's role is V8's (packages/node-platform's `runtime` layer):
 * here its values are the host's own, a handle a number naming one.
 *
 * - A `Local<T>`, `MaybeLocal<T>` or `ReturnValue<T>` is an 8-byte record holding a handle (0 is
 *   empty); `operator->` gives the handle, the `this` of the methods of `v8::Value` and the other
 *   heap classes. Handles are not reclaimed (a HandleScope does nothing).
 * - A `Maybe<T>` is V8's record, `bool has_value_` and then `T`.
 * - Calls follow the raised code's convention: a record returned is made in the slot given first,
 *   `this` next, a record argument is its address, a 64-bit integer a bigint.
 * - A `FunctionCallbackInfo` is made by the host when JavaScript calls a function of a
 *   `FunctionTemplate`: its arguments, receiver and return value, by an id at offset 0.
 * - An `ArrayBuffer`'s `Data()` is its own bytes, mapped into the C memory (not copied): what the
 *   C++ stores there, JavaScript reads (string_decoder's state in its Buffer).
 *
 * A function of the API not implemented is a leaf that throws, naming it.
 */
import { execFileSync } from "node:child_process";
import type { createCMemory } from "./raise-c.js";

type Fn = (...a: unknown[]) => unknown;
type CMemory = ReturnType<typeof createCMemory>;

/** A context: its embedder data (node/src's tag, its Environment), as V8 keeps it. */
interface HostContext {
  readonly embedder: number[];
  readonly global: object;
}

interface Template {
  readonly callback: number;
  readonly data: unknown;
  fn?: (this: unknown, ...args: unknown[]) => unknown;
}

interface CallInfo {
  readonly args: readonly unknown[];
  readonly receiver: unknown;
  ret: unknown;
}

export interface V8Host {
  /** The leaves, by mangled name, for each of the names given (link's `extra`). */
  readonly leaves: Record<string, Fn>;
  /** The isolate (an address). */
  readonly isolate: number;
  /** The current context's handle. */
  readonly context: number;
  /** A value's handle. */
  handle(v: unknown): number;
  /** A handle's value. */
  value(h: number): unknown;
  /** A Local's record holding a value's handle, in the memory: its address (a record argument). */
  local(v: unknown): number;
  /** The names given that no leaf implements (demangled). */
  readonly unimplemented: readonly string[];
}

/** Demangled names, by c++filt. */
function demangle(names: readonly string[]): string[] {
  if (names.length === 0) return [];
  const out = execFileSync("c++filt", { input: names.join("\n"), encoding: "utf8" }).split("\n");
  return names.map((n, i) => out[i] ?? n);
}

export function createV8(memory: CMemory, names: readonly string[]): V8Host {
  const L = memory.leaves as unknown as Record<string, Fn>;
  const ld64 = (a: number): number => Number(L.__ykLoad64?.(a) as bigint);
  const st64 = (a: number, v: number | bigint): void => {
    L.__ykStore64?.(a, BigInt(v));
  };
  const ld8 = (a: number): number => Number(L.__ykLoad8?.(a));
  const st8 = (a: number, v: number): void => {
    L.__ykStore8?.(a, v);
  };
  const st32 = (a: number, v: number): void => {
    L.__ykStore32?.(a, v | 0);
  };
  const alloc = (n: number, align = 8): number => Number(L.__ykAlloc?.(n, align));

  const values: unknown[] = [undefined]; // handle 0: empty
  const handle = (v: unknown): number => {
    values.push(v);
    return values.length - 1;
  };
  const value = (h: number): unknown => {
    if (h === 0) throw new Error("V8: an empty handle used");
    return values[h];
  };
  const local = (v: unknown): number => {
    const a = alloc(8);
    st64(a, handle(v));
    return a;
  };
  /** A Local's value, from its record's address. */
  const at = (addr: number): unknown => value(ld64(addr));
  const put = (ret: number, v: unknown): void => st64(ret, handle(v));

  const isolate = alloc(64);
  const context: HostContext = { embedder: new Array(64).fill(0), global: globalThis };
  const contextHandle = handle(context);
  let pending: { error: unknown } | undefined;

  const infos = new Map<number, CallInfo>();
  let nextInfo = 1;
  const call = (tpl: Template, receiver: unknown, args: readonly unknown[]): unknown => {
    const id = nextInfo++;
    const info: CallInfo = { args, receiver, ret: undefined };
    infos.set(id, info);
    const rec = alloc(24);
    st64(rec, id);
    try {
      (L.__ykFnAt?.(tpl.callback) as Fn)(rec);
    } finally {
      infos.delete(id);
      L.__ykFree?.(rec);
    }
    if (pending !== undefined) {
      const { error } = pending;
      pending = undefined;
      throw error;
    }
    return info.ret;
  };
  const infoOf = (rec: number): CallInfo => {
    const i = infos.get(ld64(rec));
    if (i === undefined) throw new Error("V8: a FunctionCallbackInfo out of its call");
    return i;
  };

  // An ArrayBuffer's bytes, mapped once.
  const mapped = new WeakMap<ArrayBufferLike, number>();
  const dataOf = (ab: ArrayBufferLike): number => {
    let a = mapped.get(ab);
    if (a === undefined) {
      a = memory.map(new Uint8Array(ab));
      mapped.set(ab, a);
    }
    return a;
  };
  const bytes = (addr: number, n: number): Uint8Array => memory.get(addr, n);
  const cString = (addr: number): Uint8Array => {
    let n = 0;
    while (ld8(addr + n) !== 0) n++;
    return bytes(addr, n);
  };
  const utf8 = new TextDecoder("utf-8");
  const enc = new TextEncoder();
  const bool = (b: boolean): number => (b ? 1 : 0);
  const view = (h: number): ArrayBufferView => value(h) as ArrayBufferView;

  /** By the demangled name (template arguments kept): its implementation. */
  const impl = (d: string, mangled: string): Fn | undefined => {
    // Handles: Local, MaybeLocal (an 8-byte handle record).
    if (/^v8::Local<[^>]*>::operator->\(\) const$/.test(d)) return (self) => ld64(self as number);
    if (/^v8::(?:Local|MaybeLocal)<.*>::(?:Local|MaybeLocal)\(\)$/.test(d))
      return (self) => st64(self as number, 0);
    if (/^v8::(?:Local|MaybeLocal)<.*>::(?:Local|MaybeLocal)<.*>\(v8::Local<.*>\)$/.test(d))
      return (self, src) => st64(self as number, ld64(src as number));
    if (/^v8::(?:Local|MaybeLocal)<.*>::operator=\(v8::(?:Local|MaybeLocal)<.*>&&\)$/.test(d))
      return (self, src) => {
        st64(self as number, ld64(src as number));
        return self;
      };
    if (/^v8::Local<.*> v8::Local<.*>::As<.*>\(\) const$/.test(d))
      return (ret, self) => st64(ret as number, ld64(self as number));
    if (
      /^v8::(?:MaybeLocal<.*>|api_internal::IndirectHandleBase)::IsEmpty\(\) const$/.test(d) ||
      /^v8::Local<.*>::IsEmpty\(\) const$/.test(d)
    )
      return (self) => bool(ld64(self as number) === 0);
    if (/^bool v8::MaybeLocal<.*>::ToLocal<.*>\(v8::Local<.*>\*\) const$/.test(d))
      return (self, out) => {
        const h = ld64(self as number);
        st64(out as number, h);
        return bool(h !== 0);
      };
    if (/^v8::MaybeLocal<.*>::ToLocalChecked\(\)$/.test(d))
      return (ret, self) => {
        const h = ld64(self as number);
        if (h === 0) throw new Error("V8: ToLocalChecked of an empty MaybeLocal");
        st64(ret as number, h);
      };
    if (/^v8::Local<.*> v8::MaybeLocal<.*>::FromMaybe<.*>\(v8::Local<.*>\) const$/.test(d))
      return (ret, self, dflt) => {
        const h = ld64(self as number);
        st64(ret as number, h !== 0 ? h : ld64(dflt as number));
      };
    if (d === "v8::api_internal::FromJustIsNothing()")
      return () => {
        throw new Error("V8: FromJust of Nothing");
      };
    // Maybe<T>: has_value_ at 0, the value after it (bool at 1, a 64-bit one at 8).
    if (d === "v8::Maybe<bool>::Check() const")
      return (self) => {
        if (ld8(self as number) === 0) throw new Error("V8: Check of Nothing");
      };
    if (/^v8::Maybe<.*>::IsJust\(\) const$/.test(d)) return (self) => ld8(self as number);
    if (/^v8::Maybe<.*>::IsNothing\(\) const$/.test(d))
      return (self) => bool(ld8(self as number) === 0);
    if (d === "v8::Maybe<bool>::FromJust() const")
      return (self) => {
        if (ld8(self as number) === 0) throw new Error("V8: FromJust of Nothing");
        return ld8((self as number) + 1);
      };
    if (d === "v8::Maybe<unsigned long>::To(unsigned long*) const")
      return (self, out) => {
        if (ld8(self as number) === 0) return 0;
        st64(out as number, L.__ykLoad64?.((self as number) + 8) as bigint);
        return 1;
      };
    if (/^_ZN2v84JustIm/.test(mangled))
      return (ret, ref) => {
        st8(ret as number, 1);
        st64((ret as number) + 8, L.__ykLoad64?.(ref as number) as bigint);
      };
    if (d === "v8::Maybe<unsigned long> v8::Nothing<unsigned long>()")
      return (ret) => st8(ret as number, 0);
    const just = (ret: number): void => {
      st8(ret, 1);
      st8(ret + 1, 1);
    };
    // The isolate and the context.
    if (d === "v8::Isolate::GetCurrentContext()")
      return (ret) => st64(ret as number, contextHandle);
    if (d === "v8::Isolate::TryGetCurrent()" || d === "v8::Isolate::GetCurrent()")
      return () => isolate;
    if (d === "v8::Isolate::InContext()") return () => 1;
    if (d === "v8::Isolate::LowMemoryNotification()") return () => undefined;
    if (d === "v8::Isolate::ThrowException(v8::Local<v8::Value>)")
      return (ret, _self, v) => {
        pending = { error: at(v as number) };
        st64(ret as number, handle(undefined));
      };
    if (d === "v8::Context::GetIsolate()") return () => isolate;
    if (d === "v8::Context::GetNumberOfEmbedderDataFields()")
      return (self) => (value(self as number) as HostContext).embedder.length;
    if (d === "v8::Context::GetAlignedPointerFromEmbedderData(int)")
      return (self, i) => (value(self as number) as HostContext).embedder[i as number] ?? 0;
    if (d === "v8::Context::SetAlignedPointerInEmbedderData(int, void*)")
      return (self, i, p) => {
        (value(self as number) as HostContext).embedder[i as number] = p as number;
      };
    if (
      d === "v8::HandleScope::HandleScope(v8::Isolate*)" ||
      d === "v8::HandleScope::~HandleScope()"
    )
      return () => undefined;
    // Values.
    if (d === "v8::Integer::New(v8::Isolate*, int)")
      return (ret, _i, n) => put(ret as number, n as number);
    if (d === "v8::Integer::NewFromUnsigned(v8::Isolate*, unsigned int)")
      return (ret, _i, n) => put(ret as number, (n as number) >>> 0);
    if (d === "v8::Number::New(v8::Isolate*, double)")
      return (ret, _i, n) => put(ret as number, n as number);
    if (d === "v8::Boolean::New(v8::Isolate*, bool)")
      return (ret, _i, b) => put(ret as number, b !== 0 && b !== false);
    if (d === "v8::Array::New(v8::Isolate*, int)")
      return (ret, _i, n) => put(ret as number, (n as number) > 0 ? new Array(n as number) : []);
    if (d === "v8::Object::New(v8::Isolate*)") return (ret) => put(ret as number, {});
    if (d === "v8::Object::Set(v8::Local<v8::Context>, v8::Local<v8::Value>, v8::Local<v8::Value>)")
      return (ret, self, _c, k, v) => {
        (value(self as number) as Record<PropertyKey, unknown>)[at(k as number) as PropertyKey] =
          at(v as number);
        just(ret as number);
      };
    if (d === "v8::Object::Set(v8::Local<v8::Context>, unsigned int, v8::Local<v8::Value>)")
      return (ret, self, _c, i, v) => {
        (value(self as number) as unknown[])[(i as number) >>> 0] = at(v as number);
        just(ret as number);
      };
    if (d === "v8::Value::IsArrayBufferView() const")
      return (self) => bool(ArrayBuffer.isView(value(self as number)));
    if (d === "v8::Value::IsString() const")
      return (self) => bool(typeof value(self as number) === "string");
    if (d === "v8::Value::IsUint8Array() const")
      return (self) => bool(value(self as number) instanceof Uint8Array);
    if (d === "v8::Value::ToObject(v8::Local<v8::Context>) const")
      return (ret, self) => put(ret as number, Object(value(self as number)));
    if (d === "v8::Value::ToString(v8::Local<v8::Context>) const")
      return (ret, self) => put(ret as number, String(value(self as number)));
    if (d === "v8::Exception::Error(v8::Local<v8::String>, v8::Local<v8::Value>)")
      return (ret, msg) => put(ret as number, new Error(at(msg as number) as string));
    // Strings.
    if (d === "v8::String::Empty(v8::Isolate*)") return (ret) => put(ret as number, "");
    if (d === "v8::String::Length() const")
      return (self) => (value(self as number) as string).length;
    if (d === "v8::String::Concat(v8::Isolate*, v8::Local<v8::String>, v8::Local<v8::String>)")
      return (ret, _i, a, b) =>
        put(ret as number, (at(a as number) as string) + (at(b as number) as string));
    if (d === "v8::String::NewFromUtf8(v8::Isolate*, char const*, v8::NewStringType, int)")
      return (ret, _i, p, _t, n) =>
        put(
          ret as number,
          utf8.decode((n as number) < 0 ? cString(p as number) : bytes(p as number, n as number)),
        );
    if (
      d === "v8::String::NewFromOneByte(v8::Isolate*, unsigned char const*, v8::NewStringType, int)"
    )
      return (ret, _i, p, _t, n) => {
        const b = (n as number) < 0 ? cString(p as number) : bytes(p as number, n as number);
        let s = "";
        for (const x of b) s += String.fromCharCode(x);
        put(ret as number, s);
      };
    if (
      d ===
      "v8::String::NewFromTwoByte(v8::Isolate*, unsigned short const*, v8::NewStringType, int)"
    )
      return (ret, _i, p, _t, n) => {
        let len = n as number;
        if (len < 0)
          for (len = 0; (Number(L.__ykLoad16?.((p as number) + 2 * len)) & 0xffff) !== 0; len++);
        const b = bytes(p as number, 2 * len);
        let s = "";
        for (let i = 0; i < len; i++)
          s += String.fromCharCode((b[2 * i] as number) | ((b[2 * i + 1] as number) << 8));
        put(ret as number, s);
      };
    if (d === "v8::String::WriteUtf8(v8::Isolate*, char*, int, int*, int) const")
      // (V8's: whole characters only, as many as fit; a terminating NUL unless the options say
      // NO_NULL_TERMINATION (2) or it does not fit; the bytes written, the NUL counted.)
      return (self, _i, buf, cap, nchars, options) => {
        const s = value(self as number) as string;
        const limit = (cap as number) < 0 ? Number.POSITIVE_INFINITY : (cap as number);
        let w = 0;
        let chars = 0;
        for (const ch of s) {
          const e = enc.encode(ch);
          if (w + e.length > limit) break;
          e.forEach((x, j) => st8((buf as number) + w + j, x));
          w += e.length;
          chars += ch.length;
        }
        if (((options as number) & 2) === 0 && w < limit && chars === s.length) {
          st8((buf as number) + w, 0);
          w++;
        }
        if ((nchars as number) !== 0) st32(nchars as number, chars);
        return w;
      };
    // Array buffers and their views.
    if (d === "v8::ArrayBuffer::Data() const")
      return (self) => dataOf(value(self as number) as ArrayBufferLike);
    if (d === "v8::ArrayBuffer::ByteLength() const")
      return (self) => BigInt((value(self as number) as ArrayBufferLike).byteLength);
    if (d === "v8::ArrayBufferView::Buffer()")
      return (ret, self) => put(ret as number, view(self as number).buffer);
    if (d === "v8::ArrayBufferView::ByteLength()")
      return (self) => BigInt(view(self as number).byteLength);
    if (d === "v8::ArrayBufferView::ByteOffset()")
      return (self) => BigInt(view(self as number).byteOffset);
    if (d === "v8::ArrayBufferView::HasBuffer() const") return () => 1;
    if (d === "v8::ArrayBufferView::CopyContents(void*, unsigned long)")
      return (self, dest, n) => {
        const v = view(self as number);
        const m = Math.min(Number(n as bigint), v.byteLength);
        const src = new Uint8Array(v.buffer, v.byteOffset, m);
        src.forEach((x, j) => st8((dest as number) + j, x));
        return BigInt(m);
      };
    // Functions: a template's function calls its callback with a FunctionCallbackInfo.
    if (d.startsWith("v8::FunctionTemplate::New(v8::Isolate*, void (*)(v8::FunctionCallbackInfo"))
      return (ret, _i, cb, data) => {
        const h = ld64(data as number);
        put(ret as number, { callback: cb as number, data: h === 0 ? undefined : value(h) });
      };
    if (d === "v8::FunctionTemplate::GetFunction(v8::Local<v8::Context>)")
      return (ret, self) => {
        const tpl = value(self as number) as Template;
        tpl.fn ??= function (this: unknown, ...args: unknown[]) {
          return call(tpl, this, args);
        };
        put(ret as number, tpl.fn);
      };
    if (d === "v8::Function::SetName(v8::Local<v8::String>)")
      return (self, n) => {
        Object.defineProperty(value(self as number) as object, "name", {
          value: at(n as number),
          configurable: true,
        });
      };
    if (d === "v8::FunctionCallbackInfo<v8::Value>::GetIsolate() const") return () => isolate;
    if (d === "v8::FunctionCallbackInfo<v8::Value>::Length() const")
      return (self) => infoOf(self as number).args.length;
    if (d === "v8::FunctionCallbackInfo<v8::Value>::operator[](int) const")
      return (ret, self, i) => put(ret as number, infoOf(self as number).args[i as number]);
    if (d === "v8::FunctionCallbackInfo<v8::Value>::This() const")
      return (ret, self) => put(ret as number, infoOf(self as number).receiver);
    if (d === "v8::FunctionCallbackInfo<v8::Value>::GetReturnValue() const")
      return (ret, self) => st64(ret as number, ld64(self as number));
    if (/^void v8::ReturnValue<v8::Value>::Set<.*>\(v8::Local<.*>\)$/.test(d))
      return (self, v) => {
        const i = infos.get(ld64(self as number));
        if (i !== undefined) i.ret = at(v as number);
      };
    if (
      d === "v8::ReturnValue<v8::Value>::Set(int)" ||
      d === "v8::ReturnValue<v8::Value>::Set(double)"
    )
      return (self, n) => {
        const i = infos.get(ld64(self as number));
        if (i !== undefined) i.ret = n;
      };
    if (d === "v8::ReturnValue<v8::Value>::Set(bool)")
      return (self, b) => {
        const i = infos.get(ld64(self as number));
        if (i !== undefined) i.ret = b !== 0 && b !== false;
      };
    return undefined;
  };

  const leaves: Record<string, Fn> = {};
  const unimplemented: string[] = [];
  const demangled = demangle(names);
  names.forEach((m, i) => {
    const d = demangled[i] as string;
    const f = impl(d, m);
    if (f !== undefined) leaves[m] = f;
    else {
      unimplemented.push(d);
      leaves[m] = () => {
        throw new Error(`V8's API: ${d} is not implemented`);
      };
    }
  });
  return {
    leaves,
    isolate,
    context: contextHandle,
    handle,
    value,
    local,
    unimplemented,
  };
}
