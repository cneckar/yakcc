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

// Integer results (#1369): a rotate's result is an int32 whatever it is given, and a record's keys
// are when its values are.
export function rot(w: number, s: number): number {
  return (w << (32 - s)) | (w >>> s);
}
export function step(a: number, b: number): { a: number; b: number } {
  const s = (a + b) | 0;
  return { a: s, b: rot(s ^ b, 7) };
}

// An export named as an Object.prototype member: an import of it is this function (#1370).
// biome-ignore lint/suspicious/noShadowRestrictedNames: the name is what is tested (#1370)
export function valueOf(x: number): number {
  return x * 2;
}
