import { odd } from "./cycle-b.js";
export function even(k: number): boolean {
  return k === 0 ? true : odd(k - 1);
}
