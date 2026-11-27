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

  const stores = new Map<number, ArrayBuffer>();
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

  /** A leaf whose record result is made in the slot given first: it returns the slot, as the
   * raised code's callees do. */
  const R =
    (f: Fn): Fn =>
    (...a) => {
      f(...a);
      return a[0];
    };
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
      return R((ret, self) => st64(ret as number, ld64(self as number)));
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
      return R((ret, self) => {
        const h = ld64(self as number);
        if (h === 0) throw new Error("V8: ToLocalChecked of an empty MaybeLocal");
        st64(ret as number, h);
      });
    if (/^v8::Local<.*> v8::MaybeLocal<.*>::FromMaybe<.*>\(v8::Local<.*>\) const$/.test(d))
      return R((ret, self, dflt) => {
        const h = ld64(self as number);
        st64(ret as number, h !== 0 ? h : ld64(dflt as number));
      });
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
      return R((ret, ref) => {
        st8(ret as number, 1);
        st64((ret as number) + 8, L.__ykLoad64?.(ref as number) as bigint);
      });
    if (d === "v8::Maybe<unsigned long> v8::Nothing<unsigned long>()")
      return R((ret) => st8(ret as number, 0));
    const just = (ret: number): void => {
      st8(ret, 1);
      st8(ret + 1, 1);
    };
    // The isolate and the context.
    if (d === "v8::Isolate::GetCurrentContext()")
      return R((ret) => st64(ret as number, contextHandle));
    if (d === "v8::Isolate::TryGetCurrent()" || d === "v8::Isolate::GetCurrent()")
      return () => isolate;
    if (d === "v8::Isolate::InContext()") return () => 1;
    if (d === "v8::Isolate::LowMemoryNotification()") return () => undefined;
    if (d === "v8::Isolate::ThrowException(v8::Local<v8::Value>)")
      return R((ret, _self, v) => {
        pending = { error: at(v as number) };
        st64(ret as number, handle(undefined));
      });
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
      [
        "v8::HandleScope::HandleScope(v8::Isolate*)",
        "v8::HandleScope::~HandleScope()",
        "v8::EscapableHandleScope::EscapableHandleScope(v8::Isolate*)",
        "v8::EscapableHandleScope::~EscapableHandleScope()",
        "v8::EscapableHandleScopeBase::~EscapableHandleScopeBase()",
      ].includes(d)
    )
      return () => undefined;
    if (/^v8::Local<.*> v8::EscapableHandleScope::Escape<.*>\(v8::Local<.*>\)$/.test(d))
      return R((ret, _self, v) => st64(ret as number, ld64(v as number)));
    if (
      /^v8::MaybeLocal<.*> v8::EscapableHandleScope::EscapeMaybe<.*>\(v8::MaybeLocal<.*>\)$/.test(d)
    )
      return R((ret, _self, v) => st64(ret as number, ld64(v as number)));
    if (d === "v8::Isolate::AdjustAmountOfExternalAllocatedMemory(long)") return () => 0n;
    // Values.
    if (d === "v8::Integer::New(v8::Isolate*, int)")
      return R((ret, _i, n) => put(ret as number, n as number));
    if (d === "v8::Integer::NewFromUnsigned(v8::Isolate*, unsigned int)")
      return R((ret, _i, n) => put(ret as number, (n as number) >>> 0));
    if (d === "v8::Number::New(v8::Isolate*, double)")
      return R((ret, _i, n) => put(ret as number, n as number));
    if (d === "v8::Boolean::New(v8::Isolate*, bool)")
      return R((ret, _i, b) => put(ret as number, b !== 0 && b !== false));
    if (d === "v8::Array::New(v8::Isolate*, int)")
      return R((ret, _i, n) => put(ret as number, (n as number) > 0 ? new Array(n as number) : []));
    if (d === "v8::Object::New(v8::Isolate*)") return R((ret) => put(ret as number, {}));
    if (d === "v8::Object::Set(v8::Local<v8::Context>, v8::Local<v8::Value>, v8::Local<v8::Value>)")
      return R((ret, self, _c, k, v) => {
        (value(self as number) as Record<PropertyKey, unknown>)[at(k as number) as PropertyKey] =
          at(v as number);
        just(ret as number);
      });
    if (d === "v8::Object::Set(v8::Local<v8::Context>, unsigned int, v8::Local<v8::Value>)")
      return R((ret, self, _c, i, v) => {
        (value(self as number) as unknown[])[(i as number) >>> 0] = at(v as number);
        just(ret as number);
      });
    if (d === "v8::Value::IsArrayBufferView() const")
      return (self) => bool(ArrayBuffer.isView(value(self as number)));
    if (d === "v8::Value::IsString() const")
      return (self) => bool(typeof value(self as number) === "string");
    if (d === "v8::Value::IsUint8Array() const")
      return (self) => bool(value(self as number) instanceof Uint8Array);
    if (d === "v8::Value::ToObject(v8::Local<v8::Context>) const")
      return R((ret, self) => put(ret as number, Object(value(self as number))));
    if (d === "v8::Value::ToString(v8::Local<v8::Context>) const")
      return R((ret, self) => put(ret as number, String(value(self as number))));
    if (d === "v8::Exception::Error(v8::Local<v8::String>, v8::Local<v8::Value>)")
      return R((ret, msg) => put(ret as number, new Error(at(msg as number) as string)));
    // Predicates and numbers (V8's: IsInt32 of an integer in range, not -0).
    const pred: Record<string, (v: unknown) => boolean> = {
      "v8::Value::IsUndefined() const": (v) => v === undefined,
      "v8::Value::IsNull() const": (v) => v === null,
      "v8::Value::IsBoolean() const": (v) => typeof v === "boolean",
      "v8::Value::IsTrue() const": (v) => v === true,
      "v8::Value::IsFalse() const": (v) => v === false,
      "v8::Value::IsNumber() const": (v) => typeof v === "number",
      "v8::Value::IsInt32() const": (v) =>
        typeof v === "number" && Number.isInteger(v) && v === (v | 0) && !Object.is(v, -0),
      "v8::Value::IsUint32() const": (v) =>
        typeof v === "number" && Number.isInteger(v) && v === v >>> 0 && !Object.is(v, -0),
      "v8::Value::IsObject() const": (v) =>
        (typeof v === "object" && v !== null) || typeof v === "function",
      "v8::Value::IsFunction() const": (v) => typeof v === "function",
      "v8::Value::IsArray() const": (v) => Array.isArray(v),
      "v8::Value::IsArrayBuffer() const": (v) => v instanceof ArrayBuffer,
      "v8::Value::IsSharedArrayBuffer() const": (v) =>
        typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer,
      "v8::Value::IsTypedArray() const": (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
      "v8::Value::IsDataView() const": (v) => v instanceof DataView,
      "v8::Value::IsBigInt() const": (v) => typeof v === "bigint",
    };
    const p0 = pred[d];
    if (p0 !== undefined) return (self) => bool(p0(value(self as number)));
    if (d === "v8::Int32::Value() const") return (self) => (value(self as number) as number) | 0;
    if (d === "v8::Uint32::Value() const") return (self) => (value(self as number) as number) >>> 0;
    if (d === "v8::Integer::Value() const")
      return (self) => BigInt(Math.trunc(value(self as number) as number));
    if (d === "v8::Number::Value() const") return (self) => value(self as number) as number;
    // ToInteger, ToUint32, as Maybe<int64_t> (its value at 8) and Maybe<uint32_t> (at 4).
    if (d === "v8::Value::IntegerValue(v8::Local<v8::Context>) const")
      return R((ret, self) => {
        const n = Number(value(self as number));
        st8(ret as number, 1);
        L.__ykStore64?.(
          (ret as number) + 8,
          BigInt.asIntN(
            64,
            BigInt(
              Number.isFinite(n)
                ? Math.trunc(n)
                : Number.isNaN(n)
                  ? 0
                  : n > 0
                    ? 2 ** 63 - 1
                    : -(2 ** 63),
            ),
          ),
        );
      });
    if (d === "v8::Value::Uint32Value(v8::Local<v8::Context>) const")
      return R((ret, self) => {
        st8(ret as number, 1);
        st32((ret as number) + 4, Number(value(self as number)) >>> 0);
      });
    if (d === "v8::Value::Int32Value(v8::Local<v8::Context>) const")
      return R((ret, self) => {
        st8(ret as number, 1);
        st32((ret as number) + 4, Number(value(self as number)) | 0);
      });
    if (d === "v8::Value::NumberValue(v8::Local<v8::Context>) const")
      return R((ret, self) => {
        st8(ret as number, 1);
        L.__ykStoreF64?.((ret as number) + 8, Number(value(self as number)));
      });
    if (d === "v8::Maybe<long>::To(long*) const")
      return (self, out) => {
        if (ld8(self as number) === 0) return 0;
        L.__ykStore64?.(out as number, L.__ykLoad64?.((self as number) + 8));
        return 1;
      };
    if (
      d === "v8::Maybe<unsigned int>::To(unsigned int*) const" ||
      d === "v8::Maybe<int>::To(int*) const"
    )
      return (self, out) => {
        if (ld8(self as number) === 0) return 0;
        st32(out as number, Number(L.__ykLoad32?.((self as number) + 4)));
        return 1;
      };
    if (d === "v8::Maybe<bool> v8::Nothing<bool>()") return R((ret) => st8(ret as number, 0));
    if (/^_ZN2v84JustIb/.test(mangled))
      return R((ret, ref) => {
        st8(ret as number, 1);
        st8((ret as number) + 1, ld8(ref as number));
      });
    if (d === "v8::Exception::RangeError(v8::Local<v8::String>, v8::Local<v8::Value>)")
      return R((ret, msg) => put(ret as number, new RangeError(at(msg as number) as string)));
    if (d === "v8::Exception::TypeError(v8::Local<v8::String>, v8::Local<v8::Value>)")
      return R((ret, msg) => put(ret as number, new TypeError(at(msg as number) as string)));
    if (d === "v8::ReturnValue<v8::Value>::Set(unsigned int)")
      return (self, n) => {
        const i = infos.get(ld64(self as number));
        if (i !== undefined) i.ret = (n as number) >>> 0;
      };
    if (d === "v8::ReturnValue<v8::Value>::SetEmptyString()")
      return (self) => {
        const i = infos.get(ld64(self as number));
        if (i !== undefined) i.ret = "";
      };
    if (
      d === "v8::ReturnValue<v8::Value>::SetUndefined()" ||
      d === "v8::ReturnValue<v8::Value>::SetNull()"
    )
      return (self) => {
        const i = infos.get(ld64(self as number));
        if (i !== undefined) i.ret = d.endsWith("SetNull()") ? null : undefined;
      };
    // String::Utf8Value and String::Value: V8's objects, a pointer to their characters (NUL
    // after them) at 0 and their length at 8; their destructor frees them.
    if (d === "v8::String::Utf8Value::Utf8Value(v8::Isolate*, v8::Local<v8::Value>)")
      return (self, _i, v) => {
        const b = enc.encode(String(at(v as number)));
        const a = alloc(b.length + 1, 1);
        b.forEach((x, j) => st8(a + j, x));
        st8(a + b.length, 0);
        st64(self as number, a);
        st32((self as number) + 8, b.length);
      };
    if (d === "v8::String::Value::Value(v8::Isolate*, v8::Local<v8::Value>)")
      return (self, _i, v) => {
        const t = String(at(v as number));
        const a = alloc(2 * t.length + 2, 2);
        for (let j = 0; j <= t.length; j++)
          L.__ykStore16?.(a + 2 * j, j < t.length ? t.charCodeAt(j) : 0);
        st64(self as number, a);
        st32((self as number) + 8, t.length);
      };
    if (d === "v8::String::Utf8Value::operator*()" || d === "v8::String::Value::operator*()")
      return (self) => ld64(self as number);
    if (d === "v8::String::Utf8Value::length() const" || d === "v8::String::Value::length() const")
      return (self) => Number(L.__ykLoad32?.((self as number) + 8)) | 0;
    if (d === "v8::String::Utf8Value::~Utf8Value()" || d === "v8::String::Value::~Value()")
      return (self) => {
        const a = ld64(self as number);
        if (a !== 0) L.__ykFree?.(a);
      };
    // The primitives (`v8::Null(isolate)`) and a property defined with V8's attributes (ReadOnly
    // 1, DontEnum 2, DontDelete 4), as Object.defineProperty does.
    const primitive: Record<string, unknown> = {
      "v8::Null(v8::Isolate*)": null,
      "v8::Undefined(v8::Isolate*)": undefined,
      "v8::True(v8::Isolate*)": true,
      "v8::False(v8::Isolate*)": false,
    };
    if (Object.hasOwn(primitive, d)) return R((ret) => put(ret as number, primitive[d]));
    if (
      d ===
      "v8::Object::DefineOwnProperty(v8::Local<v8::Context>, v8::Local<v8::Name>, v8::Local<v8::Value>, v8::PropertyAttribute)"
    )
      return R((ret, self, _c, k, v, attrs) => {
        const a = attrs as number;
        Object.defineProperty(value(self as number) as object, at(k as number) as PropertyKey, {
          value: at(v as number),
          writable: (a & 1) === 0,
          enumerable: (a & 2) === 0,
          configurable: (a & 4) === 0,
        });
        just(ret as number);
      });
    if (d === "v8::String::NewFromUtf8Literal(v8::Isolate*, char const*, v8::NewStringType, int)")
      return R((ret, _i, p, _t, n) =>
        put(ret as number, utf8.decode(bytes(p as number, n as number))),
      );
    // Strings.
    if (d === "v8::String::Empty(v8::Isolate*)") return R((ret) => put(ret as number, ""));
    if (d === "v8::String::Length() const")
      return (self) => (value(self as number) as string).length;
    if (d === "v8::String::Concat(v8::Isolate*, v8::Local<v8::String>, v8::Local<v8::String>)")
      return R((ret, _i, a, b) =>
        put(ret as number, (at(a as number) as string) + (at(b as number) as string)),
      );
    if (d === "v8::String::NewFromUtf8(v8::Isolate*, char const*, v8::NewStringType, int)")
      return R((ret, _i, p, _t, n) =>
        put(
          ret as number,
          utf8.decode((n as number) < 0 ? cString(p as number) : bytes(p as number, n as number)),
        ),
      );
    if (
      d === "v8::String::NewFromOneByte(v8::Isolate*, unsigned char const*, v8::NewStringType, int)"
    )
      return R((ret, _i, p, _t, n) => {
        const b = (n as number) < 0 ? cString(p as number) : bytes(p as number, n as number);
        let s = "";
        for (const x of b) s += String.fromCharCode(x);
        put(ret as number, s);
      });
    if (
      d ===
      "v8::String::NewFromTwoByte(v8::Isolate*, unsigned short const*, v8::NewStringType, int)"
    )
      return R((ret, _i, p, _t, n) => {
        let len = n as number;
        if (len < 0)
          for (len = 0; (Number(L.__ykLoad16?.((p as number) + 2 * len)) & 0xffff) !== 0; len++);
        const b = bytes(p as number, 2 * len);
        let s = "";
        for (let i = 0; i < len; i++)
          s += String.fromCharCode((b[2 * i] as number) | ((b[2 * i + 1] as number) << 8));
        put(ret as number, s);
      });
    // (V8's: an unpaired surrogate is three bytes, as WriteUtf8 writes its replacement.)
    if (d === "v8::String::Utf8Length(v8::Isolate*) const")
      return (self) => {
        const t = value(self as number) as string;
        let n = 0;
        for (let j = 0; j < t.length; j++) {
          const c = t.charCodeAt(j);
          if (c < 0x80) n += 1;
          else if (c < 0x800) n += 2;
          else if (
            c >= 0xd800 &&
            c < 0xdc00 &&
            j + 1 < t.length &&
            (t.charCodeAt(j + 1) & 0xfc00) === 0xdc00
          ) {
            n += 4;
            j++;
          } else n += 3;
        }
        return n;
      };
    if (d === "v8::String::IsOneByte() const" || d === "v8::String::ContainsOnlyOneByte() const")
      return (self) => {
        const t = value(self as number) as string;
        for (let j = 0; j < t.length; j++) if (t.charCodeAt(j) > 0xff) return 0;
        return 1;
      };
    if (d === "v8::String::IsExternalOneByte() const" || d === "v8::String::IsExternal() const")
      return () => 0;
    if (d === "v8::String::GetExternalOneByteStringResource() const") return () => 0;
    // Write and WriteOneByte (V8's): the units from `start`, `length` of them or to the end; a
    // NUL after them unless NO_NULL_TERMINATION (2), when `length` leaves room; the count.
    if (
      d === "v8::String::Write(v8::Isolate*, unsigned short*, int, int, int) const" ||
      d === "v8::String::WriteOneByte(v8::Isolate*, unsigned char*, int, int, int) const"
    ) {
      const wide = d.startsWith("v8::String::Write(");
      return (self, _i, buf, start, length, options) => {
        const t = value(self as number) as string;
        const from = Math.max(0, Math.min(start as number, t.length));
        const end =
          (length as number) < 0 ? t.length : Math.min(t.length, from + (length as number));
        for (let j = from; j < end; j++) {
          const c = t.charCodeAt(j);
          if (wide) L.__ykStore16?.((buf as number) + 2 * (j - from), c);
          else st8((buf as number) + (j - from), c & 0xff);
        }
        const n = end - from;
        if (((options as number) & 2) === 0 && ((length as number) < 0 || n < (length as number))) {
          if (wide) L.__ykStore16?.((buf as number) + 2 * n, 0);
          else st8((buf as number) + n, 0);
        }
        return n;
      };
    }
    // External strings' resources, as node/src's ExternString derives them: V8's part of them
    // does nothing here (the strings themselves are the runtime's).
    if (
      /^v8::String::External(?:OneByte)?StringResource(?:Base)?::~?External(?:OneByte)?StringResource(?:Base)?\(\)$/.test(
        d,
      ) ||
      /^v8::String::ExternalStringResourceBase::(?:Dispose|Lock|Unlock)\(\)(?: const)?$/.test(d)
    )
      return () => undefined;
    if (d === "v8::String::ExternalStringResourceBase::IsCacheable() const") return () => 1;
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
      return R((ret, self) => put(ret as number, view(self as number).buffer));
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
    // Backing stores (Node's Buffer::New): a store is an address naming a fresh ArrayBuffer, its
    // Data() the buffer's bytes; a std::unique_ptr or std::shared_ptr of one holds it first.
    if (d === "v8::ArrayBuffer::New(v8::Isolate*, unsigned long)")
      return R((ret, _i, n) => put(ret as number, new ArrayBuffer(Number(n as bigint))));
    if (d === "v8::ArrayBuffer::WasDetached() const")
      return (self) => bool((value(self as number) as { detached?: boolean }).detached === true);
    if (d === "v8::SharedArrayBuffer::Data() const")
      return (self) => dataOf(value(self as number) as ArrayBufferLike);
    if (d === "v8::SharedArrayBuffer::ByteLength() const")
      return (self) => BigInt((value(self as number) as ArrayBufferLike).byteLength);
    if (d === "v8::ArrayBuffer::NewBackingStoreForNodeLTS(v8::Isolate*, unsigned long)")
      return R((ret, _i, n) => {
        const bs = alloc(16);
        stores.set(bs, new ArrayBuffer(Number(n as bigint)));
        st64(ret as number, bs);
      });
    if (d === "v8::ArrayBuffer::NewBackingStore(v8::Isolate*, unsigned long)")
      return R((ret, _i, n) => {
        const bs = alloc(16);
        stores.set(bs, new ArrayBuffer(Number(n as bigint)));
        st64(ret as number, bs);
      });
    if (d === "v8::BackingStore::Data() const")
      return (self) => dataOf(stores.get(self as number) as ArrayBuffer);
    if (d === "v8::BackingStore::ByteLength() const")
      return (self) => BigInt((stores.get(self as number) as ArrayBuffer).byteLength);
    if (d === "v8::BackingStore::~BackingStore()") return () => undefined;
    if (d === "v8::ArrayBuffer::New(v8::Isolate*, std::shared_ptr<v8::BackingStore>)")
      return R((ret, _i, sp) => put(ret as number, stores.get(ld64(sp as number))));
    if (d === "v8::Uint8Array::New(v8::Local<v8::ArrayBuffer>, unsigned long, unsigned long)")
      return R((ret, ab, off, n) =>
        put(
          ret as number,
          new Uint8Array(
            at(ab as number) as ArrayBuffer,
            Number(off as bigint),
            Number(n as bigint),
          ),
        ),
      );
    if (d === "v8::Object::SetPrototype(v8::Local<v8::Context>, v8::Local<v8::Value>)")
      return R((ret, self, _c, proto) => {
        Object.setPrototypeOf(value(self as number) as object, at(proto as number) as object);
        just(ret as number);
      });
    // Functions: a template's function calls its callback with a FunctionCallbackInfo.
    if (d.startsWith("v8::FunctionTemplate::New(v8::Isolate*, void (*)(v8::FunctionCallbackInfo"))
      return R((ret, _i, cb, data) => {
        const h = ld64(data as number);
        put(ret as number, { callback: cb as number, data: h === 0 ? undefined : value(h) });
      });
    if (d === "v8::FunctionTemplate::GetFunction(v8::Local<v8::Context>)")
      return R((ret, self) => {
        const tpl = value(self as number) as Template;
        tpl.fn ??= function (this: unknown, ...args: unknown[]) {
          return call(tpl, this, args);
        };
        put(ret as number, tpl.fn);
      });
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
      return R((ret, self, i) => put(ret as number, infoOf(self as number).args[i as number]));
    if (d === "v8::FunctionCallbackInfo<v8::Value>::This() const")
      return R((ret, self) => put(ret as number, infoOf(self as number).receiver));
    if (d === "v8::FunctionCallbackInfo<v8::Value>::GetReturnValue() const")
      return R((ret, self) => st64(ret as number, ld64(self as number)));
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
