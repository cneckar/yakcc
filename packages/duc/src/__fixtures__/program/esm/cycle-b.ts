import { even } from "./cycle-a.js";
export function odd(k: number): boolean {
  return k === 0 ? false : even(k - 1);
}
