// Functions whose result is an object literal of distinct named keys (#1369): a caller that only
// reads its keys takes the values without the object being made.
export function split(x: number): { hi: number; lo: number } {
  return { hi: Math.floor(x / 65536), lo: x % 65536 };
}

let calls = 0;
export function mix(a: unknown, b: unknown, tag: string) {
  calls++;
  const sum = typeof a === "number" && typeof b === "number" ? a + b : `${a}${b}`;
  return { sum, tag, n: calls, greet: () => `hi ${tag}` };
}
export function callCount(): number {
  return calls;
}
