// A module with no await of its own that imports one that awaits: it runs after it.
import { order, x } from "./own.mjs";

order.push(`mid sees ${x}`);
export const y = x + 10;
