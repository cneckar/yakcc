import { log } from "./order-a.js";
log.push("b");
export function doubled(x: number): number {
  return x * 2;
}
export { log };
