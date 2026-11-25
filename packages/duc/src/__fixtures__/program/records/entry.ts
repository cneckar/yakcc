// Record results (#1369): keys read, the result kept whole, a method among the values, numbers and
// not, in a loop, and a function only called before its module's bindings are evaluated.
import { callCount, mix, rot, split, step } from "./lib.js";

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
