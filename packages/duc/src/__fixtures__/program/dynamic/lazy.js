// A module only import() loads: evaluated when the import's job runs (#1370).
import { order } from "./log.js";

order.push("lazy evaluated");
export const value = 7;
export function twice(x) {
  return x * 2;
}
