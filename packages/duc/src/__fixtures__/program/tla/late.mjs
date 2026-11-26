// A module import() loads that awaits: the import() resolves after its evaluation.
import { order } from "./own.mjs";

order.push("late start");
await new Promise((r) => queueMicrotask(r));
export const z = "late done";
order.push("late end");
