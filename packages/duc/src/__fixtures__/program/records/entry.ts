// Record results (#1369): keys read, the result kept whole, a method among the values, numbers and
// not, in a loop, and a function only called before its module's bindings are evaluated.
import { callCount, mix, split } from "./lib.js";

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
