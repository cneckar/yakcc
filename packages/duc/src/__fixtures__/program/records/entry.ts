// Record results (#1369): keys read, the result kept whole, a method among the values, numbers and
// not, in a loop, and a function only called before its module's bindings are evaluated.
// biome-ignore lint/suspicious/noShadowRestrictedNames: the name is what is tested (#1370)
import { callCount, mix, rot, split, step, valueOf } from "./lib.js";

export function sums(k: number): unknown {
  let acc = 0;
  for (let i = 0; i < k; i++) {
    const { hi, lo } = split(i * 40503 + k);
    acc = (acc + hi * 3 + lo) % 1000003;
  }
  return acc;
}

export function mixed(a: unknown, b: unknown): unknown {
  const r = mix(a, b, "x");
  const kept = mix(b, a, "y");
  const g = mix(a, a, "z").greet();
  return [
    r.sum,
    r.tag,
    r.n,
    kept.sum,
    Object.keys(kept),
    g,
    mix.name,
    mix(1, 2, "w").sum,
    callCount(),
  ];
}

// A loop carried from its parameters (int32 carries that may start from a uint32, or from anything
// else), through a record result's integer keys and a rotate's.
export function hashLoop(seed: unknown, n: number): unknown {
  let x = seed as number;
  let y = (seed as number) >>> 0;
  for (let i = 0; i < n; i++) {
    ({ a: x, b: y } = step(x, y));
    x = rot(x, 3) ^ i;
  }
  return [x, y];
}

// Calls whose arguments are not proven: each checked where the call is (an integer clone's, or
// the function's own).
export function stepAll(values: unknown[]): unknown {
  const out: unknown[] = [];
  for (let i = 0; i + 1 < values.length; i++) {
    const r = step(values[i] as number, values[i + 1] as number);
    out.push(r.a, r.b, rot(values[i] as number, 5));
  }
  return out;
}

// A method's loop calling a function with the words it reads (a hash's rounds, #1370): numbers
// when it runs, so the number clone, tested for at the call; anything else, the function itself.
class Rounds {
  readonly words: unknown[];
  constructor(words: unknown[]) {
    this.words = words;
  }
  run(shift: unknown): unknown[] {
    const out: unknown[] = [];
    for (let i = 0; i < this.words.length; i++)
      out.push(rot(this.words[i] as number, shift as number), rot(i, 7));
    return out;
  }
}
export function rounds(words: unknown[], shift: unknown): unknown {
  return new Rounds(words).run(shift);
}

// A DataView's every get and set, both byte orders, and a member that is none of them.
export function views(seed: number): unknown {
  const dv = new DataView(new ArrayBuffer(16));
  const out: unknown[] = [];
  const kinds = ["Int8", "Uint8", "Int16", "Uint16", "Int32", "Uint32", "Float32", "Float64"];
  for (const k of kinds)
    for (const little of [false, true]) {
      (dv as unknown as Record<string, (o: number, v: number, l: boolean) => void>)[`set${k}`]?.(
        1,
        seed * 1000.75 - 3,
        little,
      );
      out.push(
        (dv as unknown as Record<string, (o: number, l: boolean) => number>)[`get${k}`]?.(
          1,
          little,
        ),
        dv.getUint8(1),
      );
    }
  dv.setBigInt64(8, BigInt(seed) - 5n, true);
  out.push(String(dv.getBigInt64(8, true)), String(dv.getBigUint64(8)));
  out.push(typeof (dv as unknown as Record<string, unknown>).getUint64);
  try {
    dv.getUint32(14);
  } catch (e) {
    out.push((e as Error).name);
  }
  return out;
}

export function named(x: number): unknown {
  // biome-ignore lint/suspicious/noShadowRestrictedNames: the name is what is tested (#1370)
  const toString = (y: number) => `#${y}`;
  return [valueOf(x), toString(x), typeof valueOf];
}
